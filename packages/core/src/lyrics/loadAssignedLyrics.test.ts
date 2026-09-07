import { describe, expect, it } from 'vitest';
import type { DirectoryEntry, FileAccess, FileRef, GrantedRoot } from '../file-access/types';
import type { LyricsScope } from '../library-store/types';
import { loadAssignedLyrics, scanAllLyricsScopes } from './loadAssignedLyrics';

/** In-memory FileAccess over a flat { relativePath: content } map, scoped to one rootId. */
class FakeFileAccess implements FileAccess {
  constructor(
    private readonly rootId: string,
    private readonly filesByPath: Record<string, string>,
  ) {}

  async requestRoot(): Promise<GrantedRoot | null> {
    throw new Error('not used in this test');
  }
  async listGrantedRoots(): Promise<GrantedRoot[]> {
    return [];
  }
  async revokeRoot(): Promise<void> {}

  async listDirectory(rootId: string, relativePath = ''): Promise<DirectoryEntry[]> {
    if (rootId !== this.rootId) return [];
    const prefix = relativePath === '' ? '' : `${relativePath}/`;
    return Object.keys(this.filesByPath)
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map((path) => ({ type: 'file' as const, name: path.slice(prefix.length), relativePath: path, file: this.toFileRef(path) }));
  }

  private toFileRef(relativePath: string): FileRef {
    return { id: relativePath, name: relativePath.split('/').pop()!, relativePath, sizeBytes: 0, lastModifiedMs: 0 };
  }

  async readFileBytes(): Promise<ArrayBuffer> {
    throw new Error('not used in this test');
  }
  async readFileText(ref: FileRef): Promise<string> {
    return this.filesByPath[ref.relativePath]!;
  }
}

const SCOPE: LyricsScope = { rootId: 'root', relativePath: '' };
const LRC_CONTENT = '[00:01.00]Hello\n[00:02.00]World';

describe('scanAllLyricsScopes', () => {
  it('combines candidates across every configured scope', async () => {
    const fileAccess = new FakeFileAccess('root', { 'a.lrc': LRC_CONTENT, 'b.lrc': LRC_CONTENT, 'song.mp3': 'not lyrics' });
    const files = await scanAllLyricsScopes(fileAccess, [SCOPE]);
    expect(files.map((f) => f.name).sort()).toEqual(['a.lrc', 'b.lrc']);
  });
});

describe('loadAssignedLyrics', () => {
  it('returns null when the track has no assignment', async () => {
    const fileAccess = new FakeFileAccess('root', {});
    const result = await loadAssignedLyrics(fileAccess, { getLyricsAssignment: async () => null } as never, [SCOPE], 'track-1');
    expect(result).toBeNull();
  });

  it('returns null when the assigned file can no longer be found (e.g. its scope was removed)', async () => {
    const fileAccess = new FakeFileAccess('root', {});
    const result = await loadAssignedLyrics(fileAccess, { getLyricsAssignment: async () => 'missing.lrc' } as never, [SCOPE], 'track-1');
    expect(result).toBeNull();
  });

  it('resolves the assigned fileId to its FileRef and parses its content', async () => {
    const fileAccess = new FakeFileAccess('root', { 'Track One.lrc': LRC_CONTENT });
    const result = await loadAssignedLyrics(fileAccess, { getLyricsAssignment: async () => 'Track One.lrc' } as never, [SCOPE], 'track-1');
    expect(result).toEqual({ synced: true, tags: {}, lines: [{ timeSeconds: 1, text: 'Hello' }, { timeSeconds: 2, text: 'World' }] });
  });

  it('attaches a same-stemmed .en.lrc sibling as each line\'s translation', async () => {
    const fileAccess = new FakeFileAccess('root', {
      'Track One.lrc': LRC_CONTENT,
      'Track One.en.lrc': '[00:01.10]Bonjour\n[00:02.10]Monde',
    });
    const result = await loadAssignedLyrics(fileAccess, { getLyricsAssignment: async () => 'Track One.lrc' } as never, [SCOPE], 'track-1');
    expect(result?.lines).toEqual([
      { timeSeconds: 1, text: 'Hello', translation: 'Bonjour' },
      { timeSeconds: 2, text: 'World', translation: 'Monde' },
    ]);
  });

  it('ignores an unrelated .en.lrc file that does not share the assigned file\'s stem', async () => {
    const fileAccess = new FakeFileAccess('root', {
      'Track One.lrc': LRC_CONTENT,
      'Track Two.en.lrc': '[00:01.00]Nope',
    });
    const result = await loadAssignedLyrics(fileAccess, { getLyricsAssignment: async () => 'Track One.lrc' } as never, [SCOPE], 'track-1');
    expect(result).toEqual({ synced: true, tags: {}, lines: [{ timeSeconds: 1, text: 'Hello' }, { timeSeconds: 2, text: 'World' }] });
  });
});
