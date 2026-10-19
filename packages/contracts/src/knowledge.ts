import { z } from "zod";

const Digest=z.string().regex(/^[a-f0-9]{64}$/);
const AccountId=z.string().regex(/^[a-zA-Z0-9_-]{4,64}$/);
const RelativePath=z.string().min(1).max(1024);
const PublicRelativePath=RelativePath.refine(value=>!/[\u0000-\u001f\u007f:]/.test(value)&&!value.split(/[\\/]/).some(part=>!part||part==="."||part===".."),"Only selected relative file paths may cross IPC");
export const KnowledgeFileSchema=z.object({path:RelativePath,sha256:Digest,bytes:z.number().int().min(0).max(1048576),origin:z.enum(["local","commit","line_endings","overlay"]),commitSha256:Digest.optional()}).strict();
export const KnowledgeGitSchema=z.object({repository:z.string().url().max(512),commit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)}).strict();
export const KnowledgeCodeSourceSchema=z.object({
  sourceId:z.string().uuid(),kind:z.enum(["local_folder","github_checkout"]),label:z.string().min(1).max(128),root:z.string().min(1).max(4096),revision:z.number().int().positive(),createdAt:z.string().datetime(),updatedAt:z.string().datetime(),
  files:z.array(KnowledgeFileSchema).min(1).max(128),digest:Digest,git:KnowledgeGitSchema.optional(),
}).strict();
export const KnowledgeExternalSourceSchema=z.object({
  sourceId:z.string().uuid(),kind:z.enum(["gem","notebook","drive","github_web"]),label:z.string().min(1).max(128),url:z.string().url().max(1024),instructionVersion:z.string().min(1).max(80).optional(),createdAt:z.string().datetime(),updatedAt:z.string().datetime(),revision:z.number().int().positive(),
}).strict();
export const KnowledgeSourceSchema=z.union([KnowledgeCodeSourceSchema,KnowledgeExternalSourceSchema]);
export type KnowledgeSource=z.infer<typeof KnowledgeSourceSchema>;
export type KnowledgeCodeSource=z.infer<typeof KnowledgeCodeSourceSchema>;
export type KnowledgeExternalSource=z.infer<typeof KnowledgeExternalSourceSchema>;
export const KnowledgeBindingSchema=z.object({taskScope:Digest,accountId:AccountId,identityEpoch:z.number().int().nonnegative(),sourceIds:z.array(z.string().uuid()).max(8),updatedAt:z.string().datetime()}).strict();
export const KnowledgeRegistrySchema=z.object({version:z.literal(1),revision:z.number().int().nonnegative(),sources:z.array(KnowledgeSourceSchema).max(64),bindings:z.array(KnowledgeBindingSchema).max(1024)}).strict();
export type KnowledgeRegistry=z.infer<typeof KnowledgeRegistrySchema>;
export const KnowledgeCodeImportSchema=z.object({
  kind:z.enum(["local_folder","github_checkout"]),label:z.string().trim().min(1).max(128),root:z.string().min(1).max(4096),files:z.array(RelativePath).min(1).max(128),overlayFiles:z.array(RelativePath).max(128).default([]),repository:z.string().url().max(512).optional(),
}).strict();
export type KnowledgeCodeImport=z.infer<typeof KnowledgeCodeImportSchema>;
const authority={expectedOwnerId:z.string().uuid(),expectedRevision:z.number().int().nonnegative()};
const refreshCommand=z.object({action:z.literal("refresh"),sourceId:z.string().uuid(),overlayFiles:z.array(RelativePath).max(128).optional(),...authority}).strict();
const checkCommand=z.object({action:z.literal("check"),sourceId:z.string().uuid(),...authority}).strict();
const removeCommand=z.object({action:z.literal("remove"),sourceId:z.string().uuid(),...authority}).strict();
const bindCommand=z.object({action:z.literal("bind"),taskScope:Digest,accountId:AccountId,identityEpoch:z.number().int().nonnegative(),sourceIds:z.array(z.string().uuid()).max(8),...authority}).strict();
export const KnowledgeCommandSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("import_code"),source:KnowledgeCodeImportSchema,...authority}).strict(),
  z.object({action:z.literal("register_external"),kind:z.enum(["gem","notebook","drive","github_web"]),label:z.string().trim().min(1).max(128),url:z.string().url().max(1024),instructionVersion:z.string().min(1).max(80).optional(),...authority}).strict(),
  refreshCommand,checkCommand,removeCommand,bindCommand,
]);
export type KnowledgeCommand=z.infer<typeof KnowledgeCommandSchema>;
// Renderer commands cannot choose filesystem paths or introduce remote integrations.
export const KnowledgeUiCommandSchema=z.discriminatedUnion("action",[refreshCommand,checkCommand,removeCommand,bindCommand]);
export type KnowledgeUiCommand=z.infer<typeof KnowledgeUiCommandSchema>;
export const KnowledgeImportIntentSchema=z.object({label:z.string().trim().min(1).max(128),...authority}).strict();
export type KnowledgeImportIntent=z.infer<typeof KnowledgeImportIntentSchema>;
export const KnowledgeRequestSchema=z.union([z.object({action:z.literal("status")}).strict(),KnowledgeCommandSchema]);
export const KnowledgeSourceStatusSchema=z.object({
  sourceId:z.string().uuid(),kind:z.enum(["local_folder","github_checkout","gem","notebook","drive","github_web"]),label:z.string().min(1).max(128),revision:z.number().int().positive(),
  digest:Digest.optional(),commit:z.string().max(64).optional(),fileCount:z.number().int().nonnegative(),bytes:z.number().int().nonnegative(),
  url:z.string().url().max(1024).optional(),instructionVersion:z.string().min(1).max(80).optional(),
  selectedFiles:z.array(PublicRelativePath).max(128).optional(),
  state:z.enum(["not_checked","current","stale","unavailable","not_verified"]),reasonCode:z.string().regex(/^[A-Z0-9_]{1,80}$/).optional(),checkedAt:z.string().datetime().optional(),
}).strict();
export const KnowledgeSnapshotSchema=z.object({service:z.literal("gemini-native-knowledge"),version:z.literal(1),ownerId:z.string().uuid(),revision:z.number().int().nonnegative(),experimentalEnabled:z.boolean(),canMutate:z.boolean(),lastTaskScope:Digest.optional(),sources:z.array(KnowledgeSourceStatusSchema).max(64),bindings:z.array(KnowledgeBindingSchema).max(1024)}).strict();
export type KnowledgeSnapshot=z.infer<typeof KnowledgeSnapshotSchema>;
export interface NativeKnowledgeClient {getNativeKnowledge():Promise<KnowledgeSnapshot>;executeNativeKnowledge(command:KnowledgeUiCommand):Promise<KnowledgeSnapshot>;importNativeKnowledge(intent:KnowledgeImportIntent):Promise<KnowledgeSnapshot>}
