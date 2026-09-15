/** "M:SS" under an hour, "H:MM:SS" at or past one hour (a long DJ mix/podcast-length file shouldn't read as e.g. "83:07"). Rounds to the nearest second. */
export function formatDuration(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  const secondsStr = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${secondsStr}`;
  }
  return `${minutes}:${secondsStr}`;
}
