import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LibraryStore } from '@bpmix/core';
import { createPrismaClient, type PrismaClient } from './prisma.js';
import { createPrismaLibraryStore } from './prismaLibraryStore.js';

/** Owns the process-wide Prisma client; other modules inject this instead of constructing their own. */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly prisma: PrismaClient;
  /** For the few things Prisma can't do (LISTEN/NOTIFY needs a dedicated connection). */
  readonly connectionString: string;
  /** The shared library, as @bpmix/core's LibraryStore, for running core's scanners server-side. */
  readonly libraryStore: LibraryStore;

  constructor(config: ConfigService) {
    const url = config.get<string>('DATABASE_URL');
    if (!url) throw new Error('DATABASE_URL is not set');
    this.connectionString = url;
    this.prisma = createPrismaClient(url);
    this.libraryStore = createPrismaLibraryStore(this.prisma);
  }

  onModuleDestroy(): Promise<void> {
    return this.prisma.$disconnect();
  }
}

@Global()
@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
