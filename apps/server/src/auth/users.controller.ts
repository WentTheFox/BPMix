import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  createUserRequestSchema,
  updateUserRequestSchema,
  type CreateUserResultDto,
  type InviteResultDto,
  type UserSummaryDto,
} from '@bpmix/api';
import { parseInput } from '../common/zod.js';
import { AuthService } from './auth.service.js';
import { CurrentPrincipal, Roles, type Principal } from './principal.js';

/** Account administration. There is no open registration: this is how anyone after the first admin gets an account. */
@Roles('ADMIN')
@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  list(): Promise<UserSummaryDto[]> {
    return this.auth.listUsers();
  }

  /** Creates the account and returns a one-time enrollment link token (shown once) for its owner. */
  @Post()
  create(@Body() body: unknown, @CurrentPrincipal() principal: Principal): Promise<CreateUserResultDto> {
    this.auth.requireFreshAuth(principal);
    return this.auth.createUser(parseInput(createUserRequestSchema, body), principal.user.id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown, @CurrentPrincipal() principal: Principal): Promise<UserSummaryDto> {
    this.auth.requireFreshAuth(principal);
    return this.auth.updateUser(id, parseInput(updateUserRequestSchema, body), principal.user.id);
  }

  /** A replacement enrollment link, e.g. for someone who lost every credential. */
  @Post(':id/invite')
  invite(@Param('id') id: string, @CurrentPrincipal() principal: Principal): Promise<InviteResultDto> {
    this.auth.requireFreshAuth(principal);
    return this.auth.createInvite(id, principal.user.id);
  }
}
