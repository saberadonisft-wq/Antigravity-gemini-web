import { z } from "zod";

/** A single email is stable across avatar, display-name and locale changes. */
export function accountIdentityEmail(identity: unknown): string | undefined {
  if (typeof identity !== "string") return undefined;
  const emails = [...new Set((identity.match(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/g) ?? []).map(email => email.toLowerCase()))];
  return emails.length === 1 ? emails[0] : undefined;
}

export const AccountCapabilityStatusSchema = z.enum([
  "unknown",
  "observed",
  "verified",
  "unsupported",
]);
export type AccountCapabilityStatus = z.infer<typeof AccountCapabilityStatusSchema>;

export const AccountCapabilitySchema = z.object({
  status: AccountCapabilityStatusSchema,
  observedAt: z.string().optional(),
  detail: z.string().optional(),
}).strict();
export type AccountCapability = z.infer<typeof AccountCapabilitySchema>;

export const AccountRecordSchema = z.object({
  accountId: z.string().regex(/^[a-zA-Z0-9_-]{4,64}$/),
  displayName: z.string().min(1).max(128),
  profilePath: z.string().min(1),
  statePath: z.string().min(1),
  debugPort: z.number().int().min(1024).max(65535),
  identityFingerprint: z.string().min(1).max(128).optional(),
  identityEpoch: z.number().int().nonnegative().default(0),
  enabled: z.boolean().default(true),
  capabilities: z.record(z.string(), AccountCapabilitySchema).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type AccountRecord = z.infer<typeof AccountRecordSchema>;

export const AccountRuntimeStatusSchema = z.enum([
  "unverified",
  "ready",
  "login_required",
  "identity_mismatch",
  "busy",
  "unavailable",
  "cooldown",
]);
export type AccountRuntimeStatus = z.infer<typeof AccountRuntimeStatusSchema>;

export const AccountRuntimeStateSchema = z.object({
  accountId: z.string(),
  status: AccountRuntimeStatusSchema,
  workerIdentity: z.string().optional(),
  reason: z.string().optional(),
  observedAt: z.string(),
}).strict();
export type AccountRuntimeState = z.infer<typeof AccountRuntimeStateSchema>;

export const AccountRegistryFileSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().default(0),
  activeAccountId: z.union([z.literal(""), z.string().regex(/^[a-zA-Z0-9_-]{4,64}$/)]),
  accounts: z.array(AccountRecordSchema).max(32),
}).strict().superRefine((value, context) => {
  const active = value.accounts.find(account => account.accountId === value.activeAccountId);
  if (value.activeAccountId ? !active?.enabled : value.accounts.some(account => account.enabled)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["activeAccountId"], message: "Active account must be enabled, or empty when all accounts are disabled." });
  }
});
export type AccountRegistryFile = z.infer<typeof AccountRegistryFileSchema>;

export const AccountControlRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  ...(["use", "enable", "disable"] as const).map(action => z.object({
    action: z.literal(action), accountId: z.string().regex(/^[a-zA-Z0-9_-]{4,64}$/), expectedRevision: z.number().int().nonnegative().optional(),
  }).strict()),
  z.object({ action: z.literal("verify"), accountId: z.string().regex(/^[a-zA-Z0-9_-]{4,64}$/) }).strict(),
]);
