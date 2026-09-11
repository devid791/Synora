import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI, DesktopEvent } from "../shared/contracts";

// Only this packaged renderer receives the bridge. Remote browser tabs have no preload.
const api: DesktopAPI = {
  orchestrationConfigure: (id, plan) =>
    ipcRenderer.invoke("synora:orchestrationConfigure", id, plan),
  delegationCancel: (id, task) =>
    ipcRenderer.invoke("synora:delegationCancel", id, task),
  delegationApprove: (id, task, approval, approved) =>
    ipcRenderer.invoke(
      "synora:delegationApprove",
      id,
      task,
      approval,
      approved,
    ),
  delegationAnswer: (id, task, question, answers) =>
    ipcRenderer.invoke("synora:delegationAnswer", id, task, question, answers),
  coreUpdateStatus: () => ipcRenderer.invoke("synora:coreUpdateStatus"),
  coreUpdateCheck: () => ipcRenderer.invoke("synora:coreUpdateCheck"),
  coreUpdateAutomatic: (enabled) =>
    ipcRenderer.invoke("synora:coreUpdateAutomatic", enabled),
  coreUpdateInstall: (version) =>
    ipcRenderer.invoke("synora:coreUpdateInstall", version),
  coreUpdateRollback: (id, confirmed) =>
    ipcRenderer.invoke("synora:coreUpdateRollback", id, confirmed),
  coreCatalogStatus: () => ipcRenderer.invoke("synora:coreCatalogStatus"),
  coreCatalogIcon: (request) =>
    ipcRenderer.invoke("synora:coreCatalogIcon", request),
  corePluginStatus: () => ipcRenderer.invoke("synora:corePluginStatus"),
  corePluginInspect: (catalog, marketplace, plugin) =>
    ipcRenderer.invoke(
      "synora:corePluginInspect",
      catalog,
      marketplace,
      plugin,
    ),
  corePluginChange: (review, action, confirmed) =>
    ipcRenderer.invoke("synora:corePluginChange", review, action, confirmed),
  corePluginCancel: (id) => ipcRenderer.invoke("synora:corePluginCancel", id),
  corePluginAuthorize: (id, server) =>
    ipcRenderer.invoke("synora:corePluginAuthorize", id, server),
  coreCatalogRead: (provider, workspace, remote) =>
    ipcRenderer.invoke("synora:coreCatalogRead", provider, workspace, remote),
  coreCatalogCancel: (id) => ipcRenderer.invoke("synora:coreCatalogCancel", id),
  coreAccountStatus: () => ipcRenderer.invoke("synora:coreAccountStatus"),
  coreAccountRead: () => ipcRenderer.invoke("synora:coreAccountRead"),
  coreAccountLogin: (login) =>
    ipcRenderer.invoke("synora:coreAccountLogin", login),
  coreAccountCancel: (id) => ipcRenderer.invoke("synora:coreAccountCancel", id),
  coreAccountOpen: (id) => ipcRenderer.invoke("synora:coreAccountOpen", id),
  coreAccountLogout: () => ipcRenderer.invoke("synora:coreAccountLogout"),
  providerCredentialStatus: (id) =>
    ipcRenderer.invoke("synora:providerCredentialStatus", id),
  providerLoginStatus: () => ipcRenderer.invoke("synora:providerLoginStatus"),
  googleAccountStatus: (id) =>
    ipcRenderer.invoke("synora:googleAccountStatus", id),
  googleAccountForget: (id, confirmed) =>
    ipcRenderer.invoke("synora:googleAccountForget", id, confirmed),
  googleAccountConfigure: (id, client) =>
    ipcRenderer.invoke("synora:googleAccountConfigure", id, client),
  googleAccountDisconnect: (id, revoke) =>
    ipcRenderer.invoke("synora:googleAccountDisconnect", id, revoke),
  googleLoginStatus: () => ipcRenderer.invoke("synora:googleLoginStatus"),
  googleLoginStart: (id) => ipcRenderer.invoke("synora:googleLoginStart", id),
  googleLoginCancel: (id) => ipcRenderer.invoke("synora:googleLoginCancel", id),
  googleLoginOpen: (id) => ipcRenderer.invoke("synora:googleLoginOpen", id),
  providerLoginStart: (id, method) =>
    ipcRenderer.invoke("synora:providerLoginStart", id, method),
  providerLoginSubmit: (id, code) =>
    ipcRenderer.invoke("synora:providerLoginSubmit", id, code),
  providerLoginCancel: (id) =>
    ipcRenderer.invoke("synora:providerLoginCancel", id),
  providerLoginOpen: (id) => ipcRenderer.invoke("synora:providerLoginOpen", id),
  providerCredentialSave: (id, token) =>
    ipcRenderer.invoke("synora:providerCredentialSave", id, token),
  providerCredentialDelete: (id) =>
    ipcRenderer.invoke("synora:providerCredentialDelete", id),
  mcpAuthorize: (id, provider) =>
    ipcRenderer.invoke("synora:mcpAuthorize", id, provider),
  mcpAuthorizationStatus: () =>
    ipcRenderer.invoke("synora:mcpAuthorizationStatus"),
  mcpAuthorizationOpen: (id) =>
    ipcRenderer.invoke("synora:mcpAuthorizationOpen", id),
  mcpAuthorizationCancel: (id) =>
    ipcRenderer.invoke("synora:mcpAuthorizationCancel", id),
  backendStatus: () => ipcRenderer.invoke("synora:backendStatus"),
  engineNativeSetup: (providerId, workspaceId, mode) =>
    ipcRenderer.invoke(
      "synora:engineNativeSetup",
      providerId,
      workspaceId,
      mode,
    ),
  engineConfigure: (config) =>
    ipcRenderer.invoke("synora:engineConfigure", config),
  engineRestore: (id) => ipcRenderer.invoke("synora:engineRestore", id),
  engineCompact: (id) => ipcRenderer.invoke("synora:engineCompact", id),
  engineModels: (id) => ipcRenderer.invoke("synora:engineModels", id),
  closeReady: (id, unsavedFile) =>
    ipcRenderer.invoke("synora:closeReady", id, unsavedFile),
  capabilities: () => ipcRenderer.invoke("synora:capabilities"),
  state: () => ipcRenderer.invoke("synora:state"),
  clipboardWriteText: (text) => ipcRenderer.invoke("synora:clipboardWriteText", text),
  preferences: (p) => ipcRenderer.invoke("synora:preferences", p),
  chooseWorkspace: () => ipcRenderer.invoke("synora:chooseWorkspace"),
  listFiles: (id, p) => ipcRenderer.invoke("synora:listFiles", id, p),
  readFile: (id, p) => ipcRenderer.invoke("synora:readFile", id, p),
  saveFile: (id, doc) => ipcRenderer.invoke("synora:saveFile", id, doc),
  newConversation: (id, presetId) => presetId === undefined ? ipcRenderer.invoke("synora:newConversation", id) : ipcRenderer.invoke("synora:newConversation", id, presetId),
  conversationWorkspace: (id, workspaceId) =>
    ipcRenderer.invoke("synora:conversationWorkspace", id, workspaceId),
  conversationUpdate: (id, patch) => ipcRenderer.invoke("synora:conversationUpdate", id, patch),
  conversationPermission: (id, permission) => ipcRenderer.invoke("synora:conversationPermission", id, permission),
  conversationForkDraft: (id, confirmed) => ipcRenderer.invoke("synora:conversationForkDraft", id, confirmed),
  conversationDelete: (id, confirmed) => ipcRenderer.invoke("synora:conversationDelete", id, confirmed),
  saveDraft: (id, text) => ipcRenderer.invoke("synora:saveDraft", id, text),
  discardQueuedMessage: (conversationId, messageId) =>
    ipcRenderer.invoke("synora:discardQueuedMessage", conversationId, messageId),
  imageAttach: (id, value) =>
    ipcRenderer.invoke("synora:imageAttach", id, value),
  imageRead: (id, image) => ipcRenderer.invoke("synora:imageRead", id, image),
  imageRemove: (id, image) =>
    ipcRenderer.invoke("synora:imageRemove", id, image),
  presetSave: (value, id) => ipcRenderer.invoke("synora:presetSave", value, id),
  presetDelete: (id) => ipcRenderer.invoke("synora:presetDelete", id),
  presetInstallTemplate: (id) => ipcRenderer.invoke("synora:presetInstallTemplate", id),
  botCatalogRead: (refresh) => ipcRenderer.invoke("synora:botCatalogRead", refresh),
  botCatalogPreview: (id, revision) => ipcRenderer.invoke("synora:botCatalogPreview", id, revision),
  botCatalogImport: (id, confirmed) => ipcRenderer.invoke("synora:botCatalogImport", id, confirmed),
  botCatalogUpdates: () => ipcRenderer.invoke("synora:botCatalogUpdates"),
  pluginDirectoryRead: (refresh) => ipcRenderer.invoke("synora:pluginDirectoryRead", refresh),
  presetImport: () => ipcRenderer.invoke("synora:presetImport"),
  presetExport: (id) => ipcRenderer.invoke("synora:presetExport", id),
  integrationSave: (v, id) =>
    ipcRenderer.invoke("synora:integrationSave", v, id),
  integrationDelete: (id) => ipcRenderer.invoke("synora:integrationDelete", id),
  engineStart: (id, text, scenario, busy) =>
    ipcRenderer.invoke("synora:engineStart", id, text, scenario, busy),
  engineCancel: () => ipcRenderer.invoke("synora:engineCancel"),
  engineAnswer: (id, answers) =>
    ipcRenderer.invoke("synora:engineAnswer", id, answers),
  engineApprove: (id, approved) =>
    ipcRenderer.invoke("synora:engineApprove", id, approved),
  engineSnapshot: () => ipcRenderer.invoke("synora:engineSnapshot"),
  engineReconnect: (after) =>
    ipcRenderer.invoke("synora:engineReconnect", after),
  terminalOpen: (id) => ipcRenderer.invoke("synora:terminalOpen", id),
  terminalList: () => ipcRenderer.invoke("synora:terminalList"),
  terminalWrite: (id, input) =>
    ipcRenderer.invoke("synora:terminalWrite", id, input),
  terminalResize: (id, cols, rows) =>
    ipcRenderer.invoke("synora:terminalResize", id, cols, rows),
  terminalClose: (id) => ipcRenderer.invoke("synora:terminalClose", id),
  browserOpen: (url) => ipcRenderer.invoke("synora:browserOpen", url),
  browserNavigate: (id, url) =>
    ipcRenderer.invoke("synora:browserNavigate", id, url),
  browserAction: (id, action) =>
    ipcRenderer.invoke("synora:browserAction", id, action),
  browserLayout: (id, rect) =>
    ipcRenderer.invoke("synora:browserLayout", id, rect),
  browserList: () => ipcRenderer.invoke("synora:browserList"),
  browserFrame: (id) => ipcRenderer.invoke("synora:browserFrame", id),
  browserInput: (id, input) =>
    ipcRenderer.invoke("synora:browserInput", id, input),
  metrics: () => ipcRenderer.invoke("synora:metrics"),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, data: DesktopEvent) =>
      listener(data);
    ipcRenderer.on("synora:event", handler);
    return () => ipcRenderer.removeListener("synora:event", handler);
  },
};
contextBridge.exposeInMainWorld("synora", api);
