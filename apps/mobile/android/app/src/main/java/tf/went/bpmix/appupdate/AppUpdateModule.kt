package tf.went.bpmix.appupdate

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * "Download a release APK from GitHub and install it" for a sideloaded app
 * with no Play Store to hand updates off to - see apps/mobile/src/adapters/
 * appUpdate.android.ts for the JS side (GitHub Releases API check, checksum
 * comparison) that drives this.
 */
class AppUpdateModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "BPMixAppUpdate"

  /**
   * Whether this app is currently allowed to trigger a package install.
   * API 26+ only - below that there's no per-app toggle, just a single
   * global "Unknown sources" setting the OS already gates the install
   * Intent on regardless, so there's nothing to check pre-26.
   */
  @ReactMethod
  fun canRequestInstallPackages(promise: Promise) {
    val allowed =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.packageManager.canRequestPackageInstalls()
      } else {
        true
      }
    promise.resolve(allowed)
  }

  /**
   * Opens the system "install unknown apps" settings screen for this app -
   * fire-and-forget, same pattern as BPMixFileAccessModule's
   * openAllFilesAccessSettings (no onActivityResult plumbing; the JS side
   * re-checks canRequestInstallPackages() when the app resumes instead).
   */
  @ReactMethod
  fun requestInstallPermission(promise: Promise) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
          data = Uri.parse("package:${reactContext.packageName}")
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
      reactContext.startActivity(intent)
    }
    promise.resolve(null)
  }

  /**
   * Downloads `url` into this app's private cache/updates/ dir as
   * `fileName`, computing its SHA-256 while streaming (one pass over the
   * bytes, not a separate re-read afterward) - the JS side compares this
   * against a checksum published alongside the GitHub release before ever
   * calling installApk, rather than trusting a completed download on faith.
   * Runs off the JS thread (a plain background Thread, not Promise-blocking)
   * since a release APK download is tens of MB.
   */
  @ReactMethod
  fun downloadFile(url: String, fileName: String, promise: Promise) {
    Thread {
        try {
          val dir = File(reactContext.cacheDir, "updates").apply { mkdirs() }
          val destFile = File(dir, fileName)
          val connection = URL(url).openConnection() as HttpURLConnection
          connection.instanceFollowRedirects = true
          connection.connect()
          if (connection.responseCode !in 200..299) {
            throw Exception("HTTP ${connection.responseCode} downloading $url")
          }

          val digest = MessageDigest.getInstance("SHA-256")
          connection.inputStream.use { input ->
            FileOutputStream(destFile).use { output ->
              val buffer = ByteArray(64 * 1024)
              var read: Int
              while (input.read(buffer).also { read = it } != -1) {
                output.write(buffer, 0, read)
                digest.update(buffer, 0, read)
              }
            }
          }

          val sha256 = digest.digest().joinToString("") { "%02x".format(it) }
          val result: WritableMap = Arguments.createMap()
          result.putString("path", destFile.absolutePath)
          result.putString("sha256", sha256)
          promise.resolve(result)
        } catch (e: Exception) {
          promise.reject("DOWNLOAD_FAILED", e.message, e)
        }
      }
      .start()
  }

  /**
   * Launches the system package installer for a file downloadFile() already
   * saved. The FileProvider content:// URI (not a raw file:// path) is what
   * makes this work at all across the app-private cache boundary on API
   * 24+ - see AndroidManifest.xml's provider entry and file_paths.xml.
   */
  @ReactMethod
  fun installApk(filePath: String, promise: Promise) {
    try {
      val file = File(filePath)
      val uri = FileProvider.getUriForFile(reactContext, "${reactContext.packageName}.fileprovider", file)
      val intent =
        Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
      reactContext.startActivity(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("INSTALL_FAILED", e.message, e)
    }
  }
}
