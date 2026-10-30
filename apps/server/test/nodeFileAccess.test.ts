import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeFileAccess } from '../src/node/nodeFileAccess.js';

let base: string;
const access = () => createNodeFileAccess(base, new Set(['Lyrics']));

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'bpmix-fa-'));
  await mkdir(path.join(base, 'Music', 'Album'), { recursive: true });
  await mkdir(path.join(base, 'Lyrics'));
  await writeFile(path.join(base, 'Music', 'Album', 'a.txt'), 'héllo');
  await writeFile(path.join(base, 'outside.txt'), 'secret');
  await symlink(path.join(base, 'outside.txt'), path.join(base, 'Music', 'escape.txt'));
});

afterAll(() => rm(base, { recursive: true, force: true }));

describe('NodeFileAccess', () => {
  it('lists roots from volume mounts, marking lyrics roots', async () => {
    const roots = (await access().listGrantedRoots()).sort((x, y) => x.id.localeCompare(y.id));
    expect(roots).toEqual([
      { id: 'Lyrics', displayName: 'Lyrics', kind: 'lyrics', removable: false },
      { id: 'Music', displayName: 'Music', kind: 'library', removable: false },
    ]);
  });

  it('lists directories and reads files back by their FileRef', async () => {
    const fa = access();
    const top = await fa.listDirectory('Music');
    expect(top.map((e) => [e.type, e.relativePath]).sort()).toEqual([['directory', 'Album'], ['file', 'escape.txt']]);
    const entries = await fa.listDirectory('Music', 'Album');
    const ref = entries[0]!.file!;
    expect(ref).toMatchObject({ id: 'Music:Album/a.txt', name: 'a.txt', relativePath: 'Album/a.txt', sizeBytes: 6 });
    expect(await fa.readFileText(ref)).toBe('héllo');
    expect(new Uint8Array(await fa.readFileBytes(ref)).byteLength).toBe(6);
    expect(await fa.getContentHash!(ref)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses symlink escapes and unknown roots', async () => {
    const fa = access();
    const escape = { id: 'Music:escape.txt', name: 'escape.txt', relativePath: 'escape.txt', sizeBytes: 6, lastModifiedMs: 0 };
    await expect(fa.readFileText(escape)).rejects.toThrow(/escapes its root/);
    await expect(fa.listDirectory('Nope')).rejects.toThrow(/No library root/);
    await expect(fa.writeFileText('Music', '../evil.txt', 'x')).rejects.toThrow();
  });

  it('writes files inside a root', async () => {
    await access().writeFileText('Music', 'Album/new.m3u8', '#EXTM3U\n');
    expect(await readFile(path.join(base, 'Music', 'Album', 'new.m3u8'), 'utf8')).toBe('#EXTM3U\n');
  });
});
