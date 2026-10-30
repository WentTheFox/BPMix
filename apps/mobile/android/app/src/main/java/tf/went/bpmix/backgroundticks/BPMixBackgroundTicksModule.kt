package tf.went.bpmix.backgroundticks

import android.os.Handler
import android.os.HandlerThread
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Ticks for the JS side while the app is in the background. React Native's own timers (setInterval and
 * friends) are paused whenever the Android host activity is - so while music plays with the screen off or
 * another app in front, everything the playback ticker drives (position, preload/crossfade scheduling, the
 * media notification, Discord and Last.fm updates, the saved position) would freeze until the app came back.
 * A Handler on its own thread isn't affected, so it emits "BPMixBackgroundTick" events instead; the JS
 * ticker listens only while it's in the background (see startPlaybackTicker's `background`) and stops this
 * as soon as it's foregrounded again, so the foreground cost is nil.
 */
class BPMixBackgroundTicksModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "BPMixBackgroundTicks"

  private var thread: HandlerThread? = null
  private var handler: Handler? = null
  @Volatile private var running = false

  // Required by NativeEventEmitter.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  @ReactMethod
  fun start(intervalMs: Double) {
    stop()
    val interval = intervalMs.toLong().coerceAtLeast(100)
    val newThread = HandlerThread("bpmix-background-ticks").also { it.start() }
    val newHandler = Handler(newThread.looper)
    thread = newThread
    handler = newHandler
    running = true
    newHandler.post(
      object : Runnable {
        override fun run() {
          if (!running) return
          if (reactContext.hasActiveReactInstance()) {
            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("BPMixBackgroundTick", null)
          }
          newHandler.postDelayed(this, interval)
        }
      },
    )
  }

  @ReactMethod
  fun stop() {
    running = false
    handler?.removeCallbacksAndMessages(null)
    thread?.quitSafely()
    handler = null
    thread = null
  }

  override fun invalidate() {
    stop()
    super.invalidate()
  }
}
