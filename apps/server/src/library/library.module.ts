import { Module } from '@nestjs/common';
import { LibraryController } from './library.controller.js';
import { LibraryService } from './library.service.js';
import { LyricsEditController } from './lyrics-edit.controller.js';
import { LyricsReportController } from './lyrics-report.controller.js';

@Module({ controllers: [LibraryController, LyricsEditController, LyricsReportController], providers: [LibraryService], exports: [LibraryService] })
export class LibraryModule {}
