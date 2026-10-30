import { BadRequestException, Controller, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { listTracksQuerySchema, type Page, type PlaylistDto, type RootDto, type TrackDto } from '@bpmix/api';
import { DeviceAccessible } from '../auth/principal.js';
import { fileIdFromKey } from '../common/trackKeys.js';
import { LibraryService } from './library.service.js';

// Any signed-in user, including a native app's device token.
@DeviceAccessible()
@Controller('api/v1')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @Get('roots')
  roots(): Promise<RootDto[]> {
    return this.library.listRoots();
  }

  @Get('tracks')
  tracks(@Query() query: Record<string, unknown>): Promise<Page<TrackDto>> {
    const parsed = listTracksQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    return this.library.listTracks(parsed.data);
  }

  @Get('tracks/:key')
  async track(@Param('key') key: string): Promise<TrackDto> {
    const track = await this.library.getTrack(fileIdFromKey(key));
    if (!track) throw new NotFoundException('No such track');
    return track;
  }

  /** The original file. sendFile gives Range, conditional requests and the right Content-Type for free. */
  @Get('tracks/:key/stream')
  async stream(@Param('key') key: string, @Res() res: Response): Promise<void> {
    const audioPath = await this.library.resolveAudioPath(fileIdFromKey(key));
    if (!audioPath) throw new NotFoundException('No such track');
    await new Promise<void>((resolve, reject) => {
      res.sendFile(audioPath, { dotfiles: 'allow', acceptRanges: true, headers: { 'Cache-Control': 'private, no-cache' } }, (err) => (err ? reject(err) : resolve()));
    });
  }

  @Get('tracks/:key/cover')
  async cover(@Param('key') key: string, @Res() res: Response): Promise<void> {
    const art = await this.library.getCover(fileIdFromKey(key));
    if (!art) throw new NotFoundException('No cover art');
    res.type(art.mimeType).set('Cache-Control', 'private, max-age=86400').send(Buffer.from(art.data));
  }

  @Get('playlists')
  playlists(@Query('rootId') rootId?: string): Promise<PlaylistDto[]> {
    return this.library.listPlaylists(rootId);
  }

  @Get('playlists/:key')
  async playlist(@Param('key') key: string): Promise<PlaylistDto> {
    const playlist = await this.library.getPlaylist(fileIdFromKey(key));
    if (!playlist) throw new NotFoundException('No such playlist');
    return playlist;
  }
}
