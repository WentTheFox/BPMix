import { Module } from '@nestjs/common';
import { PagesController } from './pages.controller.js';

@Module({ controllers: [PagesController] })
export class PagesModule {}
