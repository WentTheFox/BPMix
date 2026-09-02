#pragma once

#include "pch.h"

#include <NativeModules.h>

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <xaudio2.h>

#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Storage.AccessCache.h>
#include <winrt/Windows.Storage.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <fstream>
#include <limits>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <vector>

// A from-scratch real (not stubbed) Windows audio engine: Media Foundation
// (IMFSourceReader) decodes files to float32 PCM, XAudio2 plays them back.
// There is no Web-Audio-style API on Windows, so this only approximates
// the AudioEngine/SourceNode contract the Android (react-native-audio-api)
// and Web (Web Audio API) adapters get for free:
//  - gain/rate changes are applied immediately via SetVolume/
//    SetFrequencyRatio; rampGain/rampRate approximate a linear ramp with a
//    background thread stepping the value every ~20ms rather than XAudio2
//    having any real AudioParam-style automation.
//  - scheduleStart's "whenSeconds" in the future is approximated with a
//    background sleep + Start(), not a sample-accurate scheduled start.
// Good enough to actually hear music and verify crossfade-adjacent logic
// end to end; not a sample-accurate reimplementation of the other
// platforms' engines.

namespace BPMix {

namespace {

using namespace winrt::Microsoft::ReactNative;
using namespace winrt::Windows::Security::Cryptography;
using namespace winrt::Windows::Storage;
using namespace winrt::Windows::Storage::AccessCache;
using namespace winrt::Windows::Storage::Streams;

// Temporary diagnostic logging while getting real playback working - writes
// to the app's own local-data folder (a plain filesystem path once
// resolved, no picker/capability needed, unlike arbitrary user folders).
void DebugLog(std::string const &message) {
  try {
    auto folder = winrt::Windows::Storage::ApplicationData::Current().LocalFolder();
    std::wstring path = std::wstring(folder.Path()) + L"\\audio-debug.log";
    std::ofstream file(path, std::ios::app);
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    file << ms << " " << message << std::endl;
  } catch (...) {
  }
}

struct DecodedBuffer {
  std::vector<float> interleaved;
  uint32_t sampleRate = 0;
  uint32_t numberOfChannels = 0;
};

IXAudio2 *g_xaudio2 = nullptr;
IXAudio2MasteringVoice *g_masteringVoice = nullptr;
std::once_flag g_engineInitFlag;
std::chrono::steady_clock::time_point g_engineEpoch;

void EnsureEngineInitialized() {
  std::call_once(g_engineInitFlag, [] {
    try {
      winrt::check_hresult(MFStartup(MF_VERSION));
      DebugLog("MFStartup OK");
      winrt::check_hresult(XAudio2Create(&g_xaudio2, 0, XAUDIO2_DEFAULT_PROCESSOR));
      DebugLog("XAudio2Create OK");
      winrt::check_hresult(g_xaudio2->CreateMasteringVoice(&g_masteringVoice));
      XAUDIO2_VOICE_DETAILS details = {};
      g_masteringVoice->GetVoiceDetails(&details);
      DebugLog("CreateMasteringVoice OK channels=" + std::to_string(details.InputChannels)
          + " sampleRate=" + std::to_string(details.InputSampleRate));
      g_engineEpoch = std::chrono::steady_clock::now();
    } catch (winrt::hresult_error const &e) {
      DebugLog("EnsureEngineInitialized FAILED: " + winrt::to_string(e.message()));
    } catch (...) {
      DebugLog("EnsureEngineInitialized FAILED: unknown exception");
    }
  });
}

double EngineNowSeconds() {
  EnsureEngineInitialized();
  return std::chrono::duration<double>(std::chrono::steady_clock::now() - g_engineEpoch).count();
}

std::mutex g_buffersMutex;
std::unordered_map<std::string, std::shared_ptr<DecodedBuffer>> g_buffers;

// Fires OnStreamEnd (posted to JS via a std::function set at construction)
// when a submitted buffer finishes playing naturally - backs SourceNode's
// optional onEnded callback. All other callback methods are unused.
class VoiceCallback : public IXAudio2VoiceCallback {
 public:
  std::function<void()> onStreamEnd;

