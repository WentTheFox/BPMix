package tf.went.bpmix.fileaccess

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.io.File

/**
 * Plain java.io.File access over the whole of external storage, gated on
 * MANAGE_EXTERNAL_STORAGE ("All files access") - the replacement for the
 * Storage Access Framework tree-picker flow (react-native-scoped-storage's
 * openDocumentTree), which hit a real, unrecoverable-from-JS device bug: a
 * Samsung "My Files" SAF picker was rejecting every folder grant outright,
 * including a freshly-created, empty test folder, while its own normal
 * browse mode saw the same folders fine. There's no OS folder-picker UI in
 * this flow at all any more - see FolderBrowser (packages/ui), BPMix's own
 * in-app subfolder navigator, which is now how a root gets chosen too, not
 * just a music/lyrics scope within one.
 *
 * Read-only by design, matching FileAccess's documented contract
 * (packages/core/src/file-access/types.ts) - no write/delete/create method
 * is exposed here at all, deliberately, even though MANAGE_EXTERNAL_STORAGE
 * itself would technically allow it.
 */
class BPMixFileAccessModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "BPMixFileAccess"

  @ReactMethod
  fun hasAllFilesAccess(promise: Promise) {
    val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      Environment.isExternalStorageManager()
    } else {
      // Pre-Android 11 scoped storage doesn't exist yet - normal external
      // storage permissions already cover this app's minSdk range in
      // practice, so there's nothing further to gate here.
      true
    }
    promise.resolve(granted)
  }

  /**
   * Fire-and-forget: opens the system settings screen for this app's "All
   * files access" toggle. There's no reliable promise-shaped result here
   * (no onActivityResult plumbing) - the JS side just re-checks
   * hasAllFilesAccess() when the app resumes (see fileAccess.android.ts).
   */
  @ReactMethod
  fun requestAllFilesAccess() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
        data = Uri.parse("package:${reactContext.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(intent)
    }
  }

  @ReactMethod
  fun getExternalStorageRoot(promise: Promise) {
    promise.resolve(Environment.getExternalStorageDirectory().absolutePath)
  }

  @ReactMethod
  fun listDirectory(path: String, promise: Promise) {
    try {
      val dir = File(path)
      val children = dir.listFiles()
      if (children == null) {
        promise.reject("LIST_DIRECTORY_ERROR", "Not a readable directory: $path")
        return
      }
      val result: WritableArray = Arguments.createArray()
      for (child in children) {
        val entry: WritableMap = Arguments.createMap()
        entry.putString("name", child.name)
        entry.putBoolean("isDirectory", child.isDirectory)
        entry.putDouble("sizeBytes", child.length().toDouble())
        entry.putDouble("lastModifiedMs", child.lastModified().toDouble())
        result.pushMap(entry)
      }
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("LIST_DIRECTORY_ERROR", e)
    }
  }

  @ReactMethod
  fun readFileText(path: String, promise: Promise) {
    try {
      promise.resolve(File(path).readText(Charsets.UTF_8))
    } catch (e: Exception) {
      promise.reject("READ_FILE_ERROR", e)
    }
  }

  @ReactMethod
  fun readFileBytesBase64(path: String, promise: Promise) {
    try {
      promise.resolve(Base64.encodeToString(File(path).readBytes(), Base64.NO_WRAP))
    } catch (e: Exception) {
      promise.reject("READ_FILE_ERROR", e)
    }
  }

  // Persists the list of folders the user has picked as roots (see
  // fileAccess.android.ts's listGrantedRoots/requestRoot) - there's no OS
  // permission per folder any more to enumerate (MANAGE_EXTERNAL_STORAGE is
  // all-or-nothing for the whole of external storage), so BPMix has to
  // remember its own root list itself. Stored in this app's private
  // internal storage (filesDir), same pattern as the Windows adapter's
  // LocalStorageModule.h.
  @ReactMethod
  fun readLocalText(fileName: String, promise: Promise) {
    try {
      val file = File(reactContext.filesDir, fileName)
      promise.resolve(if (file.exists()) file.readText(Charsets.UTF_8) else null)
    } catch (e: Exception) {
      promise.reject("READ_LOCAL_ERROR", e)
    }
  }

  @ReactMethod
  fun writeLocalText(fileName: String, content: String, promise: Promise) {
    try {
      File(reactContext.filesDir, fileName).writeText(content, Charsets.UTF_8)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("WRITE_LOCAL_ERROR", e)
    }
  }
}
