package tf.went.beatseam.fileaccess

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Keeps one small secret (the server device token) encrypted with an AES-256-GCM key that lives in the
 * Android Keystore and can't be exported, so the ciphertext in the app's files is useless on its own (a copied
 * data directory, a backup, a rooted file browser). The file is IV (12 bytes) + ciphertext. If the key is
 * gone or the file no longer decrypts (e.g. the key was invalidated), get() reports no secret rather than
 * failing, and the app treats that as signed out.
 */
class BeatseamSecretStoreModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "BeatseamSecretStore"

  private val keyStore: KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun file(name: String) = File(reactContext.filesDir, "secret-$name.bin")

  private fun keyFor(name: String, create: Boolean): SecretKey? {
    val alias = "beatseam-secret-$name"
    (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
    if (!create) return null
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }

  /** Resolves the secret, or null if none is stored or it can't be decrypted any more. */
  @ReactMethod
  fun getSecret(name: String, promise: Promise) {
    try {
      val stored = file(name)
      val key = keyFor(name, create = false)
      if (!stored.isFile || key == null) {
        promise.resolve(null)
        return
      }
      val bytes = stored.readBytes()
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes, 0, 12))
      promise.resolve(String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8))
    } catch (e: Exception) {
      promise.resolve(null)
    }
  }

  /** Stores the secret, replacing any earlier one. */
  @ReactMethod
  fun setSecret(name: String, value: String, promise: Promise) {
    try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, keyFor(name, create = true))
      val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
      // Written beside and renamed over the old one so a crash never leaves half a file.
      val target = file(name)
      val temp = File(target.parentFile, target.name + ".tmp")
      temp.writeBytes(sealed)
      if (!temp.renameTo(target)) throw java.io.IOException("Could not save the secret")
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("SECRET_STORE_ERROR", e)
    }
  }

  @ReactMethod
  fun deleteSecret(name: String, promise: Promise) {
    try {
      file(name).delete()
      keyStore.deleteEntry("beatseam-secret-$name")
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("SECRET_STORE_ERROR", e)
    }
  }
}
