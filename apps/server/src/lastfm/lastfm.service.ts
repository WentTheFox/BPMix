import { BadRequestException, ConflictException, Inject, Injectable, Logger, Optional, UnprocessableEntityException, BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LastFmNowPlayingRequestDto, LastFmScrobbleEntryDto, LastFmStatusDto } from '@bpmix/api';
import { buildAuthUrl, DEFAULT_LASTFM_API_KEY, DEFAULT_LASTFM_API_SECRET, getAuthToken, getSession, LastFmError, scrobbleBatch, updateNowPlaying, type LastFmCredentials } from '@bpmix/core';
import { SECRET_BOX } from '../auth/auth.service.js';
import type { SecretBox } from '../auth/crypto/secretBox.js';
import { DatabaseService } from '../db/database.module.js';

/** Swapped in tests so nothing reaches the real Last.fm. */
export const LASTFM_FETCH = Symbol('LASTFM_FETCH');

/** Last.fm's own error code for "this token hasn't been approved yet". */
const UNAUTHORIZED_TOKEN = 14;
/** Last.fm's "invalid session key": the user revoked BPMix on their side, or the key is otherwise dead. */
const INVALID_SESSION = 9;
const PENDING_TOKEN_TTL_MS = 10 * 60_000;

/**
 * Each user's Last.fm link, kept on the server: the app credentials (BPMIX_LASTFM_API_KEY/_SECRET, else
 * BPMix's shared app) never leave it, and neither does the session key, which is sealed at rest. Apps
 * ask the server to connect, say what's playing, and hand over scrobbles; this is what signs and sends
 * them. That also means a link survives reinstalling an app and works from every device at once.
 */
@Injectable()
export class LastFmService {
  private readonly logger = new Logger(LastFmService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Optional() @Inject(LASTFM_FETCH) private readonly fetchImpl?: typeof fetch,
  ) {}

  private get prisma() {
    return this.db.prisma;
  }

  private credentials(): LastFmCredentials {
    return {
      apiKey: this.config.get<string>('BPMIX_LASTFM_API_KEY') || DEFAULT_LASTFM_API_KEY,
      apiSecret: this.config.get<string>('BPMIX_LASTFM_API_SECRET') || DEFAULT_LASTFM_API_SECRET,
      fetch: this.fetchImpl,
    };
  }

  async status(userId: string): Promise<LastFmStatusDto> {
    const row = await this.prisma.lastFmConnection.findUnique({ where: { userId } });
    return { connected: !!row?.sessionKeyEnc, username: row?.sessionKeyEnc ? row.username : null };
  }

  /** Asks Last.fm for a token and returns the page the user approves it on. */
  async connect(userId: string): Promise<{ authUrl: string }> {
    const credentials = this.credentials();
    const token = await this.callLastFm(() => getAuthToken(credentials));
    await this.prisma.lastFmConnection.upsert({
      where: { userId },
      create: { userId, pendingToken: token, pendingAt: new Date() },
      update: { pendingToken: token, pendingAt: new Date() },
    });
    return { authUrl: buildAuthUrl(credentials, token) };
  }

  /** Exchanges the approved token for a session. 409 (not_authorized) while the user hasn't approved it yet - ask again. */
  async complete(userId: string): Promise<LastFmStatusDto> {
    const row = await this.prisma.lastFmConnection.findUnique({ where: { userId } });
    if (!row?.pendingToken || !row.pendingAt || Date.now() - row.pendingAt.getTime() > PENDING_TOKEN_TTL_MS) {
      throw new BadRequestException({ code: 'no_pending_connect', message: 'Start connecting to Last.fm first' });
    }
    try {
      const session = await getSession(this.credentials(), row.pendingToken);
      await this.prisma.lastFmConnection.update({
        where: { userId },
        data: { username: session.username, sessionKeyEnc: this.box.seal(session.sessionKey), connectedAt: new Date(), pendingToken: null, pendingAt: null },
      });
      this.logger.log(`User ${userId} connected Last.fm as ${JSON.stringify(session.username)}`);
      return { connected: true, username: session.username };
    } catch (err) {
      if (err instanceof LastFmError && err.code === UNAUTHORIZED_TOKEN) {
        throw new ConflictException({ code: 'not_authorized', message: 'Not approved yet - approve BPMix on the Last.fm page, then try again' });
      }
      return this.rethrow(err);
    }
  }

  async disconnect(userId: string): Promise<LastFmStatusDto> {
    await this.prisma.lastFmConnection.deleteMany({ where: { userId } });
    return { connected: false, username: null };
  }

  async nowPlaying(userId: string, track: LastFmNowPlayingRequestDto): Promise<void> {
    const sessionKey = await this.sessionKey(userId);
    await this.callAsUser(userId, () => updateNowPlaying(this.credentials(), sessionKey, { artist: track.artist, track: track.track, album: track.album ?? null, durationSeconds: track.durationSeconds ?? null }));
  }

  async scrobble(userId: string, entries: LastFmScrobbleEntryDto[]): Promise<void> {
    const sessionKey = await this.sessionKey(userId);
    await this.callAsUser(userId, () => scrobbleBatch(this.credentials(), sessionKey, entries));
  }

  private async sessionKey(userId: string): Promise<string> {
    const row = await this.prisma.lastFmConnection.findUnique({ where: { userId } });
    if (!row?.sessionKeyEnc) throw new ConflictException({ code: 'not_connected', message: 'Last.fm is not connected' });
    return this.box.open(row.sessionKeyEnc);
  }

  /** A call made with the user's session: a dead session is cleared, so the next status shows it needs connecting again. */
  private async callAsUser(userId: string, call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (err) {
      if (err instanceof LastFmError && err.code === INVALID_SESSION) {
        await this.prisma.lastFmConnection.deleteMany({ where: { userId } });
        this.logger.warn(`Last.fm rejected the session of user ${userId}; disconnected`);
      }
      this.rethrow(err);
    }
  }

  private async callLastFm<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      return this.rethrow(err);
    }
  }

  /** What Last.fm itself refused is final (422); anything else - it being down, no route to it - is worth retrying later (502). */
  private rethrow(err: unknown): never {
    if (err instanceof LastFmError && err.code !== null) {
      throw new UnprocessableEntityException({ code: 'lastfm_rejected', lastFmCode: err.code, message: err.message });
    }
    this.logger.warn(`Could not reach Last.fm: ${String(err)}`);
    throw new BadGatewayException({ code: 'lastfm_unreachable', message: 'Could not reach Last.fm' });
  }
}
