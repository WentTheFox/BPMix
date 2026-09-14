import { GITHUB_REPO } from './githubRepo';

export interface ReleaseAsset {
  name: string;
  browserDownloadUrl: string;
}

export interface AvailableUpdate {
  /** The release's git tag, e.g. "v0.2.0". */
  version: string;
  htmlUrl: string;
  apkAsset: ReleaseAsset;
  /** checksums.txt, if the release has one (native-builds.yml's release job always attaches one - see relocateMissingTrack... no, see that workflow's "Collect release assets" step). Verified against the downloaded APK's own computed hash before installing - null only for a release published some other way. */
  checksumsAsset: ReleaseAsset | null;
}

/** [major, minor, patch], or null for anything that isn't a clean "v1.2.3" (or "1.2.3") - notably a dev build's `git describe` output like "v0.1.0-2-gabc123", which this deliberately can't parse as a version to compare against (see checkForUpdate's doc on why that's the right call). */
function parseSemver(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewer(candidate: string, current: string): boolean {
  const c = parseSemver(candidate);
  const b = parseSemver(current);
  if (!c || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (c[i] !== b[i]) return c[i]! > b[i]!;
  }
  return false;
}

/**
 * Checks GitHub's Releases API for a version newer than `currentVersion`
 * (see @bpmix/core's buildInfo.ts's BUILD_VERSION - a git-describe string,
 * "v1.2.3" exactly at a tagged release build, or "v1.2.3-N-gHASH" for a dev
 * build N commits past the last tag). A dev build's version string can't be
 * cleanly parsed as a plain semver, so it's treated as "nothing to compare
 * against" (never reports an update) rather than guessing - this check is
 * only meaningful for an actual tagged release build in practice (the
 * Android release APK), which always has a clean "vX.Y.Z" version.
 *
 * Returns null when already up to date, when there's no newer release, or
 * when the latest release has no APK asset attached (shouldn't happen for
 * a release native-builds.yml created, but a manually-published release
 * might not have one).
 */
export async function checkForUpdate(currentVersion: string): Promise<AvailableUpdate | null> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
  if (!res.ok) {
    throw new Error(`GitHub releases check failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    tag_name: string;
    html_url: string;
    assets: { name: string; browser_download_url: string }[];
  };

  if (!isNewer(data.tag_name, currentVersion)) return null;

  const apkAsset = data.assets.find((a) => a.name.endsWith('.apk'));
  if (!apkAsset) return null;
  const checksumsAsset = data.assets.find((a) => a.name === 'checksums.txt');

  return {
    version: data.tag_name,
    htmlUrl: data.html_url,
    apkAsset: { name: apkAsset.name, browserDownloadUrl: apkAsset.browser_download_url },
    checksumsAsset: checksumsAsset ? { name: checksumsAsset.name, browserDownloadUrl: checksumsAsset.browser_download_url } : null,
  };
}

/**
 * Parses `sha256sum`-style output ("<hex>  <filename>" per line, see
 * native-builds.yml's checksums.txt generation) and returns the hash for
 * one specific file name, or null if that name isn't listed.
 */
export function parseChecksumsFile(text: string, fileName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2] === fileName) return match[1]!.toLowerCase();
  }
  return null;
}
