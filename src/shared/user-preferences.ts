import { z } from "zod";

export const userPreferenceFields = {
  selectedConversationId: z.string().min(1).max(160).nullable().default(null),
  conversationGrouping: z.enum(["project", "list"]).default("list"),
  conversationSort: z.enum(["updated", "created", "title"]).default("updated"),
  pluginCatalogAutomatic: z.boolean().default(true),
  botCatalogAutomatic: z.boolean().default(true),
  defaultBotId: z.string().min(1).max(160).nullable().default(null),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  busyEnterBehavior: z.enum(["queue", "steer"]).default("queue"),
  launchAtLogin: z.boolean().default(false),
  systemNotifications: z.boolean().default(true),
};

export const busySubmissionSchema = z
  .object({
    behavior: z.enum(["queue", "steer"]),
    expectedThreadId: z.string().min(1).max(160),
    expectedTurnId: z.string().min(1).max(160),
  })
  .strict();
export type BusySubmission = z.infer<typeof busySubmissionSchema>;

export const queuedMessageSchema = z
  .object({
    id: z.string().uuid(),
    text: z.string().trim().min(1).max(100000),
    threadId: z.string().min(1),
    sessionId: z.string().min(1),
    afterTurnId: z.string().min(1),
    status: z.enum(["queued", "dispatching", "held"]),
  })
  .strict();
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type PreferenceCapability = { supported: boolean; reason?: string };
