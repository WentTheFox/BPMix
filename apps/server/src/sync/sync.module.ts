import { Module } from '@nestjs/common';
import { LibraryModule } from '../library/library.module.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

@Module({ imports: [LibraryModule], controllers: [SyncController], providers: [SyncService], exports: [SyncService] })
export class SyncModule {}
