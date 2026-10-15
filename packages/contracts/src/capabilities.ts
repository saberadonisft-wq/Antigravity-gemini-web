import { z } from "zod";

export const CapabilityKeySchema = z.enum([
  "nativeRoute",
  "modelSelection",
  "toolExecution",
  "customMcp",
  "cancelTurn",
  "imageInput",
  "contextCompaction",
  "usageObservation",
  "logExport",
]);

export type CapabilityKey = z.infer<typeof CapabilityKeySchema>;

export const CapabilityStateSchema = z.enum([
  "unverified",
  "available",
  "unavailable",
]);

export type CapabilityState = z.infer<typeof CapabilityStateSchema>;

export const CapabilityValueSchema = z.object({
  state: CapabilityStateSchema,
  reasonCode: z.string().optional(),
  detail: z.string().optional(),
  verifiedAt: z.string().datetime().optional(),
});

export type CapabilityValue = z.infer<typeof CapabilityValueSchema>;

export const CapabilityMapSchema = z.record(CapabilityKeySchema, CapabilityValueSchema);

export type CapabilityMap = z.infer<typeof CapabilityMapSchema>;

