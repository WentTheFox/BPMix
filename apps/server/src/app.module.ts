import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './db/database.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ScheduleModule.forRoot(), DatabaseModule],
  controllers: [HealthController],
})
export class AppModule {}
