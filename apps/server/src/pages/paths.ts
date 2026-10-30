/** Pages served by the server itself for sign-in and account management (not the web app). */
export const ACCOUNT_PAGE_PATHS = ['/login', '/setup', '/enroll', '/device', '/account'] as const;
export const ACCOUNT_ASSETS_PREFIX = '/account-assets/';

export function isAccountPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return (ACCOUNT_PAGE_PATHS as readonly string[]).includes(path) || pathname.startsWith(ACCOUNT_ASSETS_PREFIX);
}
