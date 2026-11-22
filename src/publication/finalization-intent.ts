import { z } from "zod";

export const FinalizationIntentSchema = z.object({
  generation: z.number().int().positive().refine(Number.isSafeInteger),
  publicationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  thaiDate: z.string().min(1),
  docId: z.string().min(1),
  docUrl: z.string().url(),
  title: z.string().min(1),
  productIds: z.array(z.string().regex(/^A-[1-9]\d*$/)),
  generatedAt: z.string().datetime(),
});

