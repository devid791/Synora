import test from "node:test";
import assert from "node:assert/strict";
import { hostToolContext } from "../src/engine/host-tool-context";

test("Windows executor guidance uses actual cwd without rewriting tools or base instructions", () => {
  const cwd = "C:\\QA project\\unicode-é\\line\nname";
  const context = hostToolContext(cwd, "win32");
  assert.deepEqual(Object.keys(context), ["developerInstructions"]);
  assert.ok(context.developerInstructions!.includes(JSON.stringify(cwd)));
  assert.match(context.developerInstructions!, /workspace-relative paths/);
  assert.match(context.developerInstructions!, /PowerShell/);
  assert.match(
    context.developerInstructions!,
    /Do not repeat identical failed arguments/,
  );
  assert.match(
    context.developerInstructions!,
    /do not change the tool catalog, approvals, sandbox/,
  );
});

test("Non-Windows executor instructions are unchanged", () => {
  for (const platform of ["linux", "darwin"] as const)
    assert.deepEqual(hostToolContext("/qa/project", platform), {});
});
