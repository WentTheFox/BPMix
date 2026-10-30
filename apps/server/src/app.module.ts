import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './db/database.module.js';
import { NodeModule } from './node/node.module.js';
import { ScannerModule } from './scanner/scanner.module.js';
import { LibraryModule } from './library/library.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ScheduleModule.forRoot(), DatabaseModule, NodeModule, ScannerModule, LibraryModule],
  controllers: [HealthController],
})
export class AppModule {}
