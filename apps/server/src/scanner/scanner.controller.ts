import { BadRequestException, Controller, Get, HttpCode, Post, Query, Sse, type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  listScanFailuresQuerySchema,
  listScanJobsQuerySchema,
  type Page,
  type ScanFailureDto,
  type ScanJobDto,
  type ScanStatusDto,
} from '@beatseam/api';
import { Roles } from '../auth/principal.js';
import { fileIdFromKey } from '../common/trackKeys.js';
import { ScannerService } from './scanner.service.js';

@Roles('ADMIN')
@Controller('api/v1/scan')
export class ScannerController {
  constructor(private readonly scanner: ScannerService) {}

  @Get()
  status(): Promise<ScanStatusDto> {
    return this.scanner.status();
  }

  /**
   * Server-sent events for the admin page: a `changed` event (at most one a second) whenever the scan's state may
   * have moved, so it re-reads the status then instead of polling. The `ping` every 25s only keeps the
   * connection from being closed as idle by a proxy in between.
   */
  @Sse('events')
  events(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let pending: NodeJS.Timeout | null = null;
      const onChanged = () => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          subscriber.next({ type: 'changed', data: '' });
        }, 1000);
      };
      this.scanner.changes.on('changed', onChanged);
      const keepAlive = setInterval(() => subscriber.next({ type: 'ping', data: '' }), 25_000);
      return () => {
        this.scanner.changes.off('changed', onChanged);
        clearInterval(keepAlive);
        if (pending) clearTimeout(pending);
      };
    });
  }

  /** Kicks off a scan (or joins the running one) and returns immediately. */
  @Post()
  @HttpCode(202)
  async start(): Promise<ScanStatusDto> {
    void this.scanner.scanAll().catch(() => undefined);
    return { ...(await this.scanner.status()), running: true };
  }

  /** Tracks in a queue state; SKIPPED (the default) is the "what is hopeless and why" view. */
  @Get('jobs')
  jobs(@Query() query: Record<string, unknown>): Promise<Page<ScanJobDto>> {
    const parsed = listScanJobsQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    return this.scanner.listJobs(parsed.data.state, parsed.data.limit, parsed.data.cursor);
  }

  /** Recent failed attempts, newest first - including ones that later succeeded on a retry. */
  @Get('failures')
  failures(@Query() query: Record<string, unknown>): Promise<ScanFailureDto[]> {
    const parsed = listScanFailuresQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    return this.scanner.listFailures(parsed.data.limit, parsed.data.trackId ? fileIdFromKey(parsed.data.trackId) : undefined);
  }

  /** Re-queues skipped tracks: all of them, or just `?trackId=`. */
  @Post('retry')
  async retry(@Query('trackId') trackId?: string): Promise<{ requeued: number }> {
    return { requeued: await this.scanner.retrySkipped(trackId ? fileIdFromKey(trackId) : undefined) };
  }
}
