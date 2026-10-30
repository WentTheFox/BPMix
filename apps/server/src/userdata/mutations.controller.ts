import { Body, Controller, Post } from '@nestjs/common';
import { mutationsRequestSchema, type MutationsResponseDto } from '@bpmix/api';
import { CurrentPrincipal, DeviceAccessible, type Principal } from '../auth/principal.js';
import { parseInput } from '../common/zod.js';
import { UserDataService } from './userdata.service.js';

/** Where a client flushes its offline queue. Native apps' device tokens may use it. */
@DeviceAccessible()
@Controller('api/v1/mutations')
export class MutationsController {
  constructor(private readonly userData: UserDataService) {}

  @Post()
  async apply(@Body() body: unknown, @CurrentPrincipal() principal: Principal): Promise<MutationsResponseDto> {
    const { mutations } = parseInput(mutationsRequestSchema, body);
    return { results: await this.userData.applyMutations(principal.user.id, mutations) };
  }
}
