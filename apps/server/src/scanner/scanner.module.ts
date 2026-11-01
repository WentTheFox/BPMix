import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createAnalysisPool } from './analysisPool.js';
import { ScannerController } from './scanner.controller.js';
import { ScanWorkers, scanWorkerCount } from './scanWorkers.js';
import { ScannerService } from './scanner.service.js';
import { ANALYZE_FILE } from './tokens.js';
import { TrackProcessor } from './trackProcessor.js';

@Module({
  controllers: [ScannerController],
  providers: [
    ScannerService,
    ScanWorkers,
    TrackProcessor,
    {
      provide: ANALYZE_FILE,
      inject: [ConfigService],
      // Second tsup entry, emitted to dist/scanner/ (this module is bundled into dist/main.js, so the URL is relative to that); one analysis thread per scan worker by default.
      useFactory: (config: ConfigService) =>
        createAnalysisPool(Number(config.get('BEATSEAM_ANALYSIS_THREADS') ?? scanWorkerCount(config)), new URL('./scanner/analysisWorker.js', import.meta.url)),
    },
  ],
  exports: [ScannerService],
})
export class ScannerModule {}
