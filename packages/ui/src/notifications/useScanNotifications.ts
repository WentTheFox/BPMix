import {
  getActiveScanRootIds,
  getScanDisplayName,
  getScanProgress,
  subscribeScanning,
  subscribeScanProgress,
  type GrantedRoot,
  type ScanProgress,
} from '@bpmix/core';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { NotificationCenter } from './useNotificationCenter';

function describeProgress(progress: ScanProgress | undefined): { suffix: string; current: number; total: number } {
  if (!progress) return { suffix: '', current: 0, total: 0 };
  switch (progress.phase) {
    case 'listing': {
      const folders = `${progress.foldersListed} folder${progress.foldersListed === 1 ? '' : 's'}`;
      return { suffix: ` - ${progress.filesFound} files in ${folders}`, current: 0, total: 0 };
    }
    case 'playlists':
      return { suffix: ' - reading playlists', current: progress.current, total: progress.total };
    case 'saving':
      return { suffix: ' - saving library', current: progress.current, total: progress.total };
  }
}

/**
 * Keeps one notification-bell entry per in-flight library scan, with live
 * progress and a Cancel action - whichever caller started the scan
 * (Add Folder, Rescan, or a background refresh() with no user gesture
 * behind it), and from whichever screen the user is on.
 *
 * Driven straight from scanCoordinator's own active set, not filtered by
 * grantedRoots: a freshly added folder's first scan runs before the root
 * shows up in grantedRoots at all (apps/*'s refresh() only picks it up once
 * the scan finishes), which used to mean the initial scan - the longest
 * one - never got a notification.
 */
export function useScanNotifications(
  notificationCenter: NotificationCenter,
  grantedRoots: GrantedRoot[],
  cancelScan: (rootId: string) => void,
): void {
  const { upsertProgress, dismiss } = notificationCenter;
  const activeRootIds = useSyncExternalStore(subscribeScanning, getActiveScanRootIds, getActiveScanRootIds);

  // Read through a ref so a grantedRoots change doesn't need to re-run the
  // effects below - only the name fallback for a scan started without a
  // displayName reads it.
  const grantedRootsRef = useRef(grantedRoots);
  grantedRootsRef.current = grantedRoots;

  // The effects below call this through a ref and only depend on the
  // stable dismiss (see useNotificationCenter) - depending on the whole
  // notificationCenter object would loop, since it changes every time these
  // effects themselves update a notification.
  const show = useRef<(rootId: string, progress: ScanProgress | undefined) => void>(() => undefined);
  show.current = (rootId, progress) => {
    const name = getScanDisplayName(rootId) ?? grantedRootsRef.current.find((r) => r.id === rootId)?.displayName ?? rootId;
    const { suffix, current, total } = describeProgress(progress);
    upsertProgress(`scanning-${rootId}`, `Scanning "${name}"${suffix}`, current, total, false, undefined, {
      label: 'Cancel',
      onPress: () => cancelScan(rootId),
    });
  };

  const previousRootIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const stillScanning = new Set(activeRootIds);
    for (const rootId of previousRootIdsRef.current) {
      if (!stillScanning.has(rootId)) dismiss(`scanning-${rootId}`);
    }
    for (const rootId of activeRootIds) show.current(rootId, getScanProgress(rootId));
    previousRootIdsRef.current = activeRootIds;
  }, [activeRootIds, dismiss]);

  useEffect(
    () =>
      subscribeScanProgress((rootId, progress) => {
        // A last throttled tick can't outlive its scan (the coordinator
        // clears it on finish), but guard anyway so a late one can never
        // resurrect a dismissed entry.
        if (getActiveScanRootIds().includes(rootId)) show.current(rootId, progress);
      }),
    [],
  );
}
