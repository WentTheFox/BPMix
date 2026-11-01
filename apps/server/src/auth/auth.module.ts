import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthConfig } from './auth.config.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService, CLOCK, SECRET_BOX } from './auth.service.js';
import { loadSecretKey, SecretBox } from './crypto/secretBox.js';
import { DeviceService } from './device.service.js';
import { PasskeyService } from './passkey.service.js';
import { UsersController } from './users.controller.js';

@Module({
  controllers: [AuthController, UsersController],
  providers: [
    AuthConfig,
    AuthService,
    PasskeyService,
    DeviceService,
    AuthGuard,
    { provide: CLOCK, useValue: () => Date.now() },
    {
      provide: SECRET_BOX,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) =>
        new SecretBox(await loadSecretKey(config.get<string>('BEATSEAM_SECRET_KEY'), config.get<string>('BEATSEAM_DATA_DIR') ?? './data')),
    },
  ],
  exports: [AuthService, AuthConfig, AuthGuard, SECRET_BOX],
})
export class AuthModule {}