  void STDMETHODCALLTYPE OnVoiceProcessingPassStart(UINT32) override {}
  void STDMETHODCALLTYPE OnVoiceProcessingPassEnd() override {}
  void STDMETHODCALLTYPE OnStreamEnd() override {
    if (onStreamEnd) {
      onStreamEnd();
    }
  }
  void STDMETHODCALLTYPE OnBufferStart(void *) override {}
  void STDMETHODCALLTYPE OnBufferEnd(void *) override {}
  void STDMETHODCALLTYPE OnLoopEnd(void *) override {}
  void STDMETHODCALLTYPE OnVoiceError(void *, HRESULT) override {}
};

struct SourceState {
  IXAudio2SourceVoice *voice = nullptr;
  std::shared_ptr<DecodedBuffer> buffer;
  std::unique_ptr<VoiceCallback> callback;
  std::atomic<bool> stopped{false};
};

std::mutex g_sourcesMutex;
std::unordered_map<std::string, std::shared_ptr<SourceState>> g_sources;

// Resolves a FileAccessModule-style "<futureAccessListToken>|<relativePath>"
// id to a real filesystem path, since Media Foundation needs a path/URL,
// not a WinRT StorageFile handle.
winrt::Windows::Foundation::IAsyncOperation<winrt::hstring> ResolveFilePath(std::string fileId) {
  auto sep = fileId.find('|');
  std::string rootId = sep == std::string::npos ? fileId : fileId.substr(0, sep);
  std::string relativePath = sep == std::string::npos ? "" : fileId.substr(sep + 1);

  auto root = co_await StorageApplicationPermissions::FutureAccessList().GetFolderAsync(winrt::to_hstring(rootId));

  std::vector<std::string> segments;
  std::stringstream ss(relativePath);
  std::string segment;
  while (std::getline(ss, segment, '/')) {
    if (!segment.empty()) {
      segments.push_back(segment);
    }
  }
  if (segments.empty()) {
    co_return winrt::hstring{};
  }
  std::string fileName = segments.back();
  segments.pop_back();

  auto current = root;
  for (auto const &s : segments) {
    current = co_await current.GetFolderAsync(winrt::to_hstring(s));
  }
  auto file = co_await current.GetFileAsync(winrt::to_hstring(fileName));
  co_return file.Path();
}

std::shared_ptr<DecodedBuffer> DecodeToFloatPcm(winrt::hstring const &path) {
  winrt::com_ptr<IMFSourceReader> reader;
  winrt::check_hresult(MFCreateSourceReaderFromURL(path.c_str(), nullptr, reader.put()));

  winrt::com_ptr<IMFMediaType> partialType;
  winrt::check_hresult(MFCreateMediaType(partialType.put()));
  winrt::check_hresult(partialType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio));
  winrt::check_hresult(partialType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_Float));
  winrt::check_hresult(
      reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr, partialType.get()));

  winrt::com_ptr<IMFMediaType> actualType;
  winrt::check_hresult(reader->GetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, actualType.put()));

  UINT32 sampleRate = 0;
  UINT32 channels = 0;
  winrt::check_hresult(actualType->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &sampleRate));
  winrt::check_hresult(actualType->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &channels));

  auto decoded = std::make_shared<DecodedBuffer>();
  decoded->sampleRate = sampleRate;
  decoded->numberOfChannels = channels;

  while (true) {
    DWORD flags = 0;
    LONGLONG timestamp = 0;
    winrt::com_ptr<IMFSample> sample;
    winrt::check_hresult(
        reader->ReadSample(MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0, nullptr, &flags, &timestamp, sample.put()));

    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) {
      break;
    }
    if (!sample) {
      continue;
    }

    winrt::com_ptr<IMFMediaBuffer> buffer;
    winrt::check_hresult(sample->ConvertToContiguousBuffer(buffer.put()));

    BYTE *data = nullptr;
    DWORD length = 0;
    winrt::check_hresult(buffer->Lock(&data, nullptr, &length));
    size_t floatCount = length / sizeof(float);
    auto floatData = reinterpret_cast<float *>(data);
    decoded->interleaved.insert(decoded->interleaved.end(), floatData, floatData + floatCount);
    winrt::check_hresult(buffer->Unlock());
  }

  return decoded;
}

std::string GenerateId(char const *prefix) {
  static std::atomic<uint64_t> counter{0};
  return std::string(prefix) + "-" + std::to_string(counter.fetch_add(1));
}

