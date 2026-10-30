import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// ---- Just enough CBOR to build an attestation object and a COSE key.
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  return Buffer.from([(major << 5) | 25, value >> 8, value & 0xff]);
}

function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

/** What `PublicKeyCredentialCreationOptionsJSON`/`RequestOptionsJSON` carry that the authenticator needs. */
interface ChallengeOptions {
  challenge: string;
}

export interface SoftAuthenticatorOptions {
  /** The relying-party id the authenticator will scope its credential to (the site's hostname). */
  rpId: string;
  /** The origin it reports in clientData (the site's origin). */
  origin: string;
}

/**
 * A software WebAuthn authenticator (platform-style, ES256, "none" attestation) that produces the
 * same JSON a browser would hand to the server, so the real verifier is exercised end to end.
 */
export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  /** Signature counter. A synced passkey always reports 0; a hardware-style key (synced = false) counts up on every assertion. */
  counter = 0;
  /** Backup-eligible / backed-up flags, like a synced passkey (which also never counts). */
  synced = true;
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  userHandle: Buffer | null = null;

  constructor(private readonly site: SoftAuthenticatorOptions) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.publicJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private flags(extra: number, userVerified: boolean): number {
    return 0x01 | (userVerified ? 0x04 : 0) | (this.synced ? 0x08 | 0x10 : 0) | extra;
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin = this.site.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** navigator.credentials.create(), returning a RegistrationResponseJSON. */
  create(options: ChallengeOptions & { user?: { id: string } }, opts: { userVerified?: boolean; origin?: string } = {}) {
    const userVerified = opts.userVerified ?? true;
    this.userHandle = options.user?.id ? Buffer.from(options.user.id, 'base64url') : this.userHandle;
    const coseKey = new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(this.publicJwk.x, 'base64url')],
      [-3, Buffer.from(this.publicJwk.y, 'base64url')],
    ]);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const credentialIdLength = Buffer.alloc(2);
    credentialIdLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(this.site.rpId),
      Buffer.from([this.flags(0x40, userVerified)]),
      counter,
      Buffer.alloc(16), // AAGUID
      credentialIdLength,
      this.credentialId,
      cbor(coseKey),
    ]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge, opts.origin)),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** navigator.credentials.get(), returning an AuthenticationResponseJSON. */
  get(options: ChallengeOptions, opts: { userVerified?: boolean; origin?: string; counter?: number } = {}) {
    if (opts.counter === undefined && !this.synced) this.counter += 1;
    const counterValue = opts.counter ?? this.counter;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(counterValue);
    const authData = Buffer.concat([sha256(this.site.rpId), Buffer.from([this.flags(0, opts.userVerified ?? true)]), counter]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, opts.origin);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), { key: this.privateKey, dsaEncoding: 'der' });
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(this.userHandle ? { userHandle: b64u(this.userHandle) } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
