#pragma once

#include "pch.h"

#include <NativeModules.h>

#include <shobjidl.h>

#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Storage.AccessCache.h>
#include <winrt/Windows.Storage.FileProperties.h>
#include <winrt/Windows.Storage.Pickers.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.Storage.h>

#include <algorithm>
#include <mutex>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

// PLACEHOLDER-GRADE, but real: a from-scratch Windows equivalent of the
// Android adapter's react-native-scoped-storage usage. There is no
// maintained folder-picker/file-access library for the current
// react-native-windows C++/WinRT template (existing npm packages target the
// old UWP C#/.NET46 project layout and won't autolink here), so this talks
// to WinRT's StorageFolder/FutureAccessList APIs directly. FileRef.id is
// encoded as "<futureAccessListToken>|<relativePath>" so every method can
// resolve back to a real StorageFolder/StorageFile without extra JS-side
// state (unlike the Android adapter, which has to cache SAF child URIs
// because those are opaque).

// Defined in BPMix.cpp, captured once on the UI thread at startup.
extern HWND BPMix_MainWindowHwnd;

namespace BPMix {

namespace {

using namespace winrt::Microsoft::ReactNative;
using namespace winrt::Windows::Foundation;
using namespace winrt::Windows::Foundation::Collections;
using namespace winrt::Windows::Security::Cryptography;
using namespace winrt::Windows::Storage;
using namespace winrt::Windows::Storage::AccessCache;
using namespace winrt::Windows::Storage::Pickers;
using namespace winrt::Windows::Storage::Streams;

inline std::vector<std::string> SplitPath(std::string const &path) {
  std::vector<std::string> segments;
  std::stringstream ss(path);
  std::string segment;
  while (std::getline(ss, segment, '/')) {
    if (!segment.empty()) {
      segments.push_back(segment);
    }
  }
  return segments;
}

inline IAsyncOperation<StorageFolder> ResolveFolder(StorageFolder root, std::string relativePath) {
  auto current = root;
  for (auto const &segment : SplitPath(relativePath)) {
    current = co_await current.GetFolderAsync(winrt::to_hstring(segment));
  }
  co_return current;
}

// A StorageFolder obtained from StorageApplicationPermissions::FutureAccessList
// (via either the typed GetFolderAsync(token) or GetItemAsync(token)+cast) is
// broker-backed: identity-only operations on it (Path(), Name(), DisplayName())
// work fine, but any real content operation - GetItemsAsync() in either its
// parameterless or (startIndex, count) overload - throws a bare WinRT
// E_INVALIDARG ("The parameter is incorrect."). Reproduced on every root this
// app can grant: a %TEMP% test folder and a real drive folder, added via the
// ordinary "Add Folder"/"Add Lyrics Folder" flow. Root cause not fully nailed
// down, but this app declares rescap:runFullTrust (Desktop Bridge, not an
// AppContainer sandbox) and already has unrestricted real filesystem access -
// re-resolving through the confirmed-good Path() via GetFolderFromPathAsync
// gives back a plain local StorageFolder with no broker involved, and that
// one's GetItemsAsync() works normally.
//
// Cached per token (not re-resolved on every call) - two ordinary,
// legitimate reads racing (e.g. the playlist preloading the next track's
// audio while the current one is still decoding, both from the same root)
// used to each independently call FutureAccessList().GetItemAsync() +
// GetFolderFromPathAsync() at the same time, which reproduced as a bare
// WinRT "The file is in use. Please close the file before continuing."
// error - not from any real file lock, just concurrent broker resolution
// of the same root fighting itself. Caching the already-resolved plain
// StorageFolder means only the very first read of a given root can race
// this way (each such racer pays its own redundant resolution once, then
// every later read - including from a re-launched cold app on the OS's
// own persisted grant - reuses the shared result), and it's a real
// perf win regardless, turning every read after the first into a plain
// map lookup instead of two broker round-trips. The mutex below is only
// ever held across the synchronous map read/write, never across a
// co_await, since a coroutine can resume on a different thread than it
// suspended on and std::mutex must be unlocked on the same thread that
// locked it.
inline IAsyncOperation<StorageFolder> GetGrantedFolder(winrt::hstring token) {
  static std::mutex cacheMutex;
  static std::unordered_map<std::wstring, StorageFolder> cache;

  std::wstring key{token};
  {
    std::scoped_lock lock(cacheMutex);
    auto it = cache.find(key);
    if (it != cache.end()) {
      co_return it->second;
    }
  }

  auto item = co_await StorageApplicationPermissions::FutureAccessList().GetItemAsync(token);
  auto brokerFolder = item.as<StorageFolder>();
  auto resolved = co_await StorageFolder::GetFolderFromPathAsync(brokerFolder.Path());

  {
    std::scoped_lock lock(cacheMutex);
    // Not cache[key] = resolved - operator[] default-constructs the value
    // first on a miss, and WinRT projected types like StorageFolder have
    // no default constructor.
    cache.insert_or_assign(key, resolved); // last writer wins if this raced another resolution - both results are equally valid
  }
  co_return resolved;
}

// Splits "<token>|<relativePath>" (see file header comment) into its parts.
inline std::pair<std::string, std::string> ParseFileId(std::string const &id) {
  auto sep = id.find('|');
  if (sep == std::string::npos) {
    return {id, ""};
  }
  return {id.substr(0, sep), id.substr(sep + 1)};
}

inline int64_t DateTimeToEpochMs(winrt::Windows::Foundation::DateTime const &dateTime) {
  auto sysTime = winrt::clock::to_sys(dateTime);
  return std::chrono::duration_cast<std::chrono::milliseconds>(sysTime.time_since_epoch()).count();
}

} // namespace

REACT_MODULE(FileAccessModule, L"BPMixFileAccess")
struct FileAccessModule {
  // kind ("library"/"lyrics" - see GrantedRoot.kind's doc) has no dedicated
  // FutureAccessList field to live in, so it's packed into the one Metadata
  // string FutureAccessList entries already carry (previously just the
  // display name) as "<kind>|<displayName>", split back out in
  // ListGrantedRoots below - same "split on first '|'" convention ParseFileId
  // above already uses for FileRef.id. An entry from before this existed has
  // no '|' at all, so the whole string is just its old plain display name -
  // ListGrantedRoots treats that as kind "library", matching every other
  // adapter's `kind ?? 'library'` default-fallback for pre-existing roots.
  REACT_METHOD(PickFolder, L"pickFolder")
  winrt::fire_and_forget PickFolder(std::string kind, ReactPromise<JSValue> result) noexcept {
    try {
      FolderPicker picker;
      picker.FileTypeFilter().Append(L"*");
      picker.SuggestedStartLocation(PickerLocationId::Desktop);

      auto initWithWindow = picker.as<::IInitializeWithWindow>();
      winrt::check_hresult(initWithWindow->Initialize(BPMix_MainWindowHwnd));

      auto folder = co_await picker.PickSingleFolderAsync();
      if (!folder) {
        result.Resolve(JSValue());
        co_return;
      }

      std::string displayName = winrt::to_string(folder.DisplayName());
      std::string metadata = kind + "|" + displayName;
      auto token = StorageApplicationPermissions::FutureAccessList().Add(folder, winrt::to_hstring(metadata));

      JSValueObject obj;
      obj["id"] = winrt::to_string(token);
      obj["displayName"] = displayName;
      obj["kind"] = kind;
      result.Resolve(JSValue(std::move(obj)));
    } catch (winrt::hresult_error const &e) {
      result.Reject(winrt::to_string(e.message()).c_str());
    } catch (...) {
      result.Reject("Failed to pick folder");
    }
  }

