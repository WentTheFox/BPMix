import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import {
  lastFmNowPlayingRequestSchema,
  lastFmScrobblesRequestSchema,
  type LastFmConnectResultDto,
  type LastFmStatusDto,
} from '@bpmix/api';
import { CurrentPrincipal, DeviceAccessible, type Principal } from '../auth/principal.js';
import { parseInput } from '../common/zod.js';
import { LastFmService } from './lastfm.service.js';

// The apps use these with a device token as well as a browser session.
@DeviceAccessible()
@Controller('api/v1/lastfm')
export class LastFmController {
  constructor(private readonly lastFm: LastFmService) {}

  @Get()
  status(@CurrentPrincipal() principal: Principal): Promise<LastFmStatusDto> {
    return this.lastFm.status(principal.user.id);
  }

  @HttpCode(200)
  @Post('connect')
  connect(@CurrentPrincipal() principal: Principal): Promise<LastFmConnectResultDto> {
    return this.lastFm.connect(principal.user.id);
  }

  @HttpCode(200)
  @Post('complete')
  complete(@CurrentPrincipal() principal: Principal): Promise<LastFmStatusDto> {
    return this.lastFm.complete(principal.user.id);
  }

  @Delete()
  disconnect(@CurrentPrincipal() principal: Principal): Promise<LastFmStatusDto> {
    return this.lastFm.disconnect(principal.user.id);
  }

  @HttpCode(204)
  @Post('now-playing')
  async nowPlaying(@Body() body: unknown, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.lastFm.nowPlaying(principal.user.id, parseInput(lastFmNowPlayingRequestSchema, body));
  }

  @HttpCode(204)
  @Post('scrobbles')
  async scrobble(@Body() body: unknown, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.lastFm.scrobble(principal.user.id, parseInput(lastFmScrobblesRequestSchema, body).entries);
  }
}
