import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { lyricsReportRequestSchema, type LyricsReportDto } from '@beatseam/api';
import { CurrentPrincipal, DeviceAccessible, Roles, type Principal } from '../auth/principal.js';
import { fileIdFromKey } from '../common/trackKeys.js';
import { parseInput } from '../common/zod.js';
import { LibraryService } from './library.service.js';

/** "These lyrics are wrong": any signed-in user (also from the apps) can flag a track; admins review the list. */
@DeviceAccessible()
@Controller('api/v1')
export class LyricsReportController {
  constructor(private readonly library: LibraryService) {}

  @HttpCode(204)
  @Post('tracks/:key/lyrics/report')
  async report(@Param('key') key: string, @Body() body: unknown, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.library.reportLyrics(fileIdFromKey(key), principal.user.id, parseInput(lyricsReportRequestSchema, body ?? {}).reason);
  }

  @Roles('ADMIN')
  @Get('lyrics/reports')
  reports(): Promise<LyricsReportDto[]> {
    return this.library.lyricsReports();
  }

  @Roles('ADMIN')
  @HttpCode(204)
  @Delete('lyrics/reports/:id')
  async resolve(@Param('id') id: string): Promise<void> {
    await this.library.resolveLyricsReport(id);
  }
}
