import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Public } from '../auth/principal.js';
import { ACCOUNT_PAGE_PATHS } from './paths.js';

// Everything on these pages is the server's own: no inline script or style, no other origin. Pages
// also carry short-lived secrets in the address bar (enrollment links), so they're never cached and
// never sent on as a referrer.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
} as const;

// These paths are chosen by the server, never by the request. `dotfiles: allow` is needed because the
// webauthn bundle lives under node_modules/.pnpm, which sendFile would otherwise refuse as a dot-path.
const SEND_OPTIONS = { dotfiles: 'allow' } as const;

const ASSETS: Record<string, string> = {
  'account.css': 'text/css; charset=utf-8',
  'account.js': 'text/javascript; charset=utf-8',
};

/**
 * Where sign-in, first-run setup, enrollment links, device approval and account management happen
 * in a browser. Plain HTML and one script (see apps/server/public), so it works the same whether or
 * not the web app is deployed, and gives native apps one link to send people to.
 */
@Public()
@Controller()
export class PagesController {
  private readonly publicDir: string;
  private readonly webauthnBundle: string;

  constructor(config: ConfigService) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // Bundled, this file is dist/main.js; from source it's src/pages/. Either way `public/` is the package's own.
    this.publicDir =
      config.get<string>('BPMIX_PUBLIC_DIR') ??
      [path.resolve(here, '../public'), path.resolve(here, '../../public')].find((dir) => existsSync(path.join(dir, 'account.html'))) ??
      path.resolve(here, '../public');
    // The browser half of @simplewebauthn, as its prebuilt single-file bundle.
    const entry = createRequire(import.meta.url).resolve('@simplewebauthn/browser');
    this.webauthnBundle = path.resolve(path.dirname(entry), '../dist/bundle/index.umd.min.js');
  }

  @Get(ACCOUNT_PAGE_PATHS.map((p) => p.slice(1)))
  page(@Res() res: Response): void {
    res.set(SECURITY_HEADERS).type('text/html; charset=utf-8').sendFile(path.join(this.publicDir, 'account.html'), SEND_OPTIONS);
  }

  @Get('account-assets/webauthn.js')
  webauthn(@Res() res: Response): void {
    res.set({ ...SECURITY_HEADERS, 'Cache-Control': 'public, max-age=3600' }).type('text/javascript; charset=utf-8').sendFile(this.webauthnBundle, SEND_OPTIONS);
  }

  @Get('account-assets/:file')
  asset(@Param('file') file: string, @Res() res: Response): void {
    const type = ASSETS[file];
    if (!type) throw new NotFoundException();
    res.set({ ...SECURITY_HEADERS, 'Cache-Control': 'no-cache' }).type(type).sendFile(path.join(this.publicDir, file), SEND_OPTIONS);
  }
}