// Native port of packages/core/src/analysis/{mono,silence,bpm,loudness}.ts +
// analyzeTrack.ts's orchestration - see those files for the algorithm docs
// (kept in sync by hand; there is no code sharing between the two languages).
// Exists only because running this same analysis in JS on Windows visibly
// stutters the UI thread - RNW's old-bridge architecture blocks UI
// responsiveness on JS work, unlike Android/Web's genuinely separate JS/UI
// threads. Runs against the already-decoded interleaved buffer directly, on
// a background thread, so it never touches the JS thread at all.
namespace analysis {

constexpr double kAnalysisWindowSeconds = 30.0;
constexpr double kSilenceAmplitudeThreshold = 0.0056;
constexpr double kSilenceWindowSeconds = 0.02;
constexpr double kMinBpm = 60.0;
constexpr double kMaxBpm = 200.0;
constexpr uint32_t kEnvelopeWindowSamples = 1024;
constexpr uint32_t kEnvelopeHopSamples = 512;
constexpr double kReferenceLoudnessDb = -18.0;
constexpr double kMinGain = 0.25;
constexpr double kMaxGain = 4.0;
constexpr double kSilenceFloorDb = -80.0;

struct WindowAnalysisResult {
  double bpm = 0;
  double bpmConfidence = 0;
  double beatAnchorSeconds = 0;
};

struct TrackAnalysisResult {
  WindowAnalysisResult startWindow;
  WindowAnalysisResult endWindow;
  double normalizationGain = 1.0;
};

std::vector<float> MixToMono(DecodedBuffer const &buffer) {
  uint32_t channels = buffer.numberOfChannels > 0 ? buffer.numberOfChannels : 1;
  size_t frameCount = buffer.interleaved.size() / channels;
  std::vector<float> mono(frameCount, 0.0f);
  for (size_t frame = 0; frame < frameCount; frame++) {
    float sum = 0.0f;
    for (uint32_t ch = 0; ch < channels; ch++) {
      sum += buffer.interleaved[frame * channels + ch];
    }
    mono[frame] = sum / static_cast<float>(channels);
  }
  return mono;
}

double WindowRms(float const *samples, size_t length, size_t startSample, size_t windowLength) {
  size_t end = std::min(startSample + windowLength, length);
  if (end <= startSample) return 0.0;
  double sumSquares = 0.0;
  for (size_t i = startSample; i < end; i++) {
    double sample = samples[i];
    sumSquares += sample * sample;
  }
  return std::sqrt(sumSquares / static_cast<double>(end - startSample));
}

struct ContentBounds {
  size_t startSample = 0;
  size_t endSample = 0;
};

ContentBounds FindContentBounds(float const *mono, size_t totalSamples, uint32_t sampleRate) {
  size_t windowLength = std::max<size_t>(1, static_cast<size_t>(std::lround(kSilenceWindowSeconds * sampleRate)));

  size_t startSample = 0;
  bool foundStart = false;
  for (size_t i = 0; i < totalSamples; i += windowLength) {
    if (WindowRms(mono, totalSamples, i, windowLength) >= kSilenceAmplitudeThreshold) {
      startSample = i;
      foundStart = true;
      break;
    }
  }
  if (!foundStart) {
    return { 0, totalSamples };
  }

  size_t endSample = totalSamples;
  bool foundEnd = false;
  for (size_t i = totalSamples > windowLength ? totalSamples - windowLength : 0;; ) {
    if (i + windowLength <= startSample) break;
    if (WindowRms(mono, totalSamples, i, windowLength) >= kSilenceAmplitudeThreshold) {
      endSample = i + windowLength;
      foundEnd = true;
      break;
    }
    if (i == 0) break;
    i = i > windowLength ? i - windowLength : 0;
  }
  if (!foundEnd) {
    endSample = startSample;
  }

  if (startSample >= endSample) {
    return { 0, totalSamples };
  }
  return { startSample, std::min(endSample, totalSamples) };
}

std::vector<float> ComputeEnergyEnvelope(float const *samples, size_t length) {
  if (length < kEnvelopeWindowSamples) return {};
  size_t frameCount = (length - kEnvelopeWindowSamples) / kEnvelopeHopSamples + 1;
  std::vector<float> envelope(frameCount, 0.0f);
  for (size_t frame = 0; frame < frameCount; frame++) {
    size_t start = frame * kEnvelopeHopSamples;
    double sumSquares = 0.0;
    for (size_t i = 0; i < kEnvelopeWindowSamples; i++) {
      double sample = samples[start + i];
      sumSquares += sample * sample;
    }
    envelope[frame] = static_cast<float>(sumSquares / kEnvelopeWindowSamples);
  }
  return envelope;
}

std::vector<float> OnsetStrength(std::vector<float> const &envelope) {
  std::vector<float> onset(envelope.size(), 0.0f);
  for (size_t i = 1; i < envelope.size(); i++) {
    onset[i] = std::max(0.0f, envelope[i] - envelope[i - 1]);
  }
  return onset;
}

double AutocorrelateAtLag(std::vector<float> const &signal, double mean, size_t lag) {
  if (lag >= signal.size()) return 0.0;
  size_t n = signal.size() - lag;
  double sum = 0.0;
  for (size_t i = 0; i < n; i++) {
    sum += (static_cast<double>(signal[i]) - mean) * (static_cast<double>(signal[i + lag]) - mean);
  }
  return sum;
}

size_t FindBestPhase(std::vector<float> const &onset, size_t period) {
  size_t bestPhase = 0;
  double bestSum = -std::numeric_limits<double>::infinity();
  for (size_t phase = 0; phase < period; phase++) {
    double sum = 0.0;
    for (size_t i = phase; i < onset.size(); i += period) {
      sum += onset[i];
    }
    if (sum > bestSum) {
      bestSum = sum;
      bestPhase = phase;
    }
  }
  return bestPhase;
}

// Returns bpm/confidence plus (via the out param) the raw best-phase offset
// in seconds, since the caller needs it combined with the window's absolute
// position (analyzeTrack.ts's firstBeatOffsetSeconds), not just bpm/confidence.
WindowAnalysisResult EstimateBpmWithPhase(float const *samples, size_t length, uint32_t sampleRate, double *outFirstBeatOffsetSeconds) {
  auto envelope = ComputeEnergyEnvelope(samples, length);
  auto onset = OnsetStrength(envelope);
  double envelopeRate = static_cast<double>(sampleRate) / kEnvelopeHopSamples;

  size_t minLag = std::max<size_t>(1, static_cast<size_t>(std::lround((envelopeRate * 60.0) / kMaxBpm)));
  size_t maxLag = onset.empty() ? 0 : std::min<size_t>(onset.size() - 1,
      static_cast<size_t>(std::lround((envelopeRate * 60.0) / kMinBpm)));

  if (outFirstBeatOffsetSeconds) *outFirstBeatOffsetSeconds = 0;

  if (onset.empty() || minLag >= maxLag) {
    return {};
  }

  double mean = 0.0;
  for (float value : onset) mean += value;
  mean /= static_cast<double>(onset.size());

  double zeroLagEnergy = AutocorrelateAtLag(onset, mean, 0);
  if (zeroLagEnergy <= 0.0) {
    return {};
  }

  size_t bestLag = minLag;
  double bestValue = -std::numeric_limits<double>::infinity();
  for (size_t lag = minLag; lag <= maxLag; lag++) {
    double value = AutocorrelateAtLag(onset, mean, lag);
    if (value > bestValue) {
      bestValue = value;
      bestLag = lag;
    }
  }

  WindowAnalysisResult result;
  result.bpm = (envelopeRate * 60.0) / static_cast<double>(bestLag);
  result.bpmConfidence = std::min(1.0, std::max(0.0, bestValue / zeroLagEnergy));

  size_t bestPhase = FindBestPhase(onset, bestLag);
  if (outFirstBeatOffsetSeconds) {
    *outFirstBeatOffsetSeconds = static_cast<double>(bestPhase * kEnvelopeHopSamples) / sampleRate;
  }
  return result;
}

double MeasureLoudnessDb(float const *samples, size_t length) {
  if (length == 0) return kSilenceFloorDb;
  double sumSquares = 0.0;
  for (size_t i = 0; i < length; i++) {
    double sample = samples[i];
    sumSquares += sample * sample;
  }
  double rms = std::sqrt(sumSquares / static_cast<double>(length));
  if (rms <= 0.0) return kSilenceFloorDb;
  return std::max(kSilenceFloorDb, 20.0 * std::log10(rms));
}

double ComputeNormalizationGain(double loudnessDb) {
  double gainDb = kReferenceLoudnessDb - loudnessDb;
  double gain = std::pow(10.0, gainDb / 20.0);
  return std::min(kMaxGain, std::max(kMinGain, gain));
}

TrackAnalysisResult AnalyzeBuffer(DecodedBuffer const &buffer) {
  uint32_t sampleRate = buffer.sampleRate > 0 ? buffer.sampleRate : 1;

  // A mono source needs no downmix - borrow its buffer directly rather than
  // copying, since monoOwned staying empty is exactly the "borrowed" case.
  std::vector<float> monoOwned;
  float const *monoData;
  size_t monoLength;
  if (buffer.numberOfChannels == 1) {
    monoData = buffer.interleaved.data();
    monoLength = buffer.interleaved.size();
  } else {
    monoOwned = MixToMono(buffer);
    monoData = monoOwned.data();
    monoLength = monoOwned.size();
  }

  auto bounds = FindContentBounds(monoData, monoLength, sampleRate);
  size_t startSample = bounds.startSample;
  size_t endSample = bounds.endSample;

  size_t windowSamples = static_cast<size_t>(std::lround(kAnalysisWindowSeconds * sampleRate));
  size_t firstWindowEnd = std::min(startSample + windowSamples, endSample);
  size_t lastWindowStart = endSample > windowSamples && endSample - windowSamples > startSample
      ? endSample - windowSamples
      : startSample;

  double firstBeatOffset = 0;
  double lastBeatOffset = 0;
  WindowAnalysisResult firstEstimate =
      EstimateBpmWithPhase(monoData + startSample, firstWindowEnd - startSample, sampleRate, &firstBeatOffset);
  WindowAnalysisResult lastEstimate =
      EstimateBpmWithPhase(monoData + lastWindowStart, endSample - lastWindowStart, sampleRate, &lastBeatOffset);

  TrackAnalysisResult result;
  result.startWindow.bpm = firstEstimate.bpm;
  result.startWindow.bpmConfidence = firstEstimate.bpmConfidence;
  result.startWindow.beatAnchorSeconds = static_cast<double>(startSample) / sampleRate + firstBeatOffset;
  result.endWindow.bpm = lastEstimate.bpm;
  result.endWindow.bpmConfidence = lastEstimate.bpmConfidence;
  result.endWindow.beatAnchorSeconds = static_cast<double>(lastWindowStart) / sampleRate + lastBeatOffset;

  // Loudness pooled over both windows (deduping the overlap on a short
  // track), matching analyzeTrack.ts.
  double loudnessDb;
  if (lastWindowStart <= firstWindowEnd) {
    loudnessDb = MeasureLoudnessDb(monoData + startSample, endSample - startSample);
  } else {
    size_t firstLen = firstWindowEnd - startSample;
    size_t lastLen = endSample - lastWindowStart;
    std::vector<float> pooled(firstLen + lastLen);
    std::copy(monoData + startSample, monoData + firstWindowEnd, pooled.begin());
    std::copy(monoData + lastWindowStart, monoData + endSample, pooled.begin() + firstLen);
    loudnessDb = MeasureLoudnessDb(pooled.data(), pooled.size());
  }
  result.normalizationGain = ComputeNormalizationGain(loudnessDb);

  return result;
}

} // namespace analysis

} // namespace

