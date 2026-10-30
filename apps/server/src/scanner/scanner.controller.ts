import { BadRequestException, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  decodeTrackKey,
  listScanFailuresQuerySchema,
  listScanJobsQuerySchema,
  type Page,
  type ScanFailureDto,
  type ScanJobDto,
  type ScanStatusDto,
} from '@bpmix/api';
import { Roles } from '../auth/principal.js';
import { ScannerService } from './scanner.service.js';

function fileIdFromKey(key: string): string {
  try {
    return decodeTrackKey(key);
  } catch {
    throw new BadRequestException('Malformed track key');
  }
}

@Roles('ADMIN')
@Controller('api/v1/scan')
export class ScannerController {
  constructor(private readonly scanner: ScannerService) {}

  @Get()
  status(): Promise<ScanStatusDto> {
    return this.scanner.status();
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
