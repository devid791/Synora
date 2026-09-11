import { z } from "zod";
import { conversationPatchSchema } from "./conversation-management";
import { busySubmissionSchema, userPreferenceFields } from "./user-preferences";
import { permissionModeSchema } from "./permission-mode";
import { localMemoryProfileSchema } from "./local-memory";
import { localeSchema } from "./locale";
import { orchestrationPlanSchema } from "./orchestration";
import { imageUploadSchema } from "./image-attachments";
import { googleClientSchema } from "./google-oauth";
import { accountLoginSchema } from "./core-account";
import { catalogIconRequestSchema } from "./catalog-icon";
import {
  profiles,
  views,
  scenarios,
  presetSchema,
  configSchema,
  engineConfigSchema,
  type DesktopAPI,
} from "./contracts";

const id = z.string().min(1).max(160),
  text = z.string().max(100000),
  filePath = z.string().max(4096);
const rect = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();
export const operationSchemas = {
  clipboardWriteText: z.tuple([z.string().max(4 * 1024 * 1024)]),
  conversationUpdate: z.tuple([id, conversationPatchSchema]),
  conversationPermission: z.tuple([id.nullable(), permissionModeSchema]),
  conversationForkDraft: z.tuple([id, z.literal(true)]),
  conversationDelete: z.tuple([id, z.literal(true)]),
  orchestrationConfigure: z.tuple([id, orchestrationPlanSchema.nullable()]),
  delegationCancel: z.tuple([id, id]),
  delegationApprove: z.tuple([id, id, id, z.boolean()]),
  delegationAnswer: z.tuple([
    id,
    id,
    id,
    z.record(id, z.array(z.string().max(16000)).max(32)),
  ]),
  imageAttach: z.tuple([id, imageUploadSchema]),
  imageRead: z.tuple([id, z.string().uuid()]),
  imageRemove: z.tuple([id, z.string().uuid()]),
  coreUpdateStatus: z.tuple([]),
  coreUpdateCheck: z.tuple([]),
  coreUpdateAutomatic: z.tuple([z.boolean()]),
  coreUpdateInstall: z.tuple([
    z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .max(40),
  ]),
  coreUpdateRollback: z.tuple([z.string().uuid(), z.literal(true)]),
  corePluginStatus: z.tuple([]),
  corePluginInspect: z.tuple([id, id, id]),
  corePluginChange: z.tuple([
    id,
    z.enum(["install", "uninstall"]),
    z.literal(true),
  ]),
  corePluginCancel: z.tuple([id]),
  corePluginAuthorize: z.tuple([id, z.string().min(1).max(512)]),
  coreCatalogStatus: z.tuple([]),
  pluginDirectoryRead: z.tuple([z.boolean()]),
  coreCatalogIcon: z.tuple([catalogIconRequestSchema]),
  coreCatalogRead: z.tuple([id, id, z.boolean()]),
  coreCatalogCancel: z.tuple([id]),
  coreAccountStatus: z.tuple([]),
  coreAccountRead: z.tuple([]),
  coreAccountLogin: z.tuple([accountLoginSchema]),
  coreAccountCancel: z.tuple([id]),
  coreAccountOpen: z.tuple([id]),
  coreAccountLogout: z.tuple([]),
  providerCredentialStatus: z.tuple([id]),
  providerLoginStatus: z.tuple([]),
  googleAccountStatus: z.tuple([id]),
  googleAccountForget: z.tuple([id, z.literal(true)]),
  googleAccountConfigure: z.tuple([id, googleClientSchema]),
  googleAccountDisconnect: z.tuple([id, z.boolean()]),
  googleLoginStatus: z.tuple([]),
  googleLoginStart: z.tuple([id]),
  googleLoginCancel: z.tuple([id]),
  googleLoginOpen: z.tuple([id]),
  providerLoginStart: z.tuple([id, z.enum(["browser", "paste-code"])]),
  providerLoginSubmit: z.tuple([id, z.string().min(1).max(8192)]),
  providerLoginCancel: z.tuple([id]),
  providerLoginOpen: z.tuple([id]),
  providerCredentialSave: z.tuple([id, z.string().min(1).max(16384)]),
  providerCredentialDelete: z.tuple([id]),
  mcpAuthorize: z.tuple([id, id]),
  mcpAuthorizationStatus: z.tuple([]),
  mcpAuthorizationOpen: z.tuple([id]),
  mcpAuthorizationCancel: z.tuple([id]),
  backendStatus: z.tuple([]),
  engineAnswer: z.tuple([
    id,
    z.record(
      z.string().min(1).max(160),
      z.array(z.string().max(16000)).max(32),
    ),
  ]),
  engineRestore: z.tuple([z.string().min(1)]),
  engineCompact: z.tuple([id]),
  engineConfigure: z.tuple([engineConfigSchema]),
  engineNativeSetup: z.tuple([
    z.string().min(1),
    z.string().min(1),
    z.enum(["elevated", "unelevated"]).optional(),
  ]),
  engineModels: z.tuple([id]),
  closeReady: z.tuple([id, z.boolean()]),
  capabilities: z.tuple([]),
  state: z.tuple([]),
  preferences: z.tuple([
    z
      .object({
        ...z.object(userPreferenceFields).partial().shape,
        permission: permissionModeSchema.optional(),
        localMemory: localMemoryProfileSchema.optional(),
        locale: localeSchema.optional(),
        sidebarCollapsed: z.boolean().optional(),
        filesCollapsed: z.boolean().optional(),
        mode: z.enum(["default", "plan"]).optional(),
        view: z.enum(views).optional(),
        profile: z.enum(profiles).optional(),
        context: z.union([z.literal(262144), z.literal(1048576)]).optional(),
        compact: z.boolean().optional(),
      })
      .strict(),
  ]),
  chooseWorkspace: z.union([z.tuple([]), z.tuple([filePath.optional()])]),
  conversationWorkspace: z.tuple([id, id.nullable()]),
  listFiles: z.tuple([id, filePath]),
  readFile: z.tuple([id, filePath]),
  saveFile: z.tuple([
    id,
    z
      .object({
        path: filePath,
        content: z.string().max(2 * 1024 * 1024),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  ]),
  newConversation: z.union([z.tuple([id.nullable()]), z.tuple([id.nullable(), id.nullable().optional()])]),
  saveDraft: z.tuple([id, text]),
  discardQueuedMessage: z.tuple([id, z.string().uuid()]),
  presetSave: z.union([
    z.tuple([presetSchema]),
    z.tuple([presetSchema, id.optional()]),
  ]),
  presetDelete: z.tuple([id]),
  presetInstallTemplate: z.tuple([id]),
  botCatalogRead: z.tuple([z.boolean()]),
  botCatalogPreview: z.tuple([id, z.string().regex(/^[a-f0-9]{40}$/)]),
  botCatalogImport: z.tuple([id, z.literal(true)]),
  botCatalogUpdates: z.tuple([]),
  presetImport: z.tuple([]),
  presetExport: z.tuple([id]),
  integrationSave: z.union([
    z.tuple([configSchema]),
    z.tuple([configSchema, id.optional()]),
  ]),
  integrationDelete: z.tuple([id]),
  engineStart: z.union([
    z.tuple([id, z.string().trim().max(100000), z.enum(scenarios)]),
    z.tuple([id, z.string().trim().max(100000), z.enum(scenarios), busySubmissionSchema.optional()]),
  ]),
  engineCancel: z.tuple([]),
  engineApprove: z.tuple([id, z.boolean()]),
  engineSnapshot: z.tuple([]),
  engineReconnect: z.tuple([z.number().int().nonnegative().safe()]),
  terminalOpen: z.tuple([id]),
  terminalList: z.tuple([]),
  terminalWrite: z.tuple([id, z.string().max(65536)]),
  terminalResize: z.tuple([
    id,
    z.number().int().min(2).max(1000),
    z.number().int().min(1).max(500),
  ]),
  terminalClose: z.tuple([id]),
  browserOpen: z.tuple([z.string().min(1).max(4096)]),
  browserNavigate: z.tuple([id, z.string().min(1).max(4096)]),
  browserAction: z.tuple([id, z.enum(["back", "forward", "reload", "close"])]),
  browserLayout: z.tuple([id.nullable(), rect]),
  browserList: z.tuple([]),
  browserFrame: z.tuple([id]),
  browserInput: z.tuple([
    id,
    z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("click"),
          x: z.number().finite().nonnegative().max(4096),
          y: z.number().finite().nonnegative().max(4096),
          button: z.enum(["left", "middle", "right"]),
        })
        .strict(),
      z
        .object({ type: z.literal("key"), key: z.string().min(1).max(80) })
        .strict(),
      z
        .object({ type: z.literal("text"), text: z.string().max(65536) })
        .strict(),
      z
        .object({
          type: z.literal("scroll"),
          x: z.number().finite().nonnegative().max(4096),
          y: z.number().finite().nonnegative().max(4096),
          deltaX: z.number().finite().min(-10000).max(10000),
          deltaY: z.number().finite().min(-10000).max(10000),
        })
        .strict(),
    ]),
  ]),
  metrics: z.tuple([]),
} satisfies Record<Exclude<keyof DesktopAPI, "onEvent">, z.ZodTypeAny>;
export type Operation = keyof typeof operationSchemas;
export const operations = Object.keys(operationSchemas) as Operation[];
export function validateOperation(
  name: string,
  args: unknown,
): { name: Operation; args: unknown[] } {
  if (!Object.hasOwn(operationSchemas, name))
    throw new Error("Unknown operation");
  return {
    name: name as Operation,
    args: operationSchemas[name as Operation].parse(args),
  };
}
