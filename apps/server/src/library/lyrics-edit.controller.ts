import { Body, Controller, Get, HttpCode, Param, Put } from '@nestjs/common';
import { lyricsAssignRequestSchema, lyricsSaveRequestSchema, type LyricsSourceDto } from '@bpmix/api';
import { DeviceAccessible, Roles } from '../auth/principal.js';
import { fileIdFromKey } from '../common/trackKeys.js';
import { parseInput } from '../common/zod.js';
import { LibraryService } from './library.service.js';

/**
 * Changing the lyrics of the shared library: which .lrc a track uses, and the contents of that file.
 * Admins only (it changes what everyone sees), also from the apps via a device token.
 */
@Roles('ADMIN')
@DeviceAccessible()
@Controller('api/v1/tracks/:key/lyrics')
export class LyricsEditController {
  constructor(private readonly library: LibraryService) {}

  @Get('source')
  source(@Param('key') key: string): Promise<LyricsSourceDto> {
    return this.library.lyricsSource(fileIdFromKey(key));
  }

  @HttpCode(204)
  @Put('assignment')
  async assign(@Param('key') key: string, @Body() body: unknown): Promise<void> {
    await this.library.assignLyrics(fileIdFromKey(key), parseInput(lyricsAssignRequestSchema, body).lrcFileId);
  }

  @HttpCode(204)
  @Put()
  async save(@Param('key') key: string, @Body() body: unknown): Promise<void> {
    await this.library.saveLyrics(fileIdFromKey(key), parseInput(lyricsSaveRequestSchema, body).lines);
  }
}