  REACT_METHOD(ListGrantedRoots, L"listGrantedRoots")
  winrt::fire_and_forget ListGrantedRoots(ReactPromise<JSValue> result) noexcept {
    try {
      JSValueArray roots;
      for (auto const &entry : StorageApplicationPermissions::FutureAccessList().Entries()) {
        std::string metadata = winrt::to_string(entry.Metadata);
        auto sep = metadata.find('|');
        std::string kind = sep == std::string::npos ? "library" : metadata.substr(0, sep);
        std::string displayName = sep == std::string::npos ? metadata : metadata.substr(sep + 1);

        JSValueObject obj;
        obj["id"] = winrt::to_string(entry.Token);
        obj["displayName"] = displayName;
        obj["kind"] = kind;
        roots.push_back(JSValue(std::move(obj)));
      }
      result.Resolve(JSValue(std::move(roots)));
    } catch (...) {
      result.Reject("Failed to list granted roots");
    }
    co_return;
  }

  REACT_METHOD(RevokeRoot, L"revokeRoot")
  winrt::fire_and_forget RevokeRoot(std::string rootId, ReactPromise<void> result) noexcept {
    try {
      StorageApplicationPermissions::FutureAccessList().Remove(winrt::to_hstring(rootId));
      result.Resolve();
    } catch (...) {
      result.Reject("Failed to revoke root");
    }
    co_return;
  }

