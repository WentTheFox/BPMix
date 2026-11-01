import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_VERSION_HEADER } from '@beatseam/api';
import { AuthConfig } from './auth.config.js';
import { AuthService } from './auth.service.js';
import { SESSION_COOKIE, readCookie } from './cookies.js';
import { ALLOW_UNENROLLED, DEVICE_ACCESSIBLE, IS_PUBLIC, ROLES, type AuthedRequest } from './principal.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match?.[1];
}

/**
 * Runs for every route. Authenticates a session cookie or a device bearer token, then enforces the
 * route's decorators: @Public, @AllowUnenrolled, @DeviceAccessible, @Roles. It also refuses
 * cross-site writes, which a cookie alone would otherwise let through.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly config: AuthConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const flag = (key: string) => this.reflector.getAllAndOverride<boolean>(key, [context.getHandler(), context.getClass()]) === true;
    const unsafe = !SAFE_METHODS.has(req.method);

    // Browsers attach Origin to cross-origin writes; one that isn't ours is somebody else's page.
    const origin = req.headers.origin;
    if (unsafe && origin && !this.config.allowedOrigins(req).includes(origin)) throw new ForbiddenException('Cross-origin request refused');

    const bearer = bearerToken(req.headers.authorization);
    const principal = await this.auth.authenticate(bearer ? { bearerToken: bearer } : { sessionToken: readCookie(req.headers.cookie, SESSION_COOKIE) });
    if (principal) req.principal = principal;
    if (flag(IS_PUBLIC)) return true;
    if (!principal) throw new UnauthorizedException('Sign in required');

    if (principal.kind === 'device' && !flag(DEVICE_ACCESSIBLE)) throw new ForbiddenException('This device token cannot be used for that');
    // A cross-site form can send cookies but can't add a custom header without a CORS preflight.
    if (principal.kind === 'session' && unsafe && !req.headers[API_VERSION_HEADER.toLowerCase()]) {
      throw new ForbiddenException(`Missing ${API_VERSION_HEADER} header`);
    }
    if (!principal.user.enrolled && !flag(ALLOW_UNENROLLED)) {
      throw new ForbiddenException({ code: 'enrollment_required', message: 'Finish setting up how you sign in first' });
    }
    const roles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES, [context.getHandler(), context.getClass()]);
    if (roles && !roles.includes(principal.user.role)) throw new ForbiddenException('Not allowed');
    return true;
  }
}
