// Manual Jest mock: react-native-audio-api needs a real native module, which
// doesn't exist in the Jest test environment. This only needs to satisfy the
// module-scope `new AudioContext()` in audioEngine.android.ts without
// throwing - component smoke tests never actually call decode/play.
class AudioContext {
  currentTime = 0;
  destination = {};
}

module.exports = { AudioContext };
