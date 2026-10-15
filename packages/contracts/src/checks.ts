import { z } from "zod";

export const CheckCategorySchema = z.enum([
  "host",
  "route",
  "browser",
  "account",
  "model",
  "tools",
]);

export type CheckCategory = z.infer<typeof CheckCategorySchema>;

export const CheckStatusSchema = z.enum([
  "not_run",
  "running",
  "passed",
  "failed",
  "unsupported",
]);

export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const CheckResultSchema = z.object({
  key: CheckCategorySchema,
  status: CheckStatusSchema,
  summary: z.string().min(1),
  checkedAt: z.string().datetime().optional(),
});

export type CheckResult = z.infer<typeof CheckResultSchema>;

