import { z } from "zod";

const RawAppConfigSchema = z.object({
  TIME_ZONE: z.literal("Asia/Bangkok"),
  UPLOAD_CUTOFF_MINUTES: z.number().int().positive(),
  PRODUCT_ID_PREFIX: z.string().min(1),
});

export interface AppConfig {
  timeZone: "Asia/Bangkok";
  uploadCutoffMinutes: number;
  productIdPrefix: string;
}

export function parseConfig(raw: unknown): AppConfig {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  const parsed = RawAppConfigSchema.parse(value);
  return {
    timeZone: parsed.TIME_ZONE,
    uploadCutoffMinutes: parsed.UPLOAD_CUTOFF_MINUTES,
    productIdPrefix: parsed.PRODUCT_ID_PREFIX,
  };
}