REACT_MODULE(AudioEngineModule, L"BPMixAudioEngine")
struct AudioEngineModule {
  REACT_SYNC_METHOD(Now, L"now")
  double Now() noexcept {
    return EngineNowSeconds();
  }

  // Temporary diagnostic: lets JS write timing checkpoints into the same
  // append-based native log used elsewhere here, to see exactly where a
  // slow operation's time actually goes without fighting Metro's buffered
  // terminal output.
  REACT_SYNC_METHOD(LogFromJs, L"logFromJs")
  bool LogFromJs(std::string message) noexcept {
    DebugLog("[JS] " + message);
    return true;
  }

  // Fast path: decodes and native-caches the buffer (needed for playback,
  // which never reads channelData - it plays from this cache via
  // nativeBufferId) without paying for the channelData transfer at all.
  // Split out from the old DecodeFile specifically so playback can start
  // right after this resolves instead of waiting on GetChannelData too -
  // that transfer alone was measured taking several extra seconds on a
  // multi-minute track, entirely wasted if analysis is what's slow to
  // want it, not playback.
  REACT_METHOD(DecodeFileMetadata, L"decodeFileMetadata")
  winrt::fire_and_forget DecodeFileMetadata(std::string fileId, ReactPromise<JSValue> result) noexcept {
    try {
      EnsureEngineInitialized();
      auto path = co_await ResolveFilePath(fileId);
      if (path.empty()) {
        result.Reject("Could not resolve file path");
        co_return;
      }

      // DecodeToFloatPcm is a large, fully synchronous loop (Media
      // Foundation ReadSample called until EOF) with no yield points. If
      // this coroutine resumed on the UI thread (STA-apartment WinRT
      // continuations can do that), that loop would freeze the entire app
      // for as long as decode takes. Force onto a background thread first.
      co_await winrt::resume_background();

      auto decoded = DecodeToFloatPcm(path);
      DebugLog("DecodeFileMetadata decoded samples=" + std::to_string(decoded->interleaved.size())
          + " sampleRate=" + std::to_string(decoded->sampleRate)
          + " channels=" + std::to_string(decoded->numberOfChannels));
      auto bufferId = GenerateId("buf");
      {
        std::lock_guard<std::mutex> lock(g_buffersMutex);
        g_buffers[bufferId] = decoded;
      }

      uint32_t channels = decoded->numberOfChannels > 0 ? decoded->numberOfChannels : 1;
      uint32_t frameCount = static_cast<uint32_t>(decoded->interleaved.size() / channels);

      JSValueObject obj;
      obj["nativeBufferId"] = bufferId;
      obj["sampleRate"] = static_cast<double>(decoded->sampleRate);
      obj["numberOfChannels"] = static_cast<double>(channels);
      obj["frameCount"] = static_cast<double>(frameCount);
      obj["durationSeconds"] = decoded->sampleRate > 0
          ? static_cast<double>(frameCount) / static_cast<double>(decoded->sampleRate)
          : 0.0;
      result.Resolve(JSValue(std::move(obj)));
    } catch (winrt::hresult_error const &e) {
      result.Reject(winrt::to_string(e.message()).c_str());
    } catch (...) {
      result.Reject("Failed to decode file");
    }
  }

