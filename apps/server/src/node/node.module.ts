import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createNodeFileAccess, type NodeFileAccess } from './nodeFileAccess.js';

export const FILE_ACCESS = Symbol('FILE_ACCESS');
export type { NodeFileAccess };

/** The server's view of its mounted music volumes, shared by the scanner and the file-serving routes. */
@Global()
@Module({
  providers: [
    {
      provide: FILE_ACCESS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): NodeFileAccess => {
        // Comma-separated top-level subdirectory names (under the library root) that hold only
        // .lrc files rather than playable tracks - see BPMIX_LYRICS_ROOTS in the README.
        const lyricsRoots = new Set(
          (config.get<string>('BPMIX_LYRICS_ROOTS') ?? '')
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0),
        );
        return createNodeFileAccess(config.get<string>('BPMIX_LIBRARY_ROOT') ?? '/music', lyricsRoots);
      },
    },
  ],
  exports: [FILE_ACCESS],
})
export class NodeModule {}
