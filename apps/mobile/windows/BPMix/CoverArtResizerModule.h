#pragma once

#include "pch.h"

#include <NativeModules.h>

#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Storage.Streams.h>

#include <algorithm>

// Downscales embedded cover art via WinRT's built-in BitmapDecoder/
// BitmapTransform/BitmapEncoder (Windows Imaging Component under the
// hood) - no third-party dependency needed, unlike Android's
// @bam.tech/react-native-image-resizer (which has no Windows
// implementation to begin with; same story as every other third-party RN
// native module this project has hit - see FileAccessModule.h's header
// comment). Bytes cross the JS<->native bridge as base64 text, same
// convention as FileAccessModule's ReadFileBytesBase64 - the JS-side
// wrapper (coverArtResizer.windows.ts) handles encoding the input and
// decoding the output.

namespace BPMix {

REACT_MODULE(CoverArtResizerModule, L"BPMixCoverArtResizer")
struct CoverArtResizerModule {
  REACT_METHOD(ResizeImage, L"resizeImage")
  winrt::fire_and_forget ResizeImage(
      std::string base64Data,
      double maxDimensionPx,
      ReactPromise<winrt::Microsoft::ReactNative::JSValue> result) noexcept {
    using namespace winrt::Microsoft::ReactNative;
    using namespace winrt::Windows::Graphics::Imaging;
    using namespace winrt::Windows::Security::Cryptography;
    using namespace winrt::Windows::Storage::Streams;
    try {
      auto inputBuffer = CryptographicBuffer::DecodeFromBase64String(winrt::to_hstring(base64Data));

      InMemoryRandomAccessStream inputStream;
      co_await inputStream.WriteAsync(inputBuffer);
      inputStream.Seek(0);

      auto decoder = co_await BitmapDecoder::CreateAsync(inputStream);
      uint32_t originalWidth = decoder.PixelWidth();
      uint32_t originalHeight = decoder.PixelHeight();
      auto limit = static_cast<uint32_t>(maxDimensionPx);

      if (originalWidth <= limit && originalHeight <= limit) {
        result.Resolve(JSValue()); // already small enough - matches CoverArtResizer's "no resize needed" contract
        co_return;
      }

      double scale = static_cast<double>(limit) / static_cast<double>(std::max(originalWidth, originalHeight));
      uint32_t newWidth = std::max<uint32_t>(1, static_cast<uint32_t>(originalWidth * scale));
      uint32_t newHeight = std::max<uint32_t>(1, static_cast<uint32_t>(originalHeight * scale));

      auto softwareBitmap = co_await decoder.GetSoftwareBitmapAsync();

      InMemoryRandomAccessStream outputStream;
      auto encoder = co_await BitmapEncoder::CreateAsync(BitmapEncoder::JpegEncoderId(), outputStream);
      encoder.SetSoftwareBitmap(softwareBitmap);
      encoder.BitmapTransform().ScaledWidth(newWidth);
      encoder.BitmapTransform().ScaledHeight(newHeight);
      encoder.BitmapTransform().InterpolationMode(BitmapInterpolationMode::Fant);
      co_await encoder.FlushAsync();

      outputStream.Seek(0);
      Buffer outputBuffer(static_cast<uint32_t>(outputStream.Size()));
      co_await outputStream.ReadAsync(outputBuffer, outputBuffer.Capacity(), InputStreamOptions::None);
      auto base64Out = CryptographicBuffer::EncodeToBase64String(outputBuffer);

      JSValueObject obj;
      obj["mimeType"] = "image/jpeg";
      obj["base64"] = winrt::to_string(base64Out);
      result.Resolve(JSValue(std::move(obj)));
    } catch (...) {
      // Undecodable/unencodable - caller (coverArtResizer.windows.ts) falls back to the raw bytes / size cutoff.
      result.Resolve(winrt::Microsoft::ReactNative::JSValue());
    }
  }
};

} // namespace BPMix
