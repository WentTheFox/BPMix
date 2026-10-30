import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthThrottlerGuard } from './auth/auth.throttler.js';
import { DatabaseModule } from './db/database.module.js';
import { NodeModule } from './node/node.module.js';
import { ScannerModule } from './scanner/scanner.module.js';
import { LibraryModule } from './library/library.module.js';
import { UserDataModule } from './userdata/userdata.module.js';
import { SyncModule } from './sync/sync.module.js';
import { PagesModule } from './pages/pages.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // A generous overall ceiling; the sign-in routes set their own, much stricter, limit (see auth.controller.ts).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1200 }]),
    DatabaseModule,
    AuthModule,
    PagesModule, NodeModule, ScannerModule, LibraryModule, UserDataModule, SyncModule],
  controllers: [HealthController],
  // Order matters: throttle first, then authenticate.
  providers: [
    { provide: APP_GUARD, useClass: AuthThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
