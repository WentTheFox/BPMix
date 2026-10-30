import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LastFmController } from './lastfm.controller.js';
import { LASTFM_FETCH, LastFmService } from './lastfm.service.js';

@Module({ imports: [AuthModule], controllers: [LastFmController], // undefined = the real fetch; registered so tests can swap in a stand-in for Last.fm.
  providers: [LastFmService, { provide: LASTFM_FETCH, useValue: undefined }], exports: [LastFmService] })
export class LastFmModule {}
