import {
  presetSchema,
  type DesktopAPI,
  type DesktopEvent,
  type Result,
} from "../shared/contracts";
import type { Operation } from "../shared/operations";

export function webAPI(): DesktopAPI {
  let csrf: Promise<string> | undefined;
  let cursor = 0,
    controller: AbortController | undefined,
    retry: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(e: DesktopEvent) => void>();
  const emit = (e: DesktopEvent) => {
    for (const listener of listeners) listener(e);
  };
  const bootstrap = () =>
    (csrf ??= fetch("/api/bootstrap", {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok)
          throw new Error("Unable to connect to the local Synora service");
        return (await r.json()).csrf as string;
      })
      .catch((e) => {
        csrf = undefined;
        throw e;
      }));
  async function call<T>(
    operation: Operation,
    args: unknown[],
  ): Promise<Result<T>> {
    // No generic operation primitive is exported to the renderer or remote pages.
    while (args.length && args.at(-1) === undefined) args.pop();
    try {
      const token = await bootstrap();
      const response = await fetch(`/api/${operation}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Synora-CSRF": token },
        body: JSON.stringify(args),
        keepalive: operation === "saveDraft",
      });
      if (response.status === 403) csrf = undefined;
      return await response.json();
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "TRANSPORT_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Local service disconnected",
        },
      };
    }
  }
  async function events() {
    retry = undefined;
    const current = new AbortController();
    controller = current;
    try {
      const token = await bootstrap();
      if (current.signal.aborted) return;
      const response = await fetch("/api/events", {
        headers: { "X-Synora-CSRF": token, "Last-Event-ID": String(cursor) },
        credentials: "same-origin",
        signal: current.signal,
      });
      if (!response.ok || !response.body) {
        if (response.status === 403) csrf = undefined;
        throw new Error("Local event stream unavailable");
      }
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let pending = "";
      while (!current.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) throw new Error("Local event stream closed");
        pending += decoder.decode(value, { stream: true });
        if (pending.length > 2 * 1024 * 1024)
          throw new Error("Invalid local event frame");
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const block = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const lines = block.split("\n"),
            data = lines
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
          if (!data) continue;
          const id = Number(lines.find((l) => l.startsWith("id: "))?.slice(4));
          const event = JSON.parse(data) as DesktopEvent;
          if (!Number.isSafeInteger(id) || id < 0)
            throw new Error("Invalid local event sequence");
          if (event.kind === "resync" || id > cursor) {
            cursor = id;
            emit(event);
          }
        }
      }
    } catch (error) {
      if (!current.signal.aborted)
        emit({
          kind: "notice",
          message:
            "Local service connection interrupted. Reconnecting; do not repeat pending operations.",
        });
    } finally {
      if (controller === current) controller = undefined;
      if (!current.signal.aborted && listeners.size)
        retry = setTimeout(() => void events(), 1000);
    }
  }
  const api: DesktopAPI = {
    orchestrationConfigure: (id, plan) =>
      call("orchestrationConfigure", [id, plan]),
    delegationCancel: (id, task) => call("delegationCancel", [id, task]),
    delegationApprove: (id, task, approval, approved) =>
      call("delegationApprove", [id, task, approval, approved]),
    delegationAnswer: (id, task, question, answers) =>
      call("delegationAnswer", [id, task, question, answers]),
    coreUpdateStatus: () => call("coreUpdateStatus", []),
    coreUpdateCheck: () => call("coreUpdateCheck", []),
    coreUpdateAutomatic: (enabled) => call("coreUpdateAutomatic", [enabled]),
    coreUpdateInstall: (version) => call("coreUpdateInstall", [version]),
    coreUpdateRollback: (id, confirmed) =>
      call("coreUpdateRollback", [id, confirmed]),
    coreAccountStatus: () => call("coreAccountStatus", []),
    coreAccountRead: () => call("coreAccountRead", []),
    coreAccountLogin: (login) => call("coreAccountLogin", [login]),
    coreAccountCancel: (id) => call("coreAccountCancel", [id]),
    coreAccountOpen: (id) => call("coreAccountOpen", [id]),
    coreAccountLogout: () => call("coreAccountLogout", []),
    providerCredentialStatus: (id) => call("providerCredentialStatus", [id]),
    providerLoginStatus: () => call("providerLoginStatus", []),
    googleAccountStatus: (id) => call("googleAccountStatus", [id]),
    googleAccountForget: (id, confirmed) =>
      call("googleAccountForget", [id, confirmed]),
    googleAccountConfigure: (id, client) =>
      call("googleAccountConfigure", [id, client]),
    googleAccountDisconnect: (id, revoke) =>
      call("googleAccountDisconnect", [id, revoke]),
    googleLoginStatus: () => call("googleLoginStatus", []),
    googleLoginStart: (id) => call("googleLoginStart", [id]),
    googleLoginCancel: (id) => call("googleLoginCancel", [id]),
    googleLoginOpen: (id) => call("googleLoginOpen", [id]),
    providerLoginStart: (id, method) =>
      call("providerLoginStart", [id, method]),
    providerLoginSubmit: (id, code) => call("providerLoginSubmit", [id, code]),
    providerLoginCancel: (id) => call("providerLoginCancel", [id]),
    providerLoginOpen: (id) => call("providerLoginOpen", [id]),
    providerCredentialSave: (id, token) =>
      call("providerCredentialSave", [id, token]),
    providerCredentialDelete: (id) => call("providerCredentialDelete", [id]),
    mcpAuthorize: (id, provider) => call("mcpAuthorize", [id, provider]),
    mcpAuthorizationStatus: () => call("mcpAuthorizationStatus", []),
    mcpAuthorizationOpen: (id) => call("mcpAuthorizationOpen", [id]),
    mcpAuthorizationCancel: (id) => call("mcpAuthorizationCancel", [id]),
    backendStatus: () => call("backendStatus", []),
    closeReady: async () => ({ ok: true, value: undefined }),
    capabilities: () => call("capabilities", []),
    state: () => call("state", []),
    clipboardWriteText: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        return { ok: true, value: undefined };
      } catch {
        return { ok: false, error: { code: "CLIPBOARD_UNAVAILABLE", message: "Clipboard access failed. Nothing was copied." } };
      }
    },
    preferences: (p) => call("preferences", [p]),
    chooseWorkspace: (path) => call("chooseWorkspace", [path]),
    conversationWorkspace: (id, w) => call("conversationWorkspace", [id, w]),
    conversationUpdate: (id, patch) => call("conversationUpdate", [id, patch]),
    conversationPermission: (id, permission) => call("conversationPermission", [id, permission]),
    conversationForkDraft: (id, confirmed) => call("conversationForkDraft", [id, confirmed]),
    conversationDelete: (id, confirmed) => call("conversationDelete", [id, confirmed]),
    listFiles: (id, p) => call("listFiles", [id, p]),
    readFile: (id, p) => call("readFile", [id, p]),
    saveFile: (id, d) => call("saveFile", [id, d]),
    newConversation: (w, presetId) => call("newConversation", presetId === undefined ? [w] : [w, presetId]),
    saveDraft: (id, text) => call("saveDraft", [id, text]),
    discardQueuedMessage: (conversationId, messageId) =>
      call("discardQueuedMessage", [conversationId, messageId]),
    imageAttach: (id, value) => call("imageAttach", [id, value]),
    imageRead: (id, image) => call("imageRead", [id, image]),
    imageRemove: (id, image) => call("imageRemove", [id, image]),
    presetSave: (v, id) => call("presetSave", [v, id]),
    presetDelete: (id) => call("presetDelete", [id]),
    presetInstallTemplate: (id) => call("presetInstallTemplate", [id]),
    botCatalogRead: (refresh) => call("botCatalogRead", [refresh]),
    botCatalogPreview: (id, revision) => call("botCatalogPreview", [id, revision]),
    botCatalogImport: (id, confirmed) => call("botCatalogImport", [id, confirmed]),
    botCatalogUpdates: () => call("botCatalogUpdates", []),
    pluginDirectoryRead: (refresh) => call("pluginDirectoryRead", [refresh]),
    presetImport: () =>
      new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.addEventListener(
          "cancel",
          () => {
            input.remove();
            resolve({ ok: true, value: null });
          },
          { once: true },
        );
        input.addEventListener(
          "change",
          () =>
            void (async () => {
              try {
                const file = input.files?.[0];
                if (!file) {
                  resolve({ ok: true, value: null });
                  return;
                }
                if (file.size > 65536)
                  throw new Error("Preset file exceeds 64 KiB");
                const value = presetSchema.parse(JSON.parse(await file.text()));
                resolve(await api.presetSave(value));
              } catch (e) {
                resolve({
                  ok: false,
                  error: {
                    code: "INVALID_PRESET",
                    message: e instanceof Error ? e.message : "Invalid preset",
                  },
                });
              } finally {
                input.remove();
              }
            })(),
          { once: true },
        );
        input.hidden = true;
        document.body.append(input);
        input.click();
      }),
    presetExport: async (id) => {
      const result = await api.state();
      if (!result.ok) return result;
      const preset = result.value.presets.find((p) => p.id === id);
      if (!preset)
        return {
          ok: false,
          error: { code: "UNKNOWN_PRESET", message: "Unknown preset" },
        };
      const { id: _, ...value } = preset;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(presetSchema.parse(value), null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${preset.name.replace(/[^a-z0-9_-]/gi, "_")}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { ok: true, value: true };
    },
    integrationSave: (v, id) => call("integrationSave", [v, id]),
    integrationDelete: (id) => call("integrationDelete", [id]),
    engineConfigure: (config) => call("engineConfigure", [config]),
    engineNativeSetup: (providerId, workspaceId, mode) =>
      call("engineNativeSetup", [providerId, workspaceId, mode]),
    engineRestore: (id) => call("engineRestore", [id]),
    engineCompact: (id) => call("engineCompact", [id]),
    engineModels: (id) => call("engineModels", [id]),
    coreCatalogStatus: () => call("coreCatalogStatus", []),
    coreCatalogIcon: (request) => call("coreCatalogIcon", [request]),
    corePluginStatus: () => call("corePluginStatus", []),
    corePluginInspect: (catalog, marketplace, plugin) =>
      call("corePluginInspect", [catalog, marketplace, plugin]),
    corePluginChange: (review, action, confirmed) =>
      call("corePluginChange", [review, action, confirmed]),
    corePluginCancel: (id) => call("corePluginCancel", [id]),
    corePluginAuthorize: (id, server) =>
      call("corePluginAuthorize", [id, server]),
    coreCatalogRead: (provider, workspace, remote) =>
      call("coreCatalogRead", [provider, workspace, remote]),
    coreCatalogCancel: (id) => call("coreCatalogCancel", [id]),
    engineStart: (id, text, scenario, busy) =>
      call("engineStart", [id, text, scenario, busy]),
    engineCancel: () => call("engineCancel", []),
    engineAnswer: (id, answers) => call("engineAnswer", [id, answers]),
    engineApprove: (id, ok) => call("engineApprove", [id, ok]),
    engineSnapshot: () => call("engineSnapshot", []),
    engineReconnect: (after) => call("engineReconnect", [after]),
    terminalOpen: (w) => call("terminalOpen", [w]),
    terminalList: () => call("terminalList", []),
    terminalWrite: (id, input) => call("terminalWrite", [id, input]),
    terminalResize: (id, c, r) => call("terminalResize", [id, c, r]),
    terminalClose: (id) => call("terminalClose", [id]),
    controlStatus: () => call("controlStatus", []),
    controlConfigure: (grant) => call("controlConfigure", [grant]),
    controlApprove: (id, allow) => call("controlApprove", [id, allow]),
    controlStop: () => call("controlStop", []),
    browserOpen: (url) => call("browserOpen", [url]),
    browserNavigate: (id, url) => call("browserNavigate", [id, url]),
    browserAction: (id, action) => call("browserAction", [id, action]),
    browserLayout: (id, rect) => call("browserLayout", [id, rect]),
    browserList: () => call("browserList", []),
    browserFrame: (id) => call("browserFrame", [id]),
    browserInput: (id, input) => call("browserInput", [id, input]),
    metrics: () => call("metrics", []),
    onEvent: (listener) => {
      listeners.add(listener);
      if (!controller && !retry) void events();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          controller?.abort();
          controller = undefined;
          clearTimeout(retry);
          retry = undefined;
        }
      };
    },
  };
  return Object.freeze(api);
}
