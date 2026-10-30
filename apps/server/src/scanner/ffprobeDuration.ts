import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Container-level duration via ffprobe, for the formats core's header-prefix
 * parser can't read (Ogg/Opus/WMA/APE, or an MP4 whose moov trails the audio).
 * Returns null if ffprobe can't tell, rather than throwing - an unprobeable
 * file is a missing duration, not a failed scan.
 */
export async function probeDurationSeconds(absolutePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration', '-of', 'csv=p=0', absolutePath], {
      timeout: 30_000,
    });
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}
