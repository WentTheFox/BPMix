import type { DecodedAudio } from '../audio-engine/types';
import { yieldToEventLoop } from './yieldToEventLoop';

/** Yield every this many samples processed - frequent enough to keep the UI responsive, infrequent enough not to add real overhead. */
const YIELD_CHUNK_SAMPLES = 1_000_000;

/** Averages all channels down to one - analysis only ever needs a single representative signal, playback stays full-channel. */
export async function mixToMono(audio: DecodedAudio): Promise<Float32Array> {
  if (audio.numberOfChannels === 1) {
    return audio.channelData[0] ?? new Float32Array(0);
  }
  const length = audio.channelData[0]?.length ?? 0;
  const mono = new Float32Array(length);
  for (const channel of audio.channelData) {
    for (let i = 0; i < length; i++) {
      mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / audio.numberOfChannels;
      if (i > 0 && i % YIELD_CHUNK_SAMPLES === 0) {
        await yieldToEventLoop();
      }
    }
  }
  return mono;
}
