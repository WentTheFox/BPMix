import {
  computeTransitionPlan,
  equalPowerGain,
  formatTrackTitle,
  isMetadataCurrent,
  realTimeForOutgoingPosition,
  trackDisplayName,
  type LibraryStore,
  type PlaylistPlayer,
  type PlaylistPlayerState,
  type TrackMetadata,
  type TrackRecord,
} from '@bpmix/core';
import { useEffect, useState } from 'react';
import { CROSSFADE_ART_TRANSITION_MS } from './CrossfadeArt';
import { LOADING_TURNS_PER_SECOND, TURNS_PER_SONG } from './spin/spinConstants';
import { useCoverArt } from './useCoverArt';
import { useTrackMetadata } from './useTrackMetadata';

export interface CrossfadePlaybackDisplayInput {
  playlistPlayer: PlaylistPlayer;
  playerState: PlaylistPlayerState;
  activeTracksById: Map<string, TrackRecord>;
  libraryStore: LibraryStore;
  crossfadeSeconds: number;
}

export interface CrossfadePlaybackDisplay {
  nowPlayingTrack: TrackRecord | undefined;
  nextTrack: TrackRecord | undefined;
  outgoingTrack: TrackRecord | undefined;
  incomingTrack: TrackRecord | undefined;
  outgoingCoverArt: string | null;
  incomingCoverArt: string | null;
  outgoingGain: number;
  incomingGain: number;
  outgoingProgress: number;
  isLoadingTrack: boolean;
  isPlaying: boolean;
  displayPositionSeconds: number;
  displayDurationSeconds: number;
  currentTurnsPerSecond: number;
  settledCurrentTrack: TrackRecord | undefined;
  settledCurrentMetadata: TrackMetadata | null;
  settledNextTrack: TrackRecord | undefined;
  settledNextMetadata: TrackMetadata | null;
  currentTitle: string | null;
  currentName: string;
  currentArtist: string | null;
}

/**
 * Collapses the two byte-identical "wait CROSSFADE_ART_TRANSITION_MS then
 * settle on the new key" effects that used to be duplicated per outgoing/
 * incoming track in both apps' App.tsx. Finalizing on cleanup (not just the
 * timeout) matters when keys change faster than CROSSFADE_ART_TRANSITION_MS
 * apart (e.g. rapid manual skips): otherwise each new effect run just
 * cancels the previous one's pending set without ever applying it, leaving
 * the title/art permanently stuck on a stale track once the skips stop.
 */
