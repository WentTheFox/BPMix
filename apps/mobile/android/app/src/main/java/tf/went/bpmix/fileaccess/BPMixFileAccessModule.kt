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
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

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
 * Read-only apart from writeFileText, added for playlist-from-folder
 * generation - see FileAccess's documented contract
 * (packages/core/src/file-access/types.ts). MANAGE_EXTERNAL_STORAGE is an
 * all-or-nothing read+write grant for the whole of external storage, so
 * there's no separate write permission to request here, unlike the
 * web/Windows adapters.
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

  /**
   * Writes (creating or overwriting) a text file at an absolute path -
   * the one write operation this module exposes, for playlist-from-folder
   * generation (see createPlaylistFromFolder in packages/core). The
   * parent directory must already exist - see FileAccess.writeFileText's
   * own doc for why this never needs to create intermediate directories.
   */
  @ReactMethod
  fun writeFileText(path: String, content: String, promise: Promise) {
    try {
      File(path).writeText(content, Charsets.UTF_8)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("WRITE_FILE_ERROR", e)
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

  // Cover art used to be stored as a base64 "data:" URI string directly in
  // SQLite (see libraryStore.android.ts), which meant every single
  // getCoverArt() read had to marshal a whole base64-encoded image back
  // across the JS bridge as part of that query's JSON-serialized result -
  // react-native-sqlite-2 (a WebSQL polyfill, no JSI/BLOB binding) pays that
  // cost on every row, not just once. Writing the decoded bytes straight to
  // a cache file here and storing only the resulting file:// path in SQLite
  // moves the base64 crossing to write time only (once per track, when art
  // is first scanned) - every subsequent read is just a short path string,
  // and <Image source={{uri}}/> reads the file directly via native image
  // decoding with no JS involvement at all.
  @ReactMethod
  fun writeLocalBytesBase64(fileName: String, base64Data: String, promise: Promise) {
    try {
      val file = File(reactContext.filesDir, fileName)
      file.parentFile?.mkdirs()
      file.writeBytes(Base64.decode(base64Data, Base64.NO_WRAP))
      promise.resolve(file.absolutePath)
    } catch (e: Exception) {
      promise.reject("WRITE_LOCAL_ERROR", e)
    }
  }

  /** Best-effort - resolves null even if the file never existed, since callers (e.g. putCoverArt(fileId, null)) treat "nothing to delete" the same as "deleted". */
  @ReactMethod
  fun deleteLocalFile(fileName: String, promise: Promise) {
    try {
      File(reactContext.filesDir, fileName).delete()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("DELETE_LOCAL_ERROR", e)
    }
  }

  // --- Offline downloads (see apps/mobile/src/adapters/offlineBackend.android.ts) ---
  //
  // Tracks are streamed straight from the network to a file under filesDir/offline and hashed on the way
  // through, so a 40MB file never crosses the JS bridge (or gets base64'd) just to be saved. A file's name is
  // the SHA-256 of its track id (ids are long paths); the download goes to a ".part" file and is renamed once
  // complete, so a file that exists is a complete one.

  private val activeDownloads = ConcurrentHashMap<String, HttpURLConnection>()
  private val cancelledDownloads = ConcurrentHashMap.newKeySet<String>()

  private fun offlineFile(fileId: String, suffix: String = ""): File {
    val name = MessageDigest.getInstance("SHA-256").digest(fileId.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    return File(File(reactContext.filesDir, "offline").apply { mkdirs() }, name + suffix)
  }

  // Required by NativeEventEmitter; progress events are emitted whether or not anything listens.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  /**
   * Rejects with code NETWORK (could not reach / lost the server), HTTP_<status> (the server said no) or
   * ABORTED (offlineCancel was called). Progress goes out as "BPMixOfflineProgress" {requestId, bytes}, at most
   * every 250ms.
   */
  @ReactMethod
  fun offlineDownload(requestId: String, fileId: String, url: String, headers: ReadableMap, promise: Promise) {
    Thread {
      val part = offlineFile(fileId, ".part")
      try {
        val connection = URL(url).openConnection() as HttpURLConnection
        activeDownloads[requestId] = connection
        connection.instanceFollowRedirects = true
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        val keys = headers.keySetIterator()
        while (keys.hasNextKey()) {
          val key = keys.nextKey()
          connection.setRequestProperty(key, headers.getString(key))
        }
        connection.connect()
        val status = connection.responseCode
        if (status !in 200..299) {
          connection.disconnect()
          promise.reject("HTTP_$status", "HTTP $status")
          return@Thread
        }
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        var lastEmit = 0L
        connection.inputStream.use { input ->
          FileOutputStream(part).use { output ->
            val buffer = ByteArray(64 * 1024)
            var read: Int
            while (input.read(buffer).also { read = it } != -1) {
              output.write(buffer, 0, read)
              digest.update(buffer, 0, read)
              total += read
              val now = System.currentTimeMillis()
              if (now - lastEmit >= 250) {
                lastEmit = now
                val event: WritableMap = Arguments.createMap()
                event.putString("requestId", requestId)
                event.putDouble("bytes", total.toDouble())
                reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("BPMixOfflineProgress", event)
              }
            }
          }
        }
        val dest = offlineFile(fileId)
        dest.delete()
        if (!part.renameTo(dest)) throw IOException("Could not move the download into place")
        val result: WritableMap = Arguments.createMap()
        result.putDouble("sizeBytes", total.toDouble())
        result.putString("sha256", digest.digest().joinToString("") { "%02x".format(it) })
        promise.resolve(result)
      } catch (e: Exception) {
        part.delete()
        if (cancelledDownloads.remove(requestId)) promise.reject("ABORTED", "Download cancelled")
        else promise.reject("NETWORK", e.message, e)
      } finally {
        activeDownloads.remove(requestId)
      }
    }.start()
  }

  @ReactMethod
  fun offlineCancel(requestId: String) {
    val connection = activeDownloads[requestId] ?: return
    cancelledDownloads.add(requestId)
    // Closing the socket from another thread is how a blocked read is interrupted; it must not be the JS thread's problem.
    Thread { connection.disconnect() }.start()
  }

  /** The stored bytes as base64, or null if there is no copy. Same shape as readFileBytesBase64, which is how local tracks reach the audio engine. */
  @ReactMethod
  fun offlineReadBase64(fileId: String, promise: Promise) {
    try {
      val file = offlineFile(fileId)
      promise.resolve(if (file.isFile) Base64.encodeToString(file.readBytes(), Base64.NO_WRAP) else null)
    } catch (e: Exception) {
      promise.reject("READ_FILE_ERROR", e)
    }
  }

  /** Stored size in bytes, or -1 if there is no copy. */
  @ReactMethod
  fun offlineSize(fileId: String, promise: Promise) {
    val file = offlineFile(fileId)
    promise.resolve(if (file.isFile) file.length().toDouble() else -1.0)
  }

  @ReactMethod
  fun offlineRemove(fileId: String, promise: Promise) {
    offlineFile(fileId).delete()
    offlineFile(fileId, ".part").delete()
    promise.resolve(null)
  }
}
