import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { request } from "node:http";
import { startWebService } from "../src/web/server";
import { terminalMarker } from "./terminal-fixture";

test("Loopback web boundary rejects hostile Host, Origin, CSRF, malformed and unknown operations; same-origin service persists real work", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synora-web-service-"));
  await fs.mkdir(path.join(dir, "assets"));
  await fs.mkdir(path.join(dir, "work"));
  await fs.writeFile(
    path.join(dir, "assets/index.html"),
    "<title>Fixture</title>",
  );
  await fs.writeFile(path.join(dir, "work/note.txt"), "actual file");
  const options = {
    storePath: path.join(dir, "state.sqlite"),
    assets: path.join(dir, "assets"),
    speed: 0.01,
    browserFactory: () => ({
      open: () => [],
      navigate: () => {},
      action: () => [],
      list: () => [],
      layout: () => {},
      dispose: () => {},
    }),
  };
  let server = await startWebService(options);
  try {
    const url = server.url;
    assert.equal((await fetch(url)).status, 200);
    assert.equal(
      (
        await fetch(url + "/api/state", {
          method: "POST",
          headers: { Origin: "https://evil.invalid" },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(url + "/api/bootstrap")).status, 403);
    // Node fetch owns Host; use raw HTTP to actually send the hostile header.
    const hostileHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          url,
          { headers: { Host: "evil.invalid" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    assert.equal(hostileHost, 403);
    assert.equal((await fetch(url + "/.env")).status, 404);
    const boot = await fetch(url + "/api/bootstrap", {
      headers: { Origin: url },
    });
    assert.equal(boot.status, 200);
    const cookie = boot.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const headers = {
      Origin: url,
      Cookie: cookie.split(";")[0],
      "Content-Type": "application/json",
      "X-Synora-CSRF": (await boot.json()).csrf,
    };
    const call = async (name: string, args: unknown[]) => {
      const r = await fetch(url + "/api/" + name, {
        method: "POST",
        headers,
        body: JSON.stringify(args),
      });
      return { status: r.status, ...(await r.json()) };
    };
    assert.equal(
      (
        await fetch(url + "/api/state", {
          method: "POST",
          headers: { ...headers, "X-Synora-CSRF": "wrong" },
          body: "[]",
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(url + "/api/state", { method: "POST", headers, body: "{" }))
        .status,
      400,
    );
    assert.equal((await call("execute", ["anything"])).status, 404);
    assert.equal((await call("clipboardWriteText", ["must not reach the service host clipboard"])).status, 404);
    assert.equal((await call("state", [1])).status, 400);
    assert.equal(
      (
        await fetch(url + "/api/state", {
          method: "POST",
          headers,
          body: JSON.stringify(["x".repeat(3 * 1024 * 1024)]),
        })
      ).status,
      413,
    );
    assert.equal(
      (await call("preferences", [{ profile: "invented" }])).status,
      400,
    );
    const capabilities = (await call("capabilities", [])).value;
    assert.equal(capabilities.platform, "web");
    assert.equal(capabilities.liveInference, false);
    const w = (await call("chooseWorkspace", [path.join(dir, "work")])).value;
    const c = (await call("newConversation", [null])).value;
    assert.equal((await call("conversationWorkspace", [c.id, w.id])).ok, true);
    assert.equal(
      (await call("conversationWorkspace", [c.id, "unknown"])).ok,
      false,
    );
    const document = (await call("readFile", [w.id, "note.txt"])).value;
    assert.equal(document.content, "actual file");
    assert.equal(
      (await call("saveFile", [w.id, { ...document, content: "web saved" }]))
        .ok,
      true,
    );
    assert.equal(
      await fs.readFile(path.join(dir, "work/note.txt"), "utf8"),
      "web saved",
    );
    assert.equal((await call("readFile", [w.id, "../state.sqlite"])).ok, false);
    const config = {
      id: "test-provider",
      name: "Test",
      kind: "provider",
      endpoint: "",
      auth: "none",
      tools: [],
      enabled: false,
    };
    assert.equal((await call("integrationSave", [config])).ok, true);
    assert.equal((await call("integrationSave", [config])).ok, false);
    assert.equal(
      (await call("integrationSave", [{ ...config, id: "changed" }, config.id]))
        .ok,
      false,
    );
    assert.equal(
      (
        await call("integrationSave", [
          { ...config, name: "Edited" },
          config.id,
        ])
      ).ok,
      true,
    );
    const controller = new AbortController();
    const stream = await fetch(url + "/api/events", {
      headers,
      signal: controller.signal,
    });
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    const reader = stream.body!.getReader();
    let events = "";
    const consume = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          events += new TextDecoder().decode(value);
        }
      } catch (e) {
        if (!controller.signal.aborted) throw e;
      }
    })();
    assert.equal((await call("engineStart", [c.id, "Hello", "tool"])).ok, true);
    const deadline = Date.now() + 5000;
    while (!events.includes("turn/completed")) {
      assert.ok(Date.now() < deadline, "SSE terminal event deadline");
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.match(events, /agentMessage\/delta/);
    assert.match(events, /item\/completed/);
    controller.abort();
    await consume;
    const ids = [...events.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    const cursor = ids.at(-1)!;
    assert.deepEqual(
      ids,
      [...new Set(ids)].sort((a, b) => a - b),
    );
    await call("engineStart", [
      c.id,
      "Generated during transport disconnect",
      "text",
    ]);
    const replayDeadline = Date.now() + 5000;
    while (server.service.engine.snapshot().status !== "completed") {
      assert.ok(Date.now() < replayDeadline);
      await new Promise((r) => setTimeout(r, 10));
    }
    const reconnected = await fetch(url + "/api/events", {
      headers: { ...headers, "Last-Event-ID": String(cursor) },
    });
    const replayReader = reconnected.body!.getReader();
    let replay = "";
    while (!replay.includes("turn/completed")) {
      const r = await replayReader.read();
      assert.equal(r.done, false);
      replay += new TextDecoder().decode(r.value);
    }
    await replayReader.cancel();
    const replayIds = [...replay.matchAll(/^id: (\d+)$/gm)].map((m) =>
      Number(m[1]),
    );
    assert.ok(replayIds.length > 1);
    assert.ok(replayIds.every((id) => id > cursor));
    assert.deepEqual(
      replayIds,
      [...new Set(replayIds)].sort((a, b) => a - b),
    );
    assert.match(replay, /agentMessage\/delta/);
    const stale = await fetch(url + "/api/events", {
      headers: { ...headers, "Last-Event-ID": "999999" },
    });
    const staleReader = stale.body!.getReader();
    const staleEvent = await staleReader.read();
    assert.match(new TextDecoder().decode(staleEvent.value), /"kind":"resync"/);
    await staleReader.cancel();
    assert.equal(
      (
        await fetch(url + "/api/events", {
          headers: { ...headers, "Last-Event-ID": "not-a-number" },
        })
      ).status,
      400,
    );
    const opened = await call("terminalOpen", [w.id]);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const terminal = opened.value;
    assert.ok(terminal.pid > 0);
    await call("terminalWrite", [
      terminal.id,
      terminalMarker("WEB_PTY", 0) + "\r",
    ]);
    const terminalDeadline = Date.now() + 4000;
    let terms;
    do {
      terms = (await call("terminalList", [])).value;
      if (terms[0].status === "exited") break;
      assert.ok(Date.now() < terminalDeadline);
      await new Promise((r) => setTimeout(r, 15));
    } while (true);
    assert.match(terms[0].output, /WEB_PTY/);
    assert.throws(() => process.kill(terminal.pid, 0));
    await call("saveDraft", [c.id, "persistent web draft"]);
    await server.close();
    server = await startWebService(options);
    const restored = server.service.store.read();
    assert.equal(restored.conversations[0].draft, "persistent web draft");
    assert.equal(restored.conversations[0].workspaceId, w.id);
    assert.equal(restored.integrations.length, 1);
    assert.equal(restored.integrations[0].name, "Edited");
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true });
  }
});