  // Slow path: pulls channelData (as plain number arrays - see the
  // decodeFileMetadata comment on why not base64) out of an *already
  // decoded and cached* buffer, for analysis. No re-decode - just the
  // array-building/transfer cost, run separately so it never blocks
  // playback start.
  REACT_METHOD(GetChannelData, L"getChannelData")
  winrt::fire_and_forget GetChannelData(std::string nativeBufferId, ReactPromise<JSValue> result) noexcept {
    try {
      std::shared_ptr<DecodedBuffer> decoded;
      {
        std::lock_guard<std::mutex> lock(g_buffersMutex);
        auto it = g_buffers.find(nativeBufferId);
        if (it == g_buffers.end()) {
          result.Reject("Unknown nativeBufferId");
          co_return;
        }
        decoded = it->second;
      }

      co_await winrt::resume_background();

      uint32_t channels = decoded->numberOfChannels > 0 ? decoded->numberOfChannels : 1;
      uint32_t frameCount = static_cast<uint32_t>(decoded->interleaved.size() / channels);

      DebugLog("GetChannelData building arrays, frameCount=" + std::to_string(frameCount));
      JSValueArray channelDataArrays;
      for (uint32_t ch = 0; ch < channels; ch++) {
        JSValueArray channelSamples;
        channelSamples.reserve(frameCount);
        for (uint32_t i = 0; i < frameCount; i++) {
          channelSamples.push_back(JSValue(static_cast<double>(decoded->interleaved[i * channels + ch])));
        }
        channelDataArrays.push_back(JSValue(std::move(channelSamples)));
      }
      DebugLog("GetChannelData arrays built");

      result.Resolve(JSValue(std::move(channelDataArrays)));
    } catch (winrt::hresult_error const &e) {
      result.Reject(winrt::to_string(e.message()).c_str());
    } catch (...) {
      result.Reject("Failed to get channel data");
    }
  }

