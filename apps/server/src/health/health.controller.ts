import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/principal.js';
import { DatabaseService } from '../db/database.module.js';

@Public()
@Controller('api/v1/health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async health(): Promise<{ status: 'ok'; database: 'up' }> {
    await this.db.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', database: 'up' };
  }
}
