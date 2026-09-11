import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cancelTurnTerminals } from "../src/engine/cancel-terminals";
import type { ThreadItem } from "../src/protocol/codex-0.153.4/v2/ThreadItem";

const command: Extract<ThreadItem, { type: "commandExecution" }> = JSON.parse(
  readFileSync(new URL("./fixtures/live-base.json", import.meta.url), "utf8"),
).command;
const item = (id: string, processId: string | null): ThreadItem => ({
  ...command,
  type: "commandExecution",
  id,
  processId,
});
const terminal = (itemId: string, processId: string) => ({
  itemId,
  processId,
  command: "fixture only",
  cwd: "/fixture",
  osPid: 999,
  cpuPercent: 0.5,
  rssKb: 100,
});
type Rpc = (method: string, params: unknown, ms?: number) => Promise<unknown>;
const run = (
  request: Rpc,
  items = [item("current", "opaque-current")],
  timeout = 500,
) =>
  cancelTurnTerminals(
    { request },
    "owned-thread",
    () => items,
    performance.now() + timeout,
  );

test("Cancellation inventories every page and only terminates the cancelled turn's Core IDs", async () => {
  const calls: unknown[] = [];
  let live = true;
  await run(async (method, raw, ms) => {
    const p = raw as { threadId: string; cursor?: string; processId?: string };
    assert.equal(p.threadId, "owned-thread");
    assert.ok(ms! > 0 && ms! <= 500);
    calls.push([method, p]);
    if (method.endsWith("/terminate")) {
      assert.equal(p.processId, "opaque-current");
      live = false;
      return { terminated: true };
    }
    assert.equal(method, "thread/backgroundTerminals/list");
    if (!p.cursor)
      return {
        data: [terminal("earlier-turn", "keep-alive")],
        nextCursor: "page-2",
      };
    assert.equal(p.cursor, "page-2");
    return {
      data: live ? [terminal("current", "opaque-current")] : [],
      nextCursor: null,
    };
  });
  assert.equal(calls.length, 5);
});

test("Late Core process ID is accepted only for an owned item; false termination requires confirmed disappearance", async () => {
  let live = true,
    inventories = 0,
    terminations = 0;
  await run(
    async (method) => {
      if (method.endsWith("/terminate")) {
        terminations++;
        live = false;
        return { terminated: false };
      }
      inventories++;
      return { data: live ? [terminal("current", "late-core-id")] : [] };
    },
    [item("current", null)],
  );
  assert.equal(terminations, 1);
  assert.equal(inventories, 2);
});

test("Cancellation rejects malformed inventories/results, reused IDs and repeated cursors without broad cleanup", async () => {
  for (const variant of [
    "malformed",
    "mismatch",
    "cursor",
    "result",
    "conflict",
  ] as const) {
    let signals = 0;
    await assert.rejects(
      run(
        async (method) => {
          if (method.endsWith("/terminate")) {
            signals++;
            return { terminated: "yes" };
          }
          assert.equal(method, "thread/backgroundTerminals/list");
          if (variant === "malformed") return { data: [{ processId: "x" }] };
          if (variant === "mismatch")
            return { data: [terminal("current", "reused")] };
          if (variant === "cursor") return { data: [], nextCursor: "repeated" };
          if (variant === "conflict")
            return {
              data: [
                terminal("current", "opaque-current"),
                terminal("second", "opaque-current"),
              ],
            };
          return { data: [terminal("current", "opaque-current")] };
        },
        [item("current", "opaque-current"), item("second", null)],
      ),
      /Invalid App Server|identity|cursor/,
    );
    assert.equal(signals, variant === "result" ? 1 : 0);
  }
});

test("Both false and true termination receipts must converge before the shared cleanup deadline", async () => {
  for (const terminated of [false, true]) {
    let lists = 0;
    await assert.rejects(
      run(
        async (method) => {
          if (method.endsWith("/terminate")) return { terminated };
          lists++;
          return { data: [terminal("current", "opaque-current")] };
        },
        undefined,
        65,
      ),
      /deadline/,
    );
    assert.ok(lists >= 1);
  }
});

test("Unsupported Core terminal RPC is an explicit cancellation failure", async () => {
  await assert.rejects(
    run(async () => {
      throw Error("-32601: Method not found");
    }),
    /Method not found/,
  );
});
