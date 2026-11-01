package tf.went.beatseam

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import tf.went.beatseam.appupdate.AppUpdatePackage
import tf.went.beatseam.discordrpc.DiscordRpcPackage
import tf.went.beatseam.backgroundticks.BeatseamBackgroundTicksPackage
import tf.went.beatseam.fileaccess.BeatseamFileAccessPackage
import tf.went.beatseam.memorydebug.MemoryInfoPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(MemoryInfoPackage())
          add(BeatseamFileAccessPackage())
          add(BeatseamBackgroundTicksPackage())
          add(AppUpdatePackage())
          add(DiscordRpcPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
