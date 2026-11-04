import { z } from 'zod';

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, '3-32 characters: letters, digits, dot, dash or underscore');
export const displayNameSchema = z.string().trim().min(1).max(64);
export const roleSchema = z.enum(['ADMIN', 'USER']);
export type RoleDto = z.infer<typeof roleSchema>;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters`).max(MAX_PASSWORD_LENGTH);
export const totpCodeSchema = z.string().trim().regex(/^\d{6}$/, 'A 6-digit code');

export const authStatusSchema = z.object({
  /** True until the first account is fully set up; the first sign-up becomes the admin. */
  setupRequired: z.boolean(),
  /** Whether that first sign-up also needs the server's BEATSEAM_SETUP_TOKEN. */
  setupTokenRequired: z.boolean(),
});
export type AuthStatusDto = z.infer<typeof authStatusSchema>;

export const setupRequestSchema = z.object({ username: usernameSchema, displayName: displayNameSchema, setupToken: z.string().optional() });
export const redeemInviteRequestSchema = z.object({ inviteToken: z.string().min(1) });
export const passwordLoginRequestSchema = z.object({ username: z.string().trim().toLowerCase().min(1), password: z.string().min(1).max(MAX_PASSWORD_LENGTH) });
export const totpLoginRequestSchema = z
  .object({ mfaToken: z.string().min(1), code: totpCodeSchema.optional(), recoveryCode: z.string().trim().min(1).max(32).optional() })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), { message: 'Send either code or recoveryCode' });
export const setPasswordRequestSchema = z.object({ password: passwordSchema });
export const totpCodeRequestSchema = z.object({ code: totpCodeSchema });
export const createUserRequestSchema = z.object({ username: usernameSchema, displayName: displayNameSchema, role: roleSchema.default('USER') });
export const updateUserRequestSchema = z.object({ displayName: displayNameSchema.optional(), role: roleSchema.optional(), disabled: z.boolean().optional() });

export const passkeySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  deviceType: z.string(),
  backedUp: z.boolean(),
  createdAtMs: z.number(),
  lastUsedAtMs: z.number().nullable(),
});
export type PasskeySummaryDto = z.infer<typeof passkeySummarySchema>;

export const meSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: roleSchema,
  /** Can sign in again later: has a passkey, or a password plus TOTP. An unenrolled session can only set those up. */
  enrolled: z.boolean(),
  hasPassword: z.boolean(),
  totpEnabled: z.boolean(),
  passkeys: z.array(passkeySummarySchema),
  recoveryCodesRemaining: z.number(),
  /** When this session last proved who it is; sensitive changes need this to be recent. */
  authenticatedAtMs: z.number().nullable(),
  /** When that sign-in stops counting as recent for credential changes (authenticatedAtMs plus the server's window); null if it never does (a device token). */
  freshUntilMs: z.number().nullable(),
  /** The server's clock when this was answered, so a client can correct for its own clock being off. */
  serverTimeMs: z.number(),
  /** 'device' for a native app's bearer token. */
  via: z.enum(['session', 'device']),
});
export type MeDto = z.infer<typeof meSchema>;

export const userSummarySchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: roleSchema,
  disabled: z.boolean(),
  enrolled: z.boolean(),
  createdAtMs: z.number(),
});
export type UserSummaryDto = z.infer<typeof userSummarySchema>;

/** The invite token is shown once; whoever opens `/enroll?token=…` (or posts it to /auth/invites/redeem) can set up the account. */
export const inviteResultSchema = z.object({ inviteToken: z.string(), expiresAtMs: z.number() });
export type InviteResultDto = z.infer<typeof inviteResultSchema>;

export const createUserResultSchema = z.object({ user: userSummarySchema, invite: inviteResultSchema });
export type CreateUserResultDto = z.infer<typeof createUserResultSchema>;

export const sessionSummarySchema = z.object({
  id: z.string(),
  createdAtMs: z.number(),
  lastSeenAtMs: z.number(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  current: z.boolean(),
});
export type SessionSummaryDto = z.infer<typeof sessionSummarySchema>;

export const loginResultSchema = z.union([
  z.object({ status: z.literal('ok'), me: meSchema }),
  /** Password accepted; now needs a TOTP or recovery code. */
  z.object({ status: z.literal('mfa_required'), mfaToken: z.string() }),
]);
export type LoginResultDto = z.infer<typeof loginResultSchema>;

export const totpSetupSchema = z.object({ secret: z.string(), otpauthUri: z.string() });
export type TotpSetupDto = z.infer<typeof totpSetupSchema>;

export const recoveryCodesSchema = z.object({ recoveryCodes: z.array(z.string()) });

// ---- Passkeys (WebAuthn). The browser/OS API produces and consumes these JSON shapes; the server only passes them through to the verifier.

const webauthnJsonSchema = z.record(z.string(), z.unknown());

export const passkeyRegisterVerifyRequestSchema = z.object({
  /** The RegistrationResponseJSON from `navigator.credentials.create()` (e.g. via @simplewebauthn/browser). */
  response: webauthnJsonSchema,
  name: z.string().trim().min(1).max(64).optional(),
});
export const passkeyRenameRequestSchema = z.object({ name: z.string().trim().min(1).max(64) });
export const passkeyLoginVerifyRequestSchema = z.object({
  challengeId: z.string().min(1),
  /** The AuthenticationResponseJSON from `navigator.credentials.get()`. */
  response: webauthnJsonSchema,
});

export const passkeyLoginOptionsSchema = z.object({
  /** Echo back with the signed response. */
  challengeId: z.string(),
  /** PublicKeyCredentialRequestOptionsJSON. No allowed-credentials list: the user picks a passkey from their device. */
  options: webauthnJsonSchema,
});
export type PasskeyLoginOptionsDto = z.infer<typeof passkeyLoginOptionsSchema>;

// ---- Device sign-in for native apps (RFC 8628-style): the app shows a code, the user approves it in a signed-in browser.

export const deviceNameSchema = z.string().trim().min(1).max(64);
export const deviceCodeRequestSchema = z.object({ deviceName: deviceNameSchema });
export const deviceCodeResultSchema = z.object({
  /** Secret the app keeps and uses to wait for approval. Never shown to the user. */
  deviceCode: z.string(),
  /** Short code the user reads off the app and enters (or confirms) in the browser. */
  userCode: z.string(),
  /** Where to send the user, with the code filled in. */
  verificationUri: z.string(),
  expiresInSeconds: z.number(),
});
export type DeviceCodeResultDto = z.infer<typeof deviceCodeResultSchema>;

export const deviceWaitRequestSchema = z.object({ deviceCode: z.string().min(1) });
export const deviceWaitResultSchema = z.discriminatedUnion('status', [
  /** Not decided yet - ask again straight away (the request is held open, so this is a long-poll, not a timer). */
  z.object({ status: z.literal('pending') }),
  /** Shown once: the bearer token for `Authorization: Bearer ...`. */
  z.object({ status: z.literal('approved'), token: z.string(), me: meSchema }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
]);
export type DeviceWaitResultDto = z.infer<typeof deviceWaitResultSchema>;

export const deviceLookupSchema = z.object({ deviceName: z.string(), requestedAtMs: z.number() });
export type DeviceLookupDto = z.infer<typeof deviceLookupSchema>;
export const deviceApproveRequestSchema = z.object({ userCode: z.string().trim().min(1).max(32), approve: z.boolean() });

export const deviceTokenSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAtMs: z.number(),
  lastUsedAtMs: z.number().nullable(),
});
export type DeviceTokenSummaryDto = z.infer<typeof deviceTokenSummarySchema>;
