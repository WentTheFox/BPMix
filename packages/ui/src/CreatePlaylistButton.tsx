import { mdiPlaylistPlus } from '@mdi/js';
import { useState } from 'react';
import { Pressable } from 'react-native';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icon';
import type { Colors } from './theme';

export interface CreatePlaylistButtonProps {
  colors: Colors;
  onConfirm: () => void;
}

/**
 * LibraryScreen's per-root "New Playlist" icon. A bare mdiPlaylistPlus glyph
 * with no label wasn't clear on its own what it actually does (confirmed by
 * the user directly), so a tap now explains it first via ConfirmDialog
 * rather than jumping straight into CreatePlaylistScreen - Continue there
 * proceeds exactly like the old direct-tap behavior did.
 */
export function CreatePlaylistButton({ colors, onConfirm }: CreatePlaylistButtonProps) {
  const [explaining, setExplaining] = useState(false);

  return (
    <>
      <Pressable onPress={() => setExplaining(true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Icon path={mdiPlaylistPlus} size={18} color={colors.accent} />
      </Pressable>
      {explaining && (
        <ConfirmDialog
          colors={colors}
          title="New Playlist"
          message="Create a new playlist from every audio file found anywhere in this folder, including subfolders. You can add or remove tracks afterwards."
          confirmLabel="Continue"
          onCancel={() => setExplaining(false)}
          onConfirm={() => {
            setExplaining(false);
            onConfirm();
          }}
        />
      )}
    </>
  );
}
