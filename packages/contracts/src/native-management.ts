import { z } from "zod";
import { WebModelSelectionSchema } from "./transport.js";
import { NativeRoutingSettingsSchema } from "./routing.js";

const AccountId=z.string().regex(/^[a-zA-Z0-9_-]{4,64}$/);
const TaskScope=z.string().regex(/^[a-f0-9]{64}$/);
const authority={expectedOwnerId:z.string().uuid(),expectedRevision:z.number().int().nonnegative()};
export const NativeManagementCommandSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("add"),displayName:z.string().trim().min(1).max(128),browserTransport:z.enum(["cdp","extension"]).optional(),...authority}).strict(),
  ...(["open","verify","use","enable","disable"] as const).map(action=>z.object({action:z.literal(action),accountId:AccountId,...authority}).strict()),
  z.object({action:z.literal("remove"),accountId:AccountId,expectedRoutingRevision:z.number().int().nonnegative(),...authority}).strict(),
  z.object({action:z.literal("configure_routing"),settings:NativeRoutingSettingsSchema,expectedRoutingRevision:z.number().int().nonnegative(),...authority}).strict(),
  z.object({action:z.literal("resume"),url:z.string().regex(/^https:\/\/gemini\.google\.com\/app\/[a-zA-Z0-9_-]{1,128}$/),...authority}).strict(),
  z.object({action:z.literal("unbind"),taskScope:TaskScope,expectedRoutingRevision:z.number().int().nonnegative(),...authority}).strict(),
  ...(["cancel","clear_resume"] as const).map(action=>z.object({action:z.literal(action),...authority}).strict()),
]);
export type NativeManagementCommand=z.infer<typeof NativeManagementCommandSchema>;
export const NativeManagementRequestSchema=z.union([z.object({action:z.literal("status")}).strict(),NativeManagementCommandSchema]);

export const NativeExtensionPairingIntentSchema=z.object({accountId:AccountId,expectedOwnerId:z.string().uuid(),expectedRevision:z.number().int().nonnegative()}).strict();
export type NativeExtensionPairingIntent=z.infer<typeof NativeExtensionPairingIntentSchema>;
export const NativeExtensionPairingRequestSchema=NativeExtensionPairingIntentSchema.extend({action:z.literal("create")}).strict();
export const NativeExtensionPairingCodeSchema=z.string().regex(/^agc1\.[A-Za-z0-9_-]{16,2048}$/);
export const NativeExtensionPairingResultSchema=z.object({pairingCode:NativeExtensionPairingCodeSchema}).strict();

export const NativeManagementPhaseSchema=z.enum(["restoring","loading_context","processing_file","waiting","generating","stopping","completed","failed"]);
export const NativeManagementSnapshotSchema=z.object({
  service:z.literal("gemini-native-management"),version:z.literal(1),ownerId:z.string().uuid(),pid:z.number().int().positive(),runtimeRevision:z.number().int().positive(),
  observedAt:z.string().datetime(),revision:z.number().int().nonnegative(),selectedAccountId:AccountId.optional(),canMutate:z.boolean(),accountControlActive:z.boolean(),resumeArmed:z.boolean(),
  routing:z.object({mode:z.enum(["manual","sticky","priority","round_robin"]),revision:z.number().int().nonnegative(),automaticEnabled:z.boolean(),experimentalEnabled:z.boolean(),failoverEnabled:z.boolean(),modelSelection:WebModelSelectionSchema.optional(),bindingsCount:z.number().int().nonnegative(),bindings:z.array(z.object({taskScope:TaskScope,accountId:AccountId,identityEpoch:z.number().int().nonnegative()}).strict()).max(128)}).strict(),
  accounts:z.array(z.object({
    accountId:AccountId,displayName:z.string().min(1).max(128),browserTransport:z.enum(["cdp","extension"]).optional(),enabled:z.boolean(),selected:z.boolean(),identityRegistered:z.boolean(),identityVerified:z.boolean(),identityEpoch:z.number().int().nonnegative(),lastVerifiedAt:z.string().datetime().optional(),
    state:z.enum(["disabled","unverified","checked","busy","login_required","identity_mismatch","verification_required","unavailable","cooldown"]),reasonCode:z.string().regex(/^[A-Z0-9_]{1,80}$/).optional(),
    capabilities:z.array(z.object({name:z.string().min(1).max(80),status:z.enum(["unknown","observed","verified","unsupported"]),observedAt:z.string().datetime().optional()}).strict()).max(32),
  }).strict()).max(32),
  activeTurns:z.array(z.object({requestId:z.string().regex(/^native_[a-f0-9]{64}$/),accountId:AccountId,taskScope:TaskScope.optional(),phase:NativeManagementPhaseSchema}).strict()).max(32),
  lastOutcome:z.object({requestId:z.string().regex(/^native_[a-f0-9]{64}$/),accountId:AccountId.optional(),phase:NativeManagementPhaseSchema,code:z.string().regex(/^[A-Z0-9_]{1,80}$/).optional(),delivery:z.enum(["not_sent","unknown"]).optional(),browserStopConfirmed:z.boolean().optional(),elapsedMs:z.number().int().nonnegative().optional(),firstTextMs:z.number().int().nonnegative().nullable().optional(),transportMessages:z.number().int().min(1).max(11).optional(),attemptCount:z.number().int().min(1).max(4).optional()}).strict().optional(),
  latestIssue:z.object({code:z.string().regex(/^[A-Z0-9_]{1,80}$/),phase:z.string().min(1).max(80).optional(),expectedModel:z.string().max(128).optional(),receivedModelSelectors:z.record(z.string().max(128)).optional()}).strict().optional(),
}).strict();
export type NativeManagementSnapshot=z.infer<typeof NativeManagementSnapshotSchema>;
export interface NativeManagementClient {
  getNativeAccounts():Promise<NativeManagementSnapshot>;
  executeNativeAccount(command:NativeManagementCommand):Promise<NativeManagementSnapshot>;
}
/** The renderer requests a copy; the pairing secret stays in the main process and OS clipboard. */
export interface NativeExtensionPairingClient { copyNativeExtensionPairingCode(intent:NativeExtensionPairingIntent):Promise<void> }
