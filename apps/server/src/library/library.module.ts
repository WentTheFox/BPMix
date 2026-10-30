import { Module } from '@nestjs/common';
import { LibraryController } from './library.controller.js';
import { LibraryService } from './library.service.js';
import { LyricsEditController } from './lyrics-edit.controller.js';

@Module({ controllers: [LibraryController, LyricsEditController], providers: [LibraryService], exports: [LibraryService] })
export class LibraryModule {}
