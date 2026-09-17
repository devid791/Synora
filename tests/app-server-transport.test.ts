import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AppServerTransport,
  AppServerError,
  type RpcNotification,
  type RpcServerRequest,
} from "../src/engine/app-server-transport";
const fixture = fileURLToPath(
  new URL("./fixtures/app-server.mjs", import.meta.url),
);
function create(
  extra: Partial<ConstructorParameters<typeof AppServerTransport>[0]> = {},
) {
  const notifications: RpcNotification[] = [],
    requests: RpcServerRequest[] = [],
    closed: AppServerError[] = [];
  const transport = new AppServerTransport({
    executable: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    env: process.env,
    onNotification: (v) => notifications.push(v),
    onRequest: (v) => requests.push(v),
    onClose: (v) => closed.push(v),
    requestTimeoutMs: 1000,
    ...extra,
  });
  return { transport, notifications, requests, closed };
}
test("App Server JSONL preserves ordering, UTF-8, exact callback IDs and parallel correlation", async () => {
  const { transport: t, notifications, requests, closed } = create();
  try {
    await t.request("initialize", {});
    t.notify("initialized");
    const result = await Promise.all([
      t.request("echo", { id: "slow", delay: 30 }),
      t.request("echo", { id: "fast" }),
    ]);
    assert.deepEqual(result, [{ id: "slow", delay: 30 }, { id: "fast" }]);
    await t.request("unicode", {});
    assert.deepEqual(notifications[0], {
      method: "delta",
      params: { delta: "Hello 🛰️ città" },
    });
    await t.request("callback", {});
    assert.deepEqual(
      requests.map((r) => r.id),
      [7, "7"],
    );
    t.respond(7, { result: { decision: "decline" } });
    t.respond("7", { result: { decision: "accept" } });
    await t.request("echo", {});
    const answers = notifications
      .filter((n) => n.method === "answered")
      .map((n) => n.params as any);
    assert.deepEqual(
      answers.map((a) => a.id),
      [7, "7"],
    );
    assert.throws(() => t.respond(7, { result: {} }), /already answered/);
    assert.equal(t.activeRequests, 0);
    assert.equal(closed.length, 0);
  } finally {
    await t.close();
  }
  assert.equal(closed.length, 1);
  assert.throws(() => process.kill(t.pid!, 0));
});
test("App Server errors retain data; timeout releases pending request without confusing a late reply", async () => {
  const { transport: t } = create();
  try {
    await assert.rejects(
      t.request("fail", {}),
      (e: AppServerError) =>
        e.code === -32000 && (e.data as any).tool === "read_file",
    );
    await assert.rejects(
      t.request("echo", { delay: 100, value: "late" }, 20),
      (e: AppServerError) => e.code === "RPC_TIMEOUT",
    );
    assert.deepEqual(
      await t.request("echo", { delay: 150, value: "current" }),
      { delay: 150, value: "current" },
    );
    assert.equal(t.activeRequests, 0);
  } finally {
    await t.close();
  }
});
for (const method of ["exit", "broken", "truncated", "oversize"]) {
  test(`App Server ${method} rejects pending work and owns cleanup`, async () => {
    const { transport: t, closed } = create({ maxLineBytes: 2048 });
    try {
      await assert.rejects(t.request(method, {}));
      assert.equal(t.activeRequests, 0);
    } finally {
      await t.close();
    }
    assert.equal(closed.length, 1);
    assert.throws(() => process.kill(t.pid!, 0));
  });
}
test("App Server missing executable rejects cleanly without an uncaught process error", async () => {
  const { transport: t } = create({ executable: "/synora/missing/app-server" });
  await assert.rejects(t.request("initialize", {}), /ENOENT/);
  await t.close();
});

test("Core resources are released exactly once after normal close, crash or spawn failure", async () => {
  for (const scenario of ["normal", "exit", "missing"]) {
    let releases = 0;
    const { transport: t } = create({
      ...(scenario === "missing"
        ? { executable: "/synora/missing/app-server" }
        : {}),
      cleanup: async () => {
        releases++;
      },
    });
    if (scenario === "normal") await t.request("initialize", {});
    else
      await assert.rejects(
        t.request(scenario === "exit" ? "exit" : "initialize", {}),
      );
    await Promise.all([t.close(), t.close()]);
    assert.equal(releases, 1);
  }
});

if (process.platform !== "win32")
  for (const liveDescendant of [false, true])
    test(`Group EPERM is accepted only after independent confirmation of no live members: ${liveDescendant}`, async (context) => {
      const { transport: t } = create();
      const kill = process.kill.bind(process);
      if (liveDescendant) await t.request("orphan-exit-quiet", {});
      else await assert.rejects(t.request("exit", {}));
      for (let i = 0; i < 100; i++) {
        try {
          kill(t.pid!, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.throws(() => kill(t.pid!, 0));
      const denied = Object.assign(new Error("simulated group EPERM"), {
        code: "EPERM",
      });
      const mocked = context.mock.method(process, "kill", (pid, signal) => {
        if (pid === -t.pid!) throw denied;
        return kill(pid, signal);
      });
      try {
        if (liveDescendant)
          await assert.rejects(t.close(), (error) => error === denied);
        else await t.close();
      } finally {
        mocked.mock.restore();
        try {
          kill(-t.pid!, "SIGKILL");
        } catch (error) {
          if (
            !["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code!)
          )
            throw error;
        }
      }
    });

if (process.platform !== "win32")
  for (const method of ["orphan-exit", "orphan-exit-quiet"])
    test(`Closing Core reaps its owned SIGTERM-resistant descendant: ${method}`, async () => {
      const { transport: t } = create();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const childPid = await t.request(method, {});
        assert.equal(typeof childPid, "number");
        // Observe the leader exit, not a timing guess; the descendant still holds
        // stdout/stderr open, so Node has not emitted the child's close event.
        for (let i = 0; i < 100; i++) {
          try {
            process.kill(t.pid!, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.throws(() => process.kill(t.pid!, 0));
        await Promise.race([
          t.close(),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(Error("Owned descendant kept Core pipes open")),
              7000,
            );
          }),
        ]);
        assert.equal(t.diagnostics.closed, true);
        const stopped = async () => {
          try {
            const result = await promisify(execFile)("ps", [
              "-p",
              String(childPid),
              "-o",
              "stat=",
            ]);
            return result.stdout.trim().startsWith("Z");
          } catch (error) {
            if ((error as { code?: number }).code === 1) return true;
            throw error;
          }
        };
        for (let i = 0; i < 100 && !(await stopped()); i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(
          await stopped(),
          true,
          "Owned descendant must no longer execute",
        );
      } finally {
        clearTimeout(deadline);
        // Exact process group created by this fixture, including failed assertions.
        try {
          process.kill(-t.pid!, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await t.close();
      }
    });
