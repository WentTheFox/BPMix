import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ScannerService, type ScanStatus } from './scanner.service.js';

// TODO(auth): admin-only once the auth module lands.
@Controller('api/v1/scan')
export class ScannerController {
  constructor(private readonly scanner: ScannerService) {}

  @Get()
  status(): ScanStatus {
    return this.scanner.status();
  }

  /** Kicks off a scan (or joins the running one) and returns immediately. */
  @Post()
  @HttpCode(202)
  start(): ScanStatus {
    void this.scanner.scanAll().catch(() => undefined);
    return { ...this.scanner.status(), running: true };
  }
}
