import { z } from "zod";
import type { Conversation, Workspace } from "./contracts";

export const conversationMetadataFields = {
  titleEdited: z.boolean().optional(),
  pinned: z.boolean().optional(),
  unread: z.boolean().optional(),
  archived: z.boolean().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
  // Sidebar organization is deliberately independent of a live thread's cwd.
  projectId: z.string().min(1).max(160).nullable().optional(),
  forkedFrom: z.string().min(1).max(160).optional(),
};
export const conversationPatchSchema = z.object({
  title: z.string().trim().min(1).max(160).refine(v => !/[\r\n\x00-\x1f\x7f]/.test(v)),
  pinned: z.boolean(), unread: z.boolean(), archived: z.boolean(),
  projectId: z.string().min(1).max(160).nullable(),
}).partial().strict().refine(v => Object.keys(v).length > 0);
export type ConversationPatch = z.infer<typeof conversationPatchSchema>;
export type ConversationSort = "updated" | "created" | "title";

export function conversationGroups(conversations: Conversation[], workspaces: Workspace[],
  grouping: "project" | "list", sort: ConversationSort, archived = false) {
  const sorted = conversations.filter(c => !!c.archived === archived).slice().sort((a, b) =>
    Number(!!b.pinned) - Number(!!a.pinned) || (sort === "title" ? a.title.localeCompare(b.title) :
      sort === "created" ? b.createdAt - a.createdAt : (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)) || a.id.localeCompare(b.id));
  if (grouping === "list") return [{ id: "all", name: null, conversations: sorted }];
  const groups = new Map<string, { id: string; name: string | null; conversations: Conversation[] }>();
  for (const c of sorted) {
    const projectId = c.projectId === undefined ? c.workspaceId : c.projectId;
    const project = workspaces.find(w => w.id === projectId);
    const id = project?.id ?? "unassigned";
    if (!groups.has(id)) groups.set(id, { id, name: project?.name ?? null, conversations: [] });
    groups.get(id)!.conversations.push(c);
  }
  return [...groups.values()];
}

/** Explicit plain-text export. No tools, reasoning, drafts, credentials or hidden state. */
export function conversationTranscript(c: Conversation) {
  return c.messages.map(m => `${m.role === "user" ? "User" : "Assistant"}${m.simulated ? " (simulated)" : ""}${m.incomplete ? " (incomplete)" : ""}:\n${m.text}${m.imageIds?.length ? "\n[Image attachments are not included in this text copy]" : ""}`).join("\n\n");
}
