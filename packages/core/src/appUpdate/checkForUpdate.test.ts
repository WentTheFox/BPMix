import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, parseChecksumsFile } from './checkForUpdate';

function mockRelease(overrides: Partial<{ tag_name: string; assets: { name: string; browser_download_url: string }[] }> = {}) {
  return {
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/WentTheFox/BPMix/releases/tag/v0.2.0',
    assets: [
      { name: 'app-release.apk', browser_download_url: 'https://example.com/app-release.apk' },
      { name: 'checksums.txt', browser_download_url: 'https://example.com/checksums.txt' },
    ],
    ...overrides,
  };
}

describe('checkForUpdate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(release: ReturnType<typeof mockRelease>, ok = true) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok,
        status: ok ? 200 : 500,
        json: async () => release,
      }),
    );
  }

  it('reports an update when the latest release is a newer semver than the current version', async () => {
    stubFetch(mockRelease({ tag_name: 'v0.2.0' }));
    const result = await checkForUpdate('v0.1.0');
    expect(result).toEqual({
      version: 'v0.2.0',
      htmlUrl: 'https://github.com/WentTheFox/BPMix/releases/tag/v0.2.0',
      apkAsset: { name: 'app-release.apk', browserDownloadUrl: 'https://example.com/app-release.apk' },
      checksumsAsset: { name: 'checksums.txt', browserDownloadUrl: 'https://example.com/checksums.txt' },
    });
  });

  it('returns null when already up to date', async () => {
    stubFetch(mockRelease({ tag_name: 'v0.1.0' }));
    expect(await checkForUpdate('v0.1.0')).toBeNull();
  });

  it('returns null when the current version is older-looking numerically but the release is not actually newer', async () => {
    stubFetch(mockRelease({ tag_name: 'v0.1.0' }));
    expect(await checkForUpdate('v0.2.0')).toBeNull();
  });

  it('never reports an update for a dev build version string it cannot parse as semver', async () => {
    stubFetch(mockRelease({ tag_name: 'v0.2.0' }));
    expect(await checkForUpdate('v0.1.0-3-gabc1234')).toBeNull();
  });

  it('returns null when the latest release has no .apk asset', async () => {
    stubFetch(mockRelease({ tag_name: 'v0.2.0', assets: [{ name: 'source.zip', browser_download_url: 'https://example.com/source.zip' }] }));
    expect(await checkForUpdate('v0.1.0')).toBeNull();
  });

  it('checksumsAsset is null when the release has no checksums.txt', async () => {
    stubFetch(mockRelease({ tag_name: 'v0.2.0', assets: [{ name: 'app-release.apk', browser_download_url: 'https://example.com/app-release.apk' }] }));
    const result = await checkForUpdate('v0.1.0');
    expect(result?.checksumsAsset).toBeNull();
  });

  it('throws when the GitHub API request fails', async () => {
    stubFetch(mockRelease(), false);
    await expect(checkForUpdate('v0.1.0')).rejects.toThrow('500');
  });
});

describe('parseChecksumsFile', () => {
  const text = ['a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2  app-release.apk', 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  other-file.zip'].join(
    '\n',
  );

  it('finds the hash for a matching file name', () => {
    expect(parseChecksumsFile(text, 'app-release.apk')).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
  });

  it('returns null for a file not listed', () => {
    expect(parseChecksumsFile(text, 'missing.apk')).toBeNull();
  });

  it('handles the binary-mode "*filename" prefix sha256sum sometimes writes', () => {
    const binaryModeText = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 *app-release.apk';
    expect(parseChecksumsFile(binaryModeText, 'app-release.apk')).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
  });
});
