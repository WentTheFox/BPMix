package tf.went.bpmix.discordrpc

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import com.discord.socialsdk.rpc.IDiscordRpcCallback
import com.discord.socialsdk.rpc.IDiscordRpcConnection
import com.discord.socialsdk.rpc.IDiscordRpcService
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule

private const val RPC_SERVICE_ACTION = "com.discord.socialsdk.rpc.IDiscordRpcService"
private const val DISCORD_PACKAGE = "com.discord"
/** Hardcoded to match the official SDK's own DiscordRpcClient, which passes this same literal - see IDiscordRpcService.aidl's doc. */
private const val RPC_VERSION = "1"

/**
 * Talks to the real Discord Android app's exposed IDiscordRpcService over a
 * bound-service Binder connection - the exact same HANDSHAKE/SET_ACTIVITY
 * JSON-frame protocol as desktop Discord's named-pipe IPC (see
 * packages/core/src/discord/richPresence.ts, shared with the eventual
 * Windows implementation), just carried over Android's binder instead of a
 * pipe. The three IDiscordRpc*.aidl interfaces this binds against are
 * hand-rolled (see their own doc) rather than pulling in Discord's official
 * Social SDK AAR, which bundles ~60MB of WebRTC/voice binaries this feature
 * never touches - the AIDL contract itself is exposed by Discord's own
 * installed app, so nothing here needs to embed any of Discord's code to
 * speak it.
 *
 * Only a single connection at a time is supported (BPMix only ever needs
 * one Rich Presence session) - connect() while already connected/connecting
 * tears down and restarts rather than stacking a second bind.
 */
class DiscordRpcModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "BPMixDiscordRpc"

  private var service: IDiscordRpcService? = null
  private var rpcConnection: IDiscordRpcConnection? = null
  private var bound = false
  private var pendingConnectPromise: Promise? = null

  private val callback =
    object : IDiscordRpcCallback.Stub() {
      override fun onFrame(frame: String?) {
        val params = Arguments.createMap()
        params.putString("frame", frame)
        emitEvent("BPMixDiscordRpcFrame", params)
      }

      override fun onClose(code: Int, reason: String?) {
        rpcConnection = null
        val params = Arguments.createMap()
        params.putInt("code", code)
        params.putString("reason", reason)
        emitEvent("BPMixDiscordRpcClose", params)
      }
    }

  private val serviceConnection =
    object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
        val boundService = IDiscordRpcService.Stub.asInterface(binder)
        service = boundService
        val promise = pendingConnectPromise
        pendingConnectPromise = null
        try {
          val applicationId = pendingApplicationId ?: run {
            promise?.reject("BPMixDiscordRpc", "connect() called without an application id")
            return
          }
          rpcConnection = boundService.connect(applicationId, RPC_VERSION, callback)
          if (rpcConnection == null) {
            promise?.reject("BPMixDiscordRpc", "Discord rejected the handshake")
          } else {
            promise?.resolve(true)
          }
        } catch (e: Exception) {
          promise?.reject("BPMixDiscordRpc", "Failed to handshake with Discord: ${e.message}", e)
        }
      }

      override fun onServiceDisconnected(name: ComponentName?) {
        service = null
        rpcConnection = null
        bound = false
        val params = Arguments.createMap()
        params.putInt("code", 1006)
        params.putString("reason", "service disconnected")
        emitEvent("BPMixDiscordRpcClose", params)
      }
    }

  private var pendingApplicationId: Long? = null

  private fun emitEvent(name: String, params: WritableMap) {
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(name, params)
  }

  /**
   * Binds to Discord's RPC service and performs the handshake. Resolves
   * true once a session is established, rejects if Discord isn't installed,
   * doesn't expose the service, or refuses the handshake (e.g. the user has
   * disabled third-party Rich Presence in their Discord privacy settings).
   */
  @ReactMethod
  fun connect(applicationId: String, promise: Promise) {
    disconnectInternal()
    val parsedId =
      try {
        applicationId.toLong()
      } catch (e: NumberFormatException) {
        promise.reject("BPMixDiscordRpc", "applicationId must be a numeric Discord snowflake string")
        return
      }
    pendingApplicationId = parsedId
    val intent = Intent(RPC_SERVICE_ACTION).apply { setPackage(DISCORD_PACKAGE) }
    // resolveService first (rather than just calling bindService and seeing
    // if it returns false) so "Discord not installed" gets its own clear
    // rejection message instead of the generic bindService failure below.
    if (reactContext.packageManager.resolveService(intent, 0) == null) {
      promise.reject("BPMixDiscordRpc", "Discord is not installed")
      return
    }
    pendingConnectPromise = promise
    try {
      bound = reactContext.bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
      if (!bound) {
        pendingConnectPromise = null
        promise.reject("BPMixDiscordRpc", "bindService returned false")
      }
    } catch (e: SecurityException) {
      pendingConnectPromise = null
      promise.reject("BPMixDiscordRpc", "bindService denied: ${e.message}", e)
    }
  }

  /** Sends a raw JSON RPC frame (see packages/core/src/discord/richPresence.ts for how SET_ACTIVITY frames are built) - resolves false rather than rejecting if there's no active connection, since a stale/late call here (e.g. a track update that lost a race with a disconnect) is an expected, harmless no-op, not an error the caller needs to handle specially. */
  @ReactMethod
  fun sendFrame(frame: String, promise: Promise) {
    val connection = rpcConnection
    if (connection == null) {
      promise.resolve(false)
      return
    }
    try {
      connection.sendFrame(frame)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("BPMixDiscordRpc", "Failed to send frame: ${e.message}", e)
    }
  }

  @ReactMethod
  fun disconnect(promise: Promise) {
    disconnectInternal()
    promise.resolve(null)
  }

  private fun disconnectInternal() {
    try {
      rpcConnection?.disconnect()
    } catch (e: Exception) {
      // Already gone on Discord's end - nothing more to do.
    }
    if (bound) {
      try {
        reactContext.unbindService(serviceConnection)
      } catch (e: IllegalArgumentException) {
        // Already unbound (e.g. Discord's process died first) - unbindService
        // throws in that case rather than no-op'ing.
      }
    }
    service = null
    rpcConnection = null
    bound = false
    pendingConnectPromise = null
    pendingApplicationId = null
  }

  // RN's built-in NativeEventEmitter expects every native module it wraps to
  // implement these two, even though nothing here needs to do actual
  // listener bookkeeping (emitEvent above fires regardless of subscriber
  // count) - omitting them logs an "unimplemented" warning on every
  // addListener/removeListeners call from the JS side.
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}
}
