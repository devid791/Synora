import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeToolSetup } from "../src/engine/windows-setup";
import type { TransportOptions } from "../src/engine/app-server-transport";

function factory(scenario = "success") {
  const calls: string[] = [];
  let setups = 0,
    closed = 0,
    connections = 0;
  const transport = (o: TransportOptions) => {
    connections++;
    return {
      async request<T>(method: string, params?: unknown): Promise<T> {
        calls.push(method);
        if (method === "initialize") return {} as T;
        if (method === "windowsSandbox/readiness")
          return {
            status:
              scenario === "malformed"
                ? "maybe"
                : setups
                  ? "ready"
                  : "notConfigured",
          } as T;
        if (method === "windowsSandbox/setupStart") {
          setups++;
          const mode = (params as { mode: string }).mode;
          if (scenario !== "timeout")
            queueMicrotask(() =>
              o.onNotification({
                method: "windowsSandbox/setupCompleted",
                params: {
                  mode: scenario === "wrong-mode" ? "elevated" : mode,
                  success: scenario !== "failed",
                  error: scenario === "failed" ? "Setup declined" : null,
                },
              }),
            );
          return { started: true } as T;
        }
        throw new Error(`Unexpected RPC: ${method}`);
      },
      notify(method: string) {
        calls.push(method);
      },
      respond() {
        throw new Error("No tool execution is authorized by this fixture");
      },
      async close() {
        closed++;
      },
    };
  };
  return { transport, calls, counts: () => ({ setups, closed, connections }) };
}
test("Native prerequisite checks are OS-specific and cannot silently run Windows setup on Linux", async () => {
  const f = factory();
  const options = {
    platform: "linux" as const,
    stateDirectory: "/unused",
    cwd: "/unused",
    transport: f.transport,
  };
  assert.deepEqual(await nativeToolSetup(options), {
    platform: "linux",
    status: "notApplicable",
  });
  await assert.rejects(
    nativeToolSetup({ ...options, mode: "elevated" }),
    /only available on a Windows/,
  );
  assert.deepEqual(f.calls, []);
});
test("Windows readiness uses original schema and never starts setup or inference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-setup-test-"));
  try {
    const f = factory();
    assert.deepEqual(
      await nativeToolSetup({
        platform: "win32",
        executable: process.execPath,
        stateDirectory: dir,
        cwd: dir,
        transport: f.transport,
      }),
      { platform: "win32", status: "notConfigured" },
    );
    assert.deepEqual(f.calls, [
      "initialize",
      "initialized",
      "windowsSandbox/readiness",
    ]);
    assert.equal(f.counts().closed, 1);
    const bad = factory("malformed");
    await assert.rejects(
      nativeToolSetup({
        platform: "win32",
        executable: process.execPath,
        stateDirectory: dir,
        cwd: dir,
        transport: bad.transport,
      }),
      /Invalid App Server windowsReadiness/,
    );
    assert.equal(bad.counts().closed, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Windows setup requires matching successful terminal event and fresh-process readiness", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-setup-test-"));
  try {
    const timeouts: number[] = [];
    const originalTimeout = globalThis.setTimeout;
    t.mock.method(
      globalThis,
      "setTimeout",
      (handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => {
        timeouts.push(timeout ?? 0);
        return originalTimeout(handler, timeout, ...args);
      },
    );
    const f = factory();
    assert.deepEqual(
      await nativeToolSetup({
        platform: "win32",
        executable: process.execPath,
        stateDirectory: dir,
        cwd: dir,
        mode: "unelevated",
        transport: f.transport,
      }),
      { platform: "win32", status: "ready" },
    );
    assert.equal(f.counts().connections, 2);
    assert.ok(
      timeouts.includes(600000),
      "Official ACL setup has a separate ten-minute completion deadline",
    );
    assert.deepEqual(f.calls, [
      "initialize",
      "initialized",
      "windowsSandbox/setupStart",
      "initialize",
      "initialized",
      "windowsSandbox/readiness",
    ]);
    for (const [scenario, error] of [
      ["failed", /Setup declined/],
      ["wrong-mode", /different Windows setup mode/],
      ["timeout", /has not completed/],
    ] as const) {
      const fault = factory(scenario);
      await assert.rejects(
        nativeToolSetup({
          platform: "win32",
          executable: process.execPath,
          stateDirectory: dir,
          cwd: dir,
          mode: "unelevated",
          transport: fault.transport,
          timeoutMs: 25,
        }),
        error,
      );
      assert.equal(fault.counts().closed, 1);
      assert.equal(fault.counts().connections, 1);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