  // BPM/loudness analysis run entirely in native code against the cached
  // buffer - see the `analysis` namespace above for why (JS-side analysis
  // visibly stutters the RNW UI thread). Never touches channelData/the JS
  // thread at all; the only bridge traffic is this small result object.
  REACT_METHOD(AnalyzeBuffer, L"analyzeBuffer")
  winrt::fire_and_forget AnalyzeBuffer(std::string nativeBufferId, ReactPromise<JSValue> result) noexcept {
    try {
      std::shared_ptr<DecodedBuffer> decoded;
      {
        std::lock_guard<std::mutex> lock(g_buffersMutex);
        auto it = g_buffers.find(nativeBufferId);
        if (it == g_buffers.end()) {
          result.Reject("Unknown nativeBufferId");
          co_return;
        }
        decoded = it->second;
      }

      co_await winrt::resume_background();

      auto trackAnalysis = analysis::AnalyzeBuffer(*decoded);
      DebugLog("AnalyzeBuffer done startBpm=" + std::to_string(trackAnalysis.startWindow.bpm)
          + " endBpm=" + std::to_string(trackAnalysis.endWindow.bpm)
          + " gain=" + std::to_string(trackAnalysis.normalizationGain));

      auto windowToJs = [](analysis::WindowAnalysisResult const &w) {
        JSValueObject obj;
        obj["bpm"] = w.bpm;
        obj["bpmConfidence"] = w.bpmConfidence;
        obj["beatAnchorSeconds"] = w.beatAnchorSeconds;
        return obj;
      };

      JSValueObject obj;
      obj["startWindow"] = windowToJs(trackAnalysis.startWindow);
      obj["endWindow"] = windowToJs(trackAnalysis.endWindow);
      obj["normalizationGain"] = trackAnalysis.normalizationGain;
      result.Resolve(JSValue(std::move(obj)));
    } catch (winrt::hresult_error const &e) {
      result.Reject(winrt::to_string(e.message()).c_str());
    } catch (...) {
      result.Reject("Failed to analyze buffer");
    }
  }

