import { z } from "zod";

export const ThemeSchema = z.enum(["system", "light", "dark"]);
export type Theme = z.infer<typeof ThemeSchema>;

export const LanguageSchema = z.enum(["vi", "en"]);
export type Language = z.infer<typeof LanguageSchema>;

export const DiagnosticLevelSchema = z.enum(["normal", "verbose_redacted"]);
export type DiagnosticLevel = z.infer<typeof DiagnosticLevelSchema>;

export const SettingsSchema = z.object({
  theme: ThemeSchema,
  language: LanguageSchema,
  diagnosticLevel: DiagnosticLevelSchema,
  revision: z.number().int().nonnegative(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsPatchSchema = z.object({
  theme: ThemeSchema.optional(),
  language: LanguageSchema.optional(),
  diagnosticLevel: DiagnosticLevelSchema.optional(),
}).strict();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

