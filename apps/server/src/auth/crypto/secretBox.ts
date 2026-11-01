import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const VERSION = 'v1';

/** Seals small secrets (TOTP seeds) so a copy of the database alone doesn't reveal them. AES-256-GCM. */
export class SecretBox {
  private readonly key: Buffer;

  /** `keyMaterial` is any string or bytes of decent entropy; it's stretched to a 256-bit key. */
  constructor(keyMaterial: string | Uint8Array) {
    this.key = Buffer.from(hkdfSync('sha256', keyMaterial, 'beatseam-secret-box', 'aes-256-gcm', 32));
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  /** Throws if the value was tampered with or sealed under a different key. */
  open(sealed: string): string {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error('Unrecognised sealed value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }
}

/**
 * The server secret: BEATSEAM_SECRET_KEY if set, otherwise a random key generated
 * once and kept in the data directory (a volume, so it survives restarts and
 * stays apart from the database it protects).
 */
export async function loadSecretKey(configured: string | undefined, dataDir: string): Promise<string> {
  if (configured) return configured;
  const keyFile = path.join(dataDir, 'secret.key');
  try {
    return (await readFile(keyFile, 'utf8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await mkdir(dataDir, { recursive: true });
  const key = randomBytes(32).toString('hex');
  // 'wx' so two processes starting together can't overwrite each other's key.
  try {
    await writeFile(keyFile, `${key}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return (await readFile(keyFile, 'utf8')).trim();
    throw err;
  }
  await chmod(keyFile, 0o600);
  return key;
}
