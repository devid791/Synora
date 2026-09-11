import { z } from "zod";
import { selectionSchema } from "./model-selection";

export const workerDefinitionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(80),
    name: z.string().trim().min(1).max(100),
    selection: selectionSchema,
    workspaceId: z.string().min(1).max(160),
    timeoutMs: z.number().int().min(1000).max(3600000),
    contractHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const orchestrationPlanSchema = z
  .object({
    workers: z.array(workerDefinitionSchema).min(1),
    externalSharingConfirmed: z.literal(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.workers.map((w) => w.id)).size !== v.workers.length)
      ctx.addIssue({
        code: "custom",
        path: ["workers"],
        message: "Worker IDs must be unique",
      });
  });
export type WorkerDefinition = z.infer<typeof workerDefinitionSchema>;
export type OrchestrationPlan = z.infer<typeof orchestrationPlanSchema>;
