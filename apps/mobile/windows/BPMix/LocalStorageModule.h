#pragma once

#include "pch.h"

#include <NativeModules.h>

#include <winrt/Windows.Storage.h>

// Minimal native primitive backing libraryStore.windows.ts: read/write a
// whole text file in the app's own sandboxed local-data folder (no picker,
// no permissions needed - this is app-private storage, unlike
// FileAccessModule's user-granted folders). Every third-party Windows
// persistence library found (async-storage, sqlite-2) ships only
// pre-NuGet-era UWP C# project files that don't link against the current
// C++/WinRT template, so libraryStore's actual JSON-collection logic lives
// in TypeScript and just needs these two primitives from native.

namespace BPMix {

REACT_MODULE(LocalStorageModule, L"BPMixLocalStorage")
struct LocalStorageModule {
  REACT_METHOD(ReadText, L"readText")
  winrt::fire_and_forget ReadText(std::string fileName, ReactPromise<winrt::Microsoft::ReactNative::JSValue> result)
      noexcept {
    using namespace winrt::Microsoft::ReactNative;
    using namespace winrt::Windows::Storage;
    try {
      auto folder = ApplicationData::Current().LocalFolder();
      auto item = co_await folder.TryGetItemAsync(winrt::to_hstring(fileName));
      if (!item) {
        result.Resolve(JSValue());
        co_return;
      }
      auto file = item.as<StorageFile>();
      auto text = co_await FileIO::ReadTextAsync(file);
      result.Resolve(JSValue(winrt::to_string(text)));
    } catch (...) {
      result.Resolve(JSValue());
    }
  }

  REACT_METHOD(WriteText, L"writeText")
  winrt::fire_and_forget WriteText(std::string fileName, std::string content, ReactPromise<void> result) noexcept {
    using namespace winrt::Windows::Storage;
    try {
      auto folder = ApplicationData::Current().LocalFolder();
      auto file = co_await folder.CreateFileAsync(
          winrt::to_hstring(fileName), CreationCollisionOption::ReplaceExisting);
      co_await FileIO::WriteTextAsync(file, winrt::to_hstring(content));
      result.Resolve();
    } catch (winrt::hresult_error const &e) {
      result.Reject(winrt::to_string(e.message()).c_str());
    } catch (...) {
      result.Reject("Failed to write local storage file");
    }
  }
};

} // namespace BPMix
