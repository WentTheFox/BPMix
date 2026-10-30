import { Module } from '@nestjs/common';
import { LibraryModule } from '../library/library.module.js';
import { UserDataModule } from '../userdata/userdata.module.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

@Module({ imports: [LibraryModule, UserDataModule], controllers: [SyncController], providers: [SyncService], exports: [SyncService] })
export class SyncModule {}
