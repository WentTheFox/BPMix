import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface PrincipalUser {
  id: string;
  username: string;
  displayName: string;
  role: 'ADMIN' | 'USER';
  /** Has a way to sign in again (a passkey, or password + TOTP). */
  enrolled: boolean;
}

/** Who is making a request, once the guard has authenticated it. */
export interface Principal {
  kind: 'session' | 'device';
  user: PrincipalUser;
  /** Session id (the stored hash), for `kind: 'session'`. */
  sessionId?: string;
  /** When the session last signed in. */
  authenticatedAt?: Date;
  deviceTokenId?: string;
}

export type AuthedRequest = Request & { principal?: Principal };

export const IS_PUBLIC = 'auth:public';
export const ALLOW_UNENROLLED = 'auth:allowUnenrolled';
export const DEVICE_ACCESSIBLE = 'auth:deviceAccessible';
export const ROLES = 'auth:roles';

/** No sign-in needed. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Reachable by someone signed in who hasn't finished setting up a way to sign in again (the enrollment endpoints). */
export const AllowUnenrolled = () => SetMetadata(ALLOW_UNENROLLED, true);
/** Native apps' bearer tokens may call this. Everything else is browser-session only. */
export const DeviceAccessible = () => SetMetadata(DEVICE_ACCESSIBLE, true);
export const Roles = (...roles: ('ADMIN' | 'USER')[]) => SetMetadata(ROLES, roles);

export const CurrentPrincipal = createParamDecorator((_data: unknown, context: ExecutionContext): Principal => {
  const principal = context.switchToHttp().getRequest<AuthedRequest>().principal;
  if (!principal) throw new Error('CurrentPrincipal used on a route the auth guard did not authenticate');
  return principal;
});
