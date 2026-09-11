import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { configSchema } from "../src/shared/contracts";
import { mcpConfiguration } from "../src/engine/mcp-config";
import { integrationServerName } from "../src/shared/integration-runtime";
const base = {
  id: "a-b",
  name: "Web",
  kind: "connector" as const,
  executor: "searxng" as const,
  endpoint: "https://example.org",
  enabled: true,
  auth: "none" as const,
  tools: [],
};
test("MCP configuration rejects mismatched executors, secrets, invalid URLs and arbitrary executable fields", () => {
  for (const patch of [
    { kind: "provider" },
    { executor: "http-mcp" },
    { endpoint: "" },
    { endpoint: "file:///etc/passwd" },
    { endpoint: "https://user:password@example.org" },
    { endpoint: "https://example.org?secret=x" },
    { auth: "oauth" },
    { command: "/bin/sh" },
  ])
    assert.equal(configSchema.safeParse({ ...base, ...patch }).success, false);
  assert.notEqual(integrationServerName("a-b"), integrationServerName("ab"));
});
test("MCP uses executor configuration, never declared names or disabled entries", async () => {
  assert.deepEqual(
    await mcpConfiguration([
      { ...base, enabled: false },
      { ...base, executor: "configuration-only", tools: ["made_up"] },
    ]),
    { mcp_oauth_credentials_store: "file" },
  );
  const c = await mcpConfiguration([
    { ...base, kind: "mcp", executor: "http-mcp", tools: ["made_up"] },
  ]);
  assert.equal(c["mcp_servers.synora_a_b.url"], "https://example.org");
  assert.equal(c["mcp_servers.synora_a_b.enabled"], true);
  assert.ok(!JSON.stringify(c).includes("made_up"));
});
test("Native web executor verifies binary receipt, platform and controlled environment", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-mcp-manifest-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "controlled-test-executable");
  const bytes = "fixture bytes; never executed";
  await writeFile(path, bytes, { mode: 0o700 });
  const manifest = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    platform: process.platform,
    arch: process.arch,
  };
  await writeFile(
    join(directory, "web-mcp-manifest.json"),
    JSON.stringify(manifest),
  );
  const prior = process.env.SYNORA_WEB_MCP_BINARY;
  process.env.SYNORA_WEB_MCP_BINARY = path;
  try {
    const c = await mcpConfiguration([base]);
    assert.equal(c["mcp_servers.synora_a_b.command"], await realpath(path));
    assert.deepEqual(c["mcp_servers.synora_a_b.enabled_tools"], [
      "web_search",
      "web_fetch",
    ]);
    assert.equal(
      c["mcp_servers.synora_a_b.env.AXIOM_SEARCH_URL"],
      base.endpoint,
    );
    await writeFile(path, "changed");
    await assert.rejects(mcpConfiguration([base]), /platform\/hash receipt/);
  } finally {
    if (prior === undefined) delete process.env.SYNORA_WEB_MCP_BINARY;
    else process.env.SYNORA_WEB_MCP_BINARY = prior;
  }
});
