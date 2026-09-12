import type { FileAccess, FileRef } from '../file-access/types';
import { formatM3u8 } from '../playlist/m3u8';
import { readTags } from '../metadata/readTags';
import { walkDirectory } from './walk';

/**
 * Best-effort heuristic, not a guarantee of playability - matches whatever
 * react-native-audio-api's underlying decoder actually supports on a given
 * platform. Broad on purpose (a folder full of loose audio files, unlike
 * scanRoot's m3u8-driven discovery, has no other signal to filter on).
 */
const AUDIO_FILE_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma'];

const PLAYLIST_EXTENSIONS = ['.m3u8', '.m3u'];

function hasExtension(name: string, extensions: string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

export type PlaylistSortCriterion = 'dateCreated' | 'title' | 'artist' | 'album';
export type PlaylistSortOrder = 'asc' | 'desc';

export interface PlaylistCandidateTrack {
  file: FileRef;
  title: string | null;
  artist: string | null;
  album: string | null;
}

/**
 * Recursively finds every audio-looking file under `folderRelativePath`
 * ('' for the root itself) and reads each one's ID3 tags, so a caller can
 * offer sort-by-title/artist/album and a preview before the playlist is
 * actually written. Unlike scanRoot (which only ever treats "files
 * referenced by an existing playlist" as tracks), this is the one place
 * BPMix looks at a folder's audio files directly - see
 * CLAUDE.md's "let the user create a playlist directly from a folder" TODO
 * this exists for. Playlist files themselves are excluded (a .m3u8 already
 * sitting in the folder shouldn't get "included" in a new one built from
 * it). A file whose tags fail to read (corrupt/unsupported) still gets
 * included, just with null title/artist/album - falling back to its
 * filename for sorting/display is the caller's job (see
 * sortPlaylistCandidates), not a reason to drop it from the playlist
 * outright.
 */
export async function findPlaylistCandidateTracks(
  fileAccess: FileAccess,
  rootId: string,
  folderRelativePath: string,
): Promise<PlaylistCandidateTrack[]> {
  const { files } = await walkDirectory(fileAccess, rootId, folderRelativePath || undefined);
  const audioFiles = files.filter((f) => hasExtension(f.name, AUDIO_FILE_EXTENSIONS) && !hasExtension(f.name, PLAYLIST_EXTENSIONS));

  return Promise.all(
    audioFiles.map(async (file): Promise<PlaylistCandidateTrack> => {
      try {
        const bytes = await fileAccess.readFileBytes(file);
        const tags = await readTags(bytes);
        return {
          file,
          title: tags?.title ?? null,
          artist: tags && tags.artists.length > 0 ? tags.artists.join(', ') : null,
          album: tags?.album ?? null,
        };
      } catch {
        return { file, title: null, artist: null, album: null };
      }
    }),
  );
}

/**
 * Pure sort, kept separate from findPlaylistCandidateTracks so the UI can
 * re-sort instantly (switching sort criterion/order) without re-reading
 * every file's tags again. Falls back to the filename for title, and to an
 * empty string (sorting to one end) for artist/album, when a file has no
 * such tag - "dateCreated" actually means FileRef.lastModifiedMs, the only
 * timestamp any FileAccess adapter exposes (see FileRef's own doc); no
 * platform surfaces a true file-creation time.
 */
export function sortPlaylistCandidates(
  tracks: PlaylistCandidateTrack[],
  sortBy: PlaylistSortCriterion,
  order: PlaylistSortOrder,
): PlaylistCandidateTrack[] {
  const compare = (a: PlaylistCandidateTrack, b: PlaylistCandidateTrack): number => {
    switch (sortBy) {
      case 'dateCreated':
        return a.file.lastModifiedMs - b.file.lastModifiedMs;
      case 'title':
        return (a.title ?? a.file.name).localeCompare(b.title ?? b.file.name);
      case 'artist':
        return (a.artist ?? '').localeCompare(b.artist ?? '');
      case 'album':
        return (a.album ?? '').localeCompare(b.album ?? '');
    }
  };
  const sorted = [...tracks].sort(compare);
  if (order === 'desc') sorted.reverse();
  return sorted;
}

/** Strips illegal filename characters common to Windows/Android/web filesystems, falling back to a generic name if nothing usable is left. */
function sanitizeFileName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]/g, '_');
  return cleaned || 'Playlist';
}

/**
 * Writes a new .m3u8 directly into `folderRelativePath` (the same folder
 * the tracks were found under), referencing `tracks` in the order given -
 * sort them with sortPlaylistCandidates first. Returns the written
 * playlist's relativePath. Deliberately doesn't touch LibraryStore itself:
 * the caller should rescan the root afterward (see scanRoot), so the new
 * playlist goes through the exact same ingestion path as any other
 * externally-added .m3u8 rather than needing its own parallel logic.
 */
export async function writePlaylistFile(
  fileAccess: FileAccess,
  rootId: string,
  folderRelativePath: string,
  name: string,
  tracks: PlaylistCandidateTrack[],
): Promise<string> {
  const relativePath = folderRelativePath ? `${folderRelativePath}/${sanitizeFileName(name)}.m3u8` : `${sanitizeFileName(name)}.m3u8`;
  const folderPrefix = folderRelativePath ? `${folderRelativePath}/` : '';
  const contents = formatM3u8(
    tracks.map((track) => ({
      // Relative to the playlist's own location (the same folder it's
      // written into) - a plain filename for a track directly inside that
      // folder, a subpath for one found deeper during the recursive walk.
      rawPath: track.file.relativePath.startsWith(folderPrefix) ? track.file.relativePath.slice(folderPrefix.length) : track.file.relativePath,
    })),
  );
  await fileAccess.writeFileText(rootId, relativePath, contents);
  return relativePath;
}