  REACT_METHOD(ReleaseBuffer, L"releaseBuffer")
  winrt::fire_and_forget ReleaseBuffer(std::string nativeBufferId, ReactPromise<void> result) noexcept {
    {
      std::lock_guard<std::mutex> lock(g_buffersMutex);
      g_buffers.erase(nativeBufferId);
    }
    result.Resolve();
    co_return;
  }

  REACT_SYNC_METHOD(CreateSource, L"createSource")
  std::string CreateSource(std::string nativeBufferId) noexcept {
    try {
      EnsureEngineInitialized();
      std::shared_ptr<DecodedBuffer> buffer;
      {
        std::lock_guard<std::mutex> lock(g_buffersMutex);
        auto it = g_buffers.find(nativeBufferId);
        if (it == g_buffers.end()) {
          return "";
        }
        buffer = it->second;
      }

      auto state = std::make_shared<SourceState>();
      state->buffer = buffer;
      state->callback = std::make_unique<VoiceCallback>();

      WAVEFORMATEX format = {};
      format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
      format.nChannels = static_cast<WORD>(buffer->numberOfChannels);
      format.nSamplesPerSec = buffer->sampleRate;
      format.wBitsPerSample = 32;
      format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
      format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

      IXAudio2SourceVoice *voice = nullptr;
      HRESULT hr = g_xaudio2->CreateSourceVoice(
          &voice, &format, 0, XAUDIO2_DEFAULT_FREQ_RATIO, state->callback.get());
      DebugLog("CreateSource hr=" + std::to_string(hr) + " channels=" + std::to_string(format.nChannels)
          + " sampleRate=" + std::to_string(format.nSamplesPerSec)
          + " blockAlign=" + std::to_string(format.nBlockAlign));
      winrt::check_hresult(hr);
      state->voice = voice;

      auto sourceId = GenerateId("src");
      {
        std::lock_guard<std::mutex> lock(g_sourcesMutex);
        g_sources[sourceId] = state;
      }
      return sourceId;
    } catch (winrt::hresult_error const &e) {
      DebugLog("CreateSource FAILED: " + winrt::to_string(e.message()));
      return "";
    } catch (...) {
      DebugLog("CreateSource FAILED: unknown exception");
      return "";
    }
  }

  REACT_EVENT(PlaybackEnded, L"playbackEnded")
  std::function<void(std::string)> PlaybackEnded;

  // NativeEventEmitter (JS side) expects these on any native module it
  // wraps; actual event delivery for REACT_EVENT doesn't go through them,
  // they just silence its "missing addListener/removeListeners" warning.
  REACT_METHOD(AddListener, L"addListener")
  void AddListener(std::string) noexcept {}

  REACT_METHOD(RemoveListeners, L"removeListeners")
  void RemoveListeners(double) noexcept {}

  REACT_SYNC_METHOD(ScheduleStart, L"scheduleStart")
  bool ScheduleStart(std::string sourceId, double whenSeconds, double offsetSeconds) noexcept {
    std::shared_ptr<SourceState> state;
    {
      std::lock_guard<std::mutex> lock(g_sourcesMutex);
      auto it = g_sources.find(sourceId);
      if (it == g_sources.end()) {
        return false;
      }
      state = it->second;
    }

    auto &buffer = *state->buffer;
    UINT32 offsetFrames = buffer.sampleRate > 0 && offsetSeconds > 0
        ? static_cast<UINT32>(offsetSeconds * buffer.sampleRate)
        : 0;

    XAUDIO2_BUFFER xbuf = {};
    xbuf.AudioBytes = static_cast<UINT32>(buffer.interleaved.size() * sizeof(float));
    xbuf.pAudioData = reinterpret_cast<const BYTE *>(buffer.interleaved.data());
    xbuf.PlayBegin = offsetFrames;
    xbuf.Flags = XAUDIO2_END_OF_STREAM;

    auto &callback = *state->callback;
    callback.onStreamEnd = [this, sourceId] {
      if (PlaybackEnded) {
        PlaybackEnded(sourceId);
      }
    };

    HRESULT submitHr = state->voice->SubmitSourceBuffer(&xbuf);
    DebugLog("ScheduleStart SubmitSourceBuffer hr=" + std::to_string(submitHr)
        + " audioBytes=" + std::to_string(xbuf.AudioBytes) + " playBegin=" + std::to_string(xbuf.PlayBegin));
    if (FAILED(submitHr)) {
      return false;
    }

    double delaySeconds = whenSeconds - EngineNowSeconds();
    DebugLog("ScheduleStart delaySeconds=" + std::to_string(delaySeconds));
    if (delaySeconds > 0.001) {
      auto voice = state->voice;
      auto stoppedFlag = &state->stopped;
      std::thread([voice, delaySeconds, stoppedFlag] {
        std::this_thread::sleep_for(std::chrono::duration<double>(delaySeconds));
        if (!stoppedFlag->load()) {
          HRESULT startHr = voice->Start();
          DebugLog("ScheduleStart (delayed) Start hr=" + std::to_string(startHr));
        }
      }).detach();
    } else {
      HRESULT startHr = state->voice->Start();
      DebugLog("ScheduleStart (immediate) Start hr=" + std::to_string(startHr));
    }
    return true;
  }