function useSettledKey(key: string | null): string | null {
  const [settledKey, setSettledKey] = useState<string | null>(key);
  useEffect(() => {
    if (key === settledKey) return;
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      setSettledKey(key);
    };
    const timeout = setTimeout(finalize, CROSSFADE_ART_TRANSITION_MS);
    return () => {
      clearTimeout(timeout);
      finalize();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return settledKey;
}

/**
 * Pure derivation of everything the now-playing/crossfade UI needs from
 * playback state - shared verbatim between apps/mobile/App.tsx and
 * apps/web/src/App.tsx, which computed this identically before this
 * extraction. Reads only playerState/activeTracksById/libraryStore/
 * crossfadeSeconds - no platform API calls, so this stays a plain (non
 * `.web.ts`-split) shared hook.
 */
export function useCrossfadePlaybackDisplay(input: CrossfadePlaybackDisplayInput): CrossfadePlaybackDisplay {
  const { playlistPlayer, playerState, activeTracksById, libraryStore, crossfadeSeconds } = input;

  const nowPlayingTrack = playerState.currentFileId ? activeTracksById.get(playerState.currentFileId) : undefined;

  // Debug view: preview of the crossfade into whatever's queued up next,
  // computed from the same TransitionPlan/visualization data real playback
  // scheduling will use - lets the fade timing be checked by eye before
  // (and regardless of) actual audio engine wiring. No BPM/analysis lookup
  // needed for this plan any more - see computeTransitionPlan's doc; the
  // preview's bpm labels just read "BPM unknown" for now (live BPM display
  // is a later round).
  const [nextFileId, setNextFileId] = useState<string | null>(null);
  useEffect(() => {
    setNextFileId(playlistPlayer.getNextFileId());
  }, [playlistPlayer, playerState.position, playerState.loopMode, playerState.shuffleEnabled, playerState.totalTracks]);
  const nextTrack = nextFileId ? activeTracksById.get(nextFileId) : undefined;

  // A crossfade already in flight (natural end-of-track OR a manual skip's
  // short one - see TrackPlayerState.pendingIncoming's doc) switches the
  // displayed name/position/duration/track-counter over to the incoming
  // track immediately, rather than waiting for onCrossfadeCompleted - lines
  // the display change up with what's already audible throughout the fade,
  // instead of an abrupt seek-bar jump the instant the swap actually
  // completes (the bar climbing toward the OUTGOING track's duration for
  // the whole fade, then snapping to a small fraction of the usually much
  // longer incoming track's duration).
  const pendingIncoming = playerState.track.pendingIncoming;
  // Explicit rather than inferred from currentFileId/nextFileId - see
  // PlaylistPlayerState.pendingCrossfadeFileIds' doc for why those two
  // don't reliably mean "outgoing"/"incoming" on their own (a manual skip
  // advances position/currentFileId to the target immediately, unlike the
  // natural end-of-track crossfade, which only does that once it completes).
  const pendingCrossfadeFileIds = playerState.pendingCrossfadeFileIds;
  const pendingOutgoingTrack = pendingCrossfadeFileIds ? activeTracksById.get(pendingCrossfadeFileIds.outgoing) : undefined;
  const pendingIncomingTrack = pendingCrossfadeFileIds ? activeTracksById.get(pendingCrossfadeFileIds.incoming) : undefined;

  const transitionPlan = (() => {
    if (pendingIncoming) {
      // A crossfade is genuinely happening right now - reflect its real
      // duration (a manual skip's fadeDurationSeconds is much shorter than
      // the natural end-of-track default below), not a static preview of
      // a future one.
      return { fadeStartSeconds: 0, fadeDurationSeconds: pendingIncoming.fadeDurationSeconds, incomingStartSeconds: 0 };
    }
    if (playerState.track.durationSeconds <= 0) return null;
    return computeTransitionPlan(playerState.track.durationSeconds, crossfadeSeconds);
  })();

  // The preview's timeline is relative to the fade start (t=0). While a
  // crossfade is actually in flight, pendingIncoming.positionSeconds IS
  // that elapsed time directly (incomingStartSeconds is always 0, rate is
  // always 1 this round) - no need for realTimeForOutgoingPosition's
  // fadeStartSeconds-relative math, which only applies to the *preview* of
  // a future natural-end crossfade computed from the static default plan.
  const crossfadeProgressSeconds = pendingIncoming
    ? pendingIncoming.positionSeconds
    : transitionPlan
      ? realTimeForOutgoingPosition(transitionPlan, playerState.track.positionSeconds)
      : null;

  // isLoadingForPlayback, not the raw status==='loading' - the latter is
  // also true for the on-launch restore's silent, non-autoplaying decode
  // (see PlaylistPlayerState.isLoadingForPlayback's doc), which shouldn't
  // show a loading bar for a track that isn't actually about to play.
  const isLoadingTrack = playerState.isLoadingForPlayback;

  const outgoingTrack = pendingOutgoingTrack ?? nowPlayingTrack;
  const incomingTrack = pendingIncomingTrack ?? nextTrack;
  const outgoingTrackMetadata = useTrackMetadata(libraryStore, outgoingTrack?.fileId ?? null);
  const incomingTrackMetadata = useTrackMetadata(libraryStore, incomingTrack?.fileId ?? null);
  const outgoingCoverArt = useCoverArt(libraryStore, outgoingTrack?.fileId ?? null, isMetadataCurrent(outgoingTrackMetadata));
  const incomingCoverArt = useCoverArt(libraryStore, incomingTrack?.fileId ?? null, isMetadataCurrent(incomingTrackMetadata));
  // Same equalPowerGain() call SourceNode.rampGainCurve uses for the real
  // audio fade, sampled at the current progress instead of over a curve -
  // this is what makes the art dissolve at exactly the rate the audio
  // itself fades (see CrossfadeArt's doc).
  const fadeDurationSeconds = transitionPlan?.fadeDurationSeconds ?? 0;
  const crossfadeFraction =
    crossfadeProgressSeconds == null
      ? null
      : fadeDurationSeconds > 0
        ? crossfadeProgressSeconds / fadeDurationSeconds
        : crossfadeProgressSeconds >= 0
          ? 1
          : 0;
  // Feeds CrossfadeArt's spin *speed* (not opacity) - see its doc for why.
  // A crossfade only ever runs while actually playing, so pendingIncoming
  // already implies isPlaying - this only matters for the paused case,
  // where the record shouldn't keep spinning: crossfadeFraction isn't
  // actually null then (it's some out-of-range value from
  // realTimeForOutgoingPosition, which equalPowerGain clamps close to 1/0
  // on its own), so the "not playing" override has to apply after that
  // computation, not just to its null-fallback branch.
  const isPlaying = pendingIncoming ? true : playerState.track.status === 'playing';
  const outgoingGain = isPlaying
    ? crossfadeFraction == null
      ? 1
      : equalPowerGain(crossfadeFraction, true, fadeDurationSeconds)
    : 0;
  const incomingGain = crossfadeFraction == null ? 0 : equalPowerGain(crossfadeFraction, false, fadeDurationSeconds);
  const displayPositionSeconds = pendingIncoming ? pendingIncoming.positionSeconds : playerState.track.positionSeconds;
  const displayDurationSeconds = pendingIncoming ? pendingIncoming.durationSeconds : playerState.track.durationSeconds;
  // Feeds CrossfadeArt's tonearm needle position - the outgoing track's own
  // position/duration regardless of any pending crossfade (it keeps
  // playing/advancing independently of the incoming preview; the tonearm
  // itself sweeps back to the edge on its own once a crossfade starts, see
  // CrossfadeArtProps.nextGain's doc, so this doesn't need an "incoming"
  // counterpart any more).
  const outgoingProgress = playerState.track.durationSeconds > 0 ? playerState.track.positionSeconds / playerState.track.durationSeconds : 0;
  // Feeds CrossfadeArt's disc spin (a real turns-per-second rate, not a
  // per-tick progress retarget - see CrossfadeArtProps.currentTurnsPerSecond's
  // doc): spins at a placeholder rate as soon as a track starts loading
  // (like a real platter already turning before the needle drops - the
  // tonearm itself stays lifted off the disc throughout, since currentGain
  // is 0 until isPlaying), TURNS_PER_SONG spread over the track's own
  // duration once it's actually playing, 0 while paused/idle.
  const currentTurnsPerSecond = isLoadingTrack
    ? LOADING_TURNS_PER_SECOND
    : !isPlaying
      ? 0
      : playerState.track.durationSeconds > 0
        ? TURNS_PER_SONG / playerState.track.durationSeconds
        : 0;

  // Title/"up next" text only actually changes CROSSFADE_ART_TRANSITION_MS
  // after outgoingTrack/incomingTrack do, not the instant playback state
  // changes (which is also when metadata/art prefetching starts) - lines
  // the text swap up with the same beat as CrossfadeArt's own disc
  // swap/fade instead of each updating at its own independent moment. A
  // plain timer (matching CrossfadeArt's own constant) rather than hooking
  // into that component's internal animation completion - far more robust
  // than threading a callback through Animated's completion handling,
  // which can report "interrupted" under rapid track changes and leave a
  // callback-based sync stuck.
  const settledCurrentKey = useSettledKey(outgoingTrack?.fileId ?? null);
  const settledNextKey = useSettledKey(incomingTrack?.fileId ?? null);
  const settledCurrentTrack = settledCurrentKey ? activeTracksById.get(settledCurrentKey) : undefined;
  const settledCurrentMetadata = useTrackMetadata(libraryStore, settledCurrentKey);
  const settledNextTrack = settledNextKey ? activeTracksById.get(settledNextKey) : undefined;
  const settledNextMetadata = useTrackMetadata(libraryStore, settledNextKey);

  // Falls back to outgoingTrack (the *unsettled* current track record - see
  // its own doc), then a generic "Loading…" placeholder, rather than ever
  // falling all the way to the raw playerState.currentFileId - on web
  // that's an internal composite routing key (scheme + root uuid +
  // relativePath, see fileAccess.composite.ts), never meant for display,
  // confirmed on-device as a literal "local::<uuid>:..." string flashing
  // in the title during the brief window before settledCurrentTrack (or,
  // on a cold launch, activeTracksById itself) catches up.
  const currentTitle = settledCurrentTrack
    ? formatTrackTitle(settledCurrentMetadata, settledCurrentTrack)
    : outgoingTrack
      ? formatTrackTitle(null, outgoingTrack)
      : playerState.currentFileId
        ? 'Loading…'
        : null;
  const currentName = settledCurrentTrack
    ? settledCurrentMetadata?.title || trackDisplayName(settledCurrentTrack)
    : outgoingTrack
      ? trackDisplayName(outgoingTrack)
      : playerState.currentFileId
        ? 'Loading…'
        : '';
  const currentArtist = settledCurrentMetadata?.artists.join(', ') || null;

  return {
    nowPlayingTrack,
    nextTrack,
    outgoingTrack,
    incomingTrack,
    outgoingCoverArt,
    incomingCoverArt,
    outgoingGain,
    incomingGain,
    outgoingProgress,
    isLoadingTrack,
    isPlaying,
    displayPositionSeconds,
    displayDurationSeconds,
    currentTurnsPerSecond,
    settledCurrentTrack,
    settledCurrentMetadata,
    settledNextTrack,
    settledNextMetadata,
    currentTitle,
    currentName,
    currentArtist,
  };
}
