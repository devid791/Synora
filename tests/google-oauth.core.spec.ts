import { test, expect } from "@playwright/test";
import { networkInterfaces } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { controlledGemini } from "./fixtures/gemini-upstream";
import { LiveEngine } from "../src/engine/live-engine";
import { prepareGeminiWithOAuth } from "../src/engine/gemini-provider";
import { GoogleAccounts } from "../src/main/google-accounts";
import {
  GOOGLE_ENDPOINT,
  GOOGLE_SCOPE,
  GoogleLogin,
  GoogleOAuthTransport,
} from "../src/engine/google-oauth";
import { sha256File } from "../src/engine/core-runtime";
import type { EngineBinding } from "../src/shared/contracts";
test("Google OAuth with original Core: browser grant, refresh between real tool calls, cold session, cancellation and exact native history", async () => {
  expect(Object.keys(networkInterfaces()).sort()).toEqual(["lo"]);
  let now = Date.now(),
    tokens = 0,
    currentToken = "";
  const quotaProject = "synora-fixture";
  const headers: any[] = [];
  const f = await controlledGemini({
    verify: (h) => {
      expect(h.authorization).toBe(`Bearer ${currentToken}`);
      expect(h["x-goog-api-key"]).toBeUndefined();
      expect(h["x-goog-user-project"]).toBe(quotaProject);
      headers.push({ authorized: true, tokenGeneration: tokens, quotaProject });
    },
    afterGeneration: () => {
      now += 3600001;
    },
  });
  const provider = {
    id: "google",
    name: "Controlled OAuth",
    providerType: "gemini" as const,
    endpoint: GOOGLE_ENDPOINT,
    kind: "provider" as const,
    enabled: true,
    auth: "oauth" as const,
    tools: [],
  };
  const client = {
    clientId: "synora-fixture.apps.googleusercontent.com",
    quotaProject,
  };
  const transport = new GoogleOAuthTransport(
    async (_u, options) => {
      const body = new URLSearchParams(String(options?.body));
      if (tokens === 0)
        expect(body.get("grant_type")).toBe("authorization_code");
      else expect(body.get("grant_type")).toBe("refresh_token");
      currentToken = `CONTROLLED_GOOGLE_TOKEN_${++tokens}`;
      return Response.json({
        access_token: currentToken,
        refresh_token: "CONTROLLED_GOOGLE_REFRESH",
        scope: GOOGLE_SCOPE,
        token_type: "Bearer",
        expires_in: 3600,
      });
    },
    () => now,
  );
  const directory = join(f.directory, "oauth-state");
  let accounts = new GoogleAccounts(directory, undefined, transport, () => now);
  const login = new GoogleLogin({
    transport,
    save: (_id, c, g) => accounts.saveGrant(provider, c, g),
  });
  let binding: EngineBinding | undefined, engine: LiveEngine | undefined;
  const events: any[] = [];
  const create = () =>
    new LiveEngine(
      {
        provider: "synora_gemini",
        executable: f.wrapper,
        stateDirectory: join(f.directory, "core-oauth"),
        endpoint: f.endpoint,
        model: "gemini-fixture-native",
        authorization: async () =>
          (await accounts.access(provider)).accessToken,
        context: () => ({
          cwd: f.workspace,
          profile: "",
          context: null,
          binding,
        }),
        bind: (_id, b) => {
          binding = b;
        },
        sink: (e) => events.push(e),
      },
      prepareGeminiWithOAuth((s) => accounts.access(provider, s)),
    );
  try {
    await accounts.configure(provider, client);
    const pending = await login.start(provider.id, client),
      auth = new URL(pending.authorizationUrl!);
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({
      state: auth.searchParams.get("state")!,
      code: "controlled-code",
    }).toString();
    const grant = await fetch(callback);
    expect(grant.status).toBe(200);
    await grant.text();
    expect(login.snapshot()?.status).toBe("authorized");
    engine = create();
    await engine.start(
      "google-oauth-conversation",
      "Read provider-check.txt",
      "text",
    );
    await expect
      .poll(() => (f.errors.length ? f.errors : engine!.snapshot().status), {
        timeout: 30000,
      })
      .toBe("completed");
    const first = engine.snapshot();
    expect(
      first.items.some(
        (i) => i.type === "commandExecution" && i.status === "completed",
      ),
    ).toBe(true);
    expect(JSON.stringify(f.state.toolResult)).toContain(
      "SYNORA_PROVIDER_FILE_OK",
    );
    expect(first.firstDeltaAt).toBeLessThan(first.completedAt!);
    expect(tokens).toBe(2); // refresh inside the SAME running Core before tool-result turn
    await engine.dispose();
    accounts = new GoogleAccounts(directory, undefined, transport, () => now);
    engine = create();
    await engine.start(
      "google-oauth-conversation",
      "Confirm the same file result",
      "text",
    );
    await expect
      .poll(() => (f.errors.length ? f.errors : engine!.snapshot().status), {
        timeout: 30000,
      })
      .toBe("completed");
    expect(engine.snapshot().sessionId).toBe(first.sessionId);
    expect(engine.snapshot().threadId).toBe(first.threadId);
    f.state.hold = true;
    await engine.start(
      "google-oauth-conversation",
      "Hold for cancellation",
      "text",
    );
    await expect.poll(() => f.state.heldRequests).toBe(1);
    await engine.cancel();
    await expect.poll(() => f.state.cancelledStreams).toBe(1);
    expect(engine.snapshot().status).toBe("interrupted");
    expect(engine.snapshot().cleanupPending ?? false).toBe(false);
    f.state.hold = false;
    await engine.start(
      "google-oauth-conversation",
      "Continue after cancellation",
      "text",
    );
    await expect
      .poll(() => (f.errors.length ? f.errors : engine!.snapshot().status), {
        timeout: 30000,
      })
      .toBe("completed");
    expect(engine.snapshot().threadId).toBe(first.threadId);
    expect(f.errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/google-oauth-core.json",
      JSON.stringify(
        {
          passed: true,
          scope:
            "Original Core actual tools, native Gemini contract; controlled OAuth/model endpoint, NOT public Google consent/inference",
          coreSha256: await sha256File(f.core),
          first,
          final: engine.snapshot(),
          binding,
          events,
          tokensIssued: tokens,
          headers,
          requests: f.requests,
          signed: f.signed,
          toolResult: f.state.toolResult,
          cancellations: f.state.cancelledStreams,
          errors: f.errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await login.dispose();
    await engine?.dispose();
    await f.close();
  }
});
