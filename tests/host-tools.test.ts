import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { LiveEngine } from "../src/engine/live-engine";
import type { HostTools } from "../src/engine/host-tools";
import type { EngineBinding } from "../src/shared/contracts";
const fixture = fileURLToPath(
  new URL("./fixtures/live-app-server.mjs", import.meta.url),
);
async function until(fn: () => boolean) {
  const end = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > end) throw Error("Host tool fixture deadline");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function setup(
  scenario: string,
  call: HostTools["call"],
  mounted = true,
  hooks?: {
    bind?: (binding: EngineBinding) => void;
    tools?: (tools: HostTools) => void;
    prepared?: () => void;
  },
) {
  let binding: EngineBinding | undefined;
  const hostTools: HostTools = {
    catalog: [
      {
        type: "function",
        name: "synora_delegate",
        description: "Owned task fixture",
        inputSchema: {
          type: "object",
          properties: {
            worker_id: { type: "string" },
            task: { type: "string" },
          },
          required: ["worker_id", "task"],
          additionalProperties: false,
        },
      },
    ],
    call,
  };
  hooks?.tools?.(hostTools);
  const engine = new LiveEngine(
    {
      stateDirectory: "/synora-fixture",
      endpoint: "http://127.0.0.1:9999/codex/v1",
      model: "qwen3.8-27b-nvfp4",
      context: () => ({
        cwd: "/synora-fixture",
        profile: "ultra-fast",
        context: 262144,
        binding,
        ...(mounted ? { hostTools } : {}),
      }),
      bind: (_id, b) => {
        binding = b;
        hooks?.bind?.(b);
      },
      sink: () => {},
    },
    async () => {
      hooks?.prepared?.();
      return {
        executable: process.execPath,
        cwd: process.cwd(),
        env: process.env,
        args: [fixture, scenario],
        models: [],
      };
    },
  );
  return engine;
}
test("Pinned dynamic tool keeps original call/RPC identity and resumes its original catalog", async () => {
  let calls = 0;
  const engine = setup("host-tool", async (p, signal) => {
    assert.equal(signal.aborted, false);
    assert.equal(p.callId, "host-original-call-id");
    assert.equal(p.tool, "synora_delegate");
    assert.deepEqual(p.arguments, {
      worker_id: "worker_one",
      task: "owned task",
    });
    calls++;
    return {
      success: true,
      contentItems: [{ type: "inputText", text: "REAL_HANDLER_RESULT" }],
    };
  });
  try {
    for (let i = 0; i < 2; i++) {
      await engine.start("owned", "fixture", "text");
      await until(() => engine.snapshot().status === "completed");
      assert.match(
        JSON.stringify(engine.snapshot().items),
        /REAL_HANDLER_RESULT/,
      );
    }
    assert.equal(calls, 2);
  } finally {
    await engine.dispose();
  }
});

test("Persisted host tool catalog matches on resume; a changed catalog fails before process or inference", async () => {
  let host: HostTools | undefined,
    saved: EngineBinding | undefined,
    prepared = 0;
  const engine = setup(
    "host-tool",
    async () => ({
      success: true,
      contentItems: [{ type: "inputText", text: "REAL_HANDLER_RESULT" }],
    }),
    true,
    {
      tools: (value) => {
        host = value;
      },
      bind: (value) => {
        saved = value;
      },
      prepared: () => {
        prepared++;
      },
    },
  );
  try {
    await engine.start("owned", "fixture", "text");
    await until(() => engine.snapshot().status === "completed");
    assert.match(saved!.hostToolCatalogHash!, /^[a-f0-9]{64}$/);
    const original = structuredClone(saved),
      before = prepared;
    host!.catalog[0].description = "Changed wire catalog";
    await assert.rejects(
      engine.start("owned", "must not generate", "text"),
      /host tool catalog/,
    );
    assert.equal(prepared, before);
    assert.deepEqual(saved, original);
  } finally {
    await engine.dispose();
  }
});
test("Unregistered and foreign-turn host calls are rejected without invoking executor", async () => {
  for (const scenario of ["host-tool-unmounted", "host-tool-foreign"]) {
    let calls = 0;
    const engine = setup(
      scenario,
      async () => {
        calls++;
        throw Error("must not execute");
      },
      scenario !== "host-tool-unmounted",
    );
    try {
      await engine.start("owned", "fixture", "text");
      await until(() => engine.snapshot().status === "completed");
      assert.equal(calls, 0);
      assert.match(JSON.stringify(engine.snapshot().items), /not mounted/);
    } finally {
      await engine.dispose();
    }
  }
});
test("Executor failure returns explicit unsuccessful tool response", async () => {
  const engine = setup("host-tool", async () => {
    throw Error("Owned executor failure");
  });
  try {
    await engine.start("owned", "fixture", "text");
    await until(() => engine.snapshot().status === "completed");
    const text = engine
      .snapshot()
      .items.filter((i) => i.type === "agentMessage")
      .map((i) => i.text)
      .join("");
    assert.equal(JSON.parse(text).result.success, false);
    assert.match(text, /Owned executor failure/);
  } finally {
    await engine.dispose();
  }
});
test("Cancelling a turn aborts the dynamic handler and does not send its late reply", async () => {
  let aborted = false;
  const engine = setup("host-tool", async (_p, signal) => {
    await new Promise<void>((r) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          r();
        },
        { once: true },
      ),
    );
    return {
      success: true,
      contentItems: [{ type: "inputText", text: "LATE_RESULT" }],
    };
  });
  try {
    await engine.start("owned", "fixture", "text");
    await new Promise((r) => setTimeout(r, 30));
    await engine.cancel();
    assert.equal(aborted, true);
    assert.equal(engine.snapshot().status, "interrupted");
    assert.doesNotMatch(JSON.stringify(engine.snapshot().items), /LATE_RESULT/);
  } finally {
    await engine.dispose();
  }
});
