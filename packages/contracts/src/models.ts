import { z } from "zod";
import { CapabilityStateSchema } from "./capabilities.js";

export const ModelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  availability: CapabilityStateSchema,
  verifiedAt: z.string().datetime().optional(),
});

export type ModelInfo = z.infer<typeof ModelInfoSchema>;

