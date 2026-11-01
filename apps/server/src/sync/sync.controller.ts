import { Controller, Get, Query } from '@nestjs/common';
import { syncChangesQuerySchema, syncSnapshotQuerySchema, type SyncChangesResponseDto, type SyncSnapshotResponseDto } from '@beatseam/api';
import { CurrentPrincipal, DeviceAccessible, type Principal } from '../auth/principal.js';
import { parseInput } from '../common/zod.js';
import { SyncService } from './sync.service.js';

/**
 * How clients stay current: one `changes` call per check-in (at app start, or when the user asks
 * for a resync), or a `snapshot` the first time and whenever `changes` answers 410.
 */
@DeviceAccessible()
@Controller('api/v1/sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get('changes')
  changes(@Query() query: Record<string, unknown>, @CurrentPrincipal() principal: Principal): Promise<SyncChangesResponseDto> {
    const { since, limit } = parseInput(syncChangesQuerySchema, query);
    return this.sync.changesSince(BigInt(since), limit, principal.user.id);
  }

  @Get('snapshot')
  snapshot(@Query() query: Record<string, unknown>, @CurrentPrincipal() principal: Principal): Promise<SyncSnapshotResponseDto> {
    const { after, limit } = parseInput(syncSnapshotQuerySchema, query);
    return this.sync.snapshot(after, limit, principal.user.id);
  }
}
