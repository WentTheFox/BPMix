import { Module } from '@nestjs/common';
import { MutationsController } from './mutations.controller.js';
import { UserDataService } from './userdata.service.js';

@Module({ controllers: [MutationsController], providers: [UserDataService], exports: [UserDataService] })
export class UserDataModule {}
