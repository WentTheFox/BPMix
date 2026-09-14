const AUDIO_FILE_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma'];

/**
 * Best-effort heuristic, not a guarantee of playability - matches whatever
 * react-native-audio-api's underlying decoder actually supports on a given
 * platform. Shared by createPlaylistFromFolder (a folder full of loose audio
 * files has no other signal to filter on) and the "locate this missing
 * file" picker (candidates are every audio-looking file in the root, not
 * just ones already referenced by a playlist).
 */
export function isAudioFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return AUDIO_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
