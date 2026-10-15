import { z } from "zod";

export const ActivitySeveritySchema = z.enum(["info", "warning", "error"]);
export type ActivitySeverity = z.infer<typeof ActivitySeveritySchema>;

export const ActivityEntrySchema = z.object({
  id: z.string().min(1),
  at: z.string().datetime(),
  severity: ActivitySeveritySchema,
  category: z.string().min(1),
  summary: z.string().min(1),
  correlationId: z.string().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
}).strict();

export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

export const ActivityQuerySchema = z.object({
  cursor: z.string().optional(),
  sessionId: z.string().optional(),
  severity: ActivitySeveritySchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
}).strict();

export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;

export function createPageSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().optional(),
  }).strict();
}

export type Page<T> = {
  items: T[];
  nextCursor?: string;
};