  REACT_SYNC_METHOD(SetGain, L"setGain")
  bool SetGain(std::string sourceId, double value) noexcept {
    auto state = FindSource(sourceId);
    if (!state) return false;
    DebugLog("SetGain sourceId=" + sourceId + " value=" + std::to_string(value));
    state->voice->SetVolume(static_cast<float>(value));
    return true;
  }

  REACT_SYNC_METHOD(SetRate, L"setRate")
  bool SetRate(std::string sourceId, double value) noexcept {
    auto state = FindSource(sourceId);
    if (!state) return false;
    state->voice->SetFrequencyRatio(static_cast<float>(value));
    return true;
  }

  // Best-effort linear ramp: XAudio2 has no AudioParam-style automation, so
  // this steps the value on a background thread every ~20ms. Not
  // sample-accurate; good enough to hear a fade rather than a jump.
  REACT_SYNC_METHOD(RampGain, L"rampGain")
  bool RampGain(std::string sourceId, double toValue, double atTimeSeconds, double durationSeconds) noexcept {
    return StartRamp(sourceId, toValue, atTimeSeconds, durationSeconds, /*isGain*/ true);
  }

  REACT_SYNC_METHOD(RampRate, L"rampRate")
  bool RampRate(std::string sourceId, double toValue, double atTimeSeconds, double durationSeconds) noexcept {
    return StartRamp(sourceId, toValue, atTimeSeconds, durationSeconds, /*isGain*/ false);
  }

  REACT_SYNC_METHOD(Stop, L"stop")
  bool Stop(std::string sourceId, double whenSeconds) noexcept {
    std::shared_ptr<SourceState> state;
    {
      std::lock_guard<std::mutex> lock(g_sourcesMutex);
      auto it = g_sources.find(sourceId);
      if (it == g_sources.end()) {
        return false;
      }
      state = it->second;
      g_sources.erase(it);
    }
    state->stopped.store(true);

    double delaySeconds = whenSeconds - EngineNowSeconds();
    auto voice = state->voice;
    auto doStop = [voice] {
      voice->Stop();
      voice->FlushSourceBuffers();
      voice->DestroyVoice();
    };
    if (delaySeconds > 0.001) {
      std::thread([doStop, delaySeconds] {
        std::this_thread::sleep_for(std::chrono::duration<double>(delaySeconds));
        doStop();
      }).detach();
    } else {
      doStop();
    }
    return true;
  }

 private:
  std::shared_ptr<SourceState> FindSource(std::string const &sourceId) noexcept {
    std::lock_guard<std::mutex> lock(g_sourcesMutex);
    auto it = g_sources.find(sourceId);
    return it == g_sources.end() ? nullptr : it->second;
  }

  bool StartRamp(std::string const &sourceId, double toValue, double atTimeSeconds, double durationSeconds,
      bool isGain) noexcept {
    auto state = FindSource(sourceId);
    if (!state) return false;

    auto voice = state->voice;
    auto stoppedFlag = &state->stopped;
    std::thread([voice, toValue, atTimeSeconds, durationSeconds, isGain, stoppedFlag] {
      double startDelay = atTimeSeconds - EngineNowSeconds();
      if (startDelay > 0) {
        std::this_thread::sleep_for(std::chrono::duration<double>(startDelay));
      }
      if (stoppedFlag->load()) return;

      float fromValue = 0.0f;
      if (isGain) {
        voice->GetVolume(&fromValue);
      } else {
        voice->GetFrequencyRatio(&fromValue);
      }

      constexpr double stepSeconds = 0.02;
      int steps = std::max(1, static_cast<int>(durationSeconds / stepSeconds));
      for (int i = 1; i <= steps; i++) {
        if (stoppedFlag->load()) return;
        float t = static_cast<float>(i) / static_cast<float>(steps);
        float value = fromValue + (static_cast<float>(toValue) - fromValue) * t;
        if (isGain) {
          voice->SetVolume(value);
        } else {
          voice->SetFrequencyRatio(value);
        }
        if (i < steps) {
          std::this_thread::sleep_for(std::chrono::duration<double>(durationSeconds / steps));
        }
      }
    }).detach();
    return true;
  }
};

} // namespace BPMix