  REACT_METHOD(ListDirectory, L"listDirectory")
  winrt::fire_and_forget ListDirectory(std::string rootId, std::string relativePath, ReactPromise<JSValue> result)
      noexcept {
    try {
      auto root = co_await GetGrantedFolder(winrt::to_hstring(rootId));
      auto dir = co_await ResolveFolder(root, relativePath);
      auto items = co_await dir.GetItemsAsync();

      std::string prefix = relativePath.empty() ? "" : relativePath + "/";

      struct PendingFile {
        std::string name;
        std::string childRelativePath;
        StorageFile file;
      };
      std::vector<PendingFile> pendingFiles;
      JSValueArray directoryEntries;

      for (auto const &item : items) {
        std::string name = winrt::to_string(item.Name());
        std::string childRelativePath = prefix + name;

        if (item.IsOfType(StorageItemTypes::Folder)) {
          JSValueObject obj;
          obj["type"] = "directory";
          obj["name"] = name;
          obj["relativePath"] = childRelativePath;
          directoryEntries.push_back(JSValue(std::move(obj)));
        } else {
          pendingFiles.push_back(PendingFile{std::move(name), std::move(childRelativePath), item.as<StorageFile>()});
        }
      }

      JSValueArray entries = std::move(directoryEntries);

      // Fetched in bounded batches, not all 800+ of a real "Music" folder's
      // files at once - GetBasicPropertiesAsync() starts its async op
      // immediately (WinRT async operations start on call, not on
      // co_await), so kicking off every file's property fetch up front
      // used to run them all fully concurrently. That reproduced as a bare
      // WinRT "The file is in use. Please close the file before
      // continuing." error on a large folder - not a real file lock, just
      // the broker/filesystem layer choking under too many simultaneous
      // WinRT calls at once. Awaiting one file at a time (the naive fix)
      // made a full scan visibly hang for tens of seconds instead, so this
      // keeps most of that speed win by batching a bounded number of
      // concurrent fetches instead of either extreme.
      constexpr size_t kMaxConcurrentPropertyFetches = 16;
      for (size_t batchStart = 0; batchStart < pendingFiles.size(); batchStart += kMaxConcurrentPropertyFetches) {
        size_t batchEnd = std::min(batchStart + kMaxConcurrentPropertyFetches, pendingFiles.size());
        std::vector<IAsyncOperation<FileProperties::BasicProperties>> batchOps;
        for (size_t i = batchStart; i < batchEnd; i++) {
          batchOps.push_back(pendingFiles[i].file.GetBasicPropertiesAsync());
        }
        for (size_t i = batchStart; i < batchEnd; i++) {
          auto const &pending = pendingFiles[i];
          auto props = co_await batchOps[i - batchStart];

          JSValueObject fileRef;
          fileRef["id"] = rootId + "|" + pending.childRelativePath;
          fileRef["name"] = pending.name;
          fileRef["relativePath"] = pending.childRelativePath;
          fileRef["sizeBytes"] = static_cast<double>(props.Size());
          fileRef["lastModifiedMs"] = static_cast<double>(DateTimeToEpochMs(props.DateModified()));

          JSValueObject obj;
          obj["type"] = "file";
          obj["name"] = pending.name;
          obj["relativePath"] = pending.childRelativePath;
          obj["file"] = JSValue(std::move(fileRef));
          entries.push_back(JSValue(std::move(obj)));
        }
      }
      result.Resolve(JSValue(std::move(entries)));
    } catch (winrt::hresult_error const &e) {
      result.Reject(winrt::to_string(e.message()).c_str());
    } catch (...) {
      result.Reject("Failed to list directory");
    }
  }

  REACT_METHOD(ReadFileBytesBase64, L"readFileBytesBase64")
  winrt::fire_and_forget ReadFileBytesBase64(std::string fileId, ReactPromise<std::string> result) noexcept {
    try {
      auto [rootId, relativePath] = ParseFileId(fileId);
      auto root = co_await GetGrantedFolder(winrt::to_hstring(rootId));

      auto segments = SplitPath(relativePath);
      if (segments.empty()) {
        result.Reject("Empty file path");
        co_return;
      }
      std::string fileName = segments.back();
      segments.pop_back();
      std::string dirPath;
      for (auto const &s : segments) {
        dirPath += s + "/";
      }
      auto dir = co_await ResolveFolder(root, dirPath);
      auto file = co_await dir.GetFileAsync(winrt::to_hstring(fileName));

      auto buffer = co_await FileIO::ReadBufferAsync(file);
      auto base64 = CryptographicBuffer::EncodeToBase64String(buffer);
      result.Resolve(winrt::to_string(base64));
    } catch (winrt::hresult_error const &e) {
      result.Reject(winrt::to_string(e.message()).c_str());
    } catch (...) {
      result.Reject("Failed to read file bytes");
    }
  }

  REACT_METHOD(ReadFileText, L"readFileText")
  winrt::fire_and_forget ReadFileText(std::string fileId, ReactPromise<std::string> result) noexcept {
    try {
      auto [rootId, relativePath] = ParseFileId(fileId);
      auto root = co_await GetGrantedFolder(winrt::to_hstring(rootId));

      auto segments = SplitPath(relativePath);
      if (segments.empty()) {
        result.Reject("Empty file path");
        co_return;
      }
      std::string fileName = segments.back();
      segments.pop_back();
      std::string dirPath;
      for (auto const &s : segments) {
        dirPath += s + "/";
      }
      auto dir = co_await ResolveFolder(root, dirPath);
      auto file = co_await dir.GetFileAsync(winrt::to_hstring(fileName));

      auto text = co_await FileIO::ReadTextAsync(file);
      result.Resolve(winrt::to_string(text));
    } catch (winrt::hresult_error const &e) {
      result.Reject(winrt::to_string(e.message()).c_str());
    } catch (...) {
      result.Reject("Failed to read file text");
    }
  }
};

} // namespace BPMix
