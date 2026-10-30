import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createAnalysisPool } from './analysisPool.js';
import { ScannerController } from './scanner.controller.js';
import { ANALYZE_FILE, ScannerService } from './scanner.service.js';

@Module({
  controllers: [ScannerController],
  providers: [
    ScannerService,
    {
      provide: ANALYZE_FILE,
      inject: [ConfigService],
      // Second tsup entry, emitted to dist/scanner/ (this module is bundled into dist/main.js, so the URL is relative to that); one analysis thread per ~2 cores.
      useFactory: (config: ConfigService) =>
        createAnalysisPool(Number(config.get('BPMIX_ANALYSIS_THREADS') ?? 2), new URL('./scanner/analysisWorker.js', import.meta.url)),
    },
  ],
  exports: [ScannerService],
})
export class ScannerModule {}
