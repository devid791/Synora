import test from "node:test";
import assert from "node:assert/strict";
import {
  commandDecisionAllowed,
  coreClockResponse,
  deviceVerificationError,
} from "../src/shared/core-compatibility";
test("Clock returns whole Unix seconds only for owned root/child identities", () => {
  const owned = new Set(["root", "child"]);
  assert.deepEqual(coreClockResponse({ threadId: "root" }, owned, 10099), {
    result: { currentTimeAt: 10 },
  });
  assert.deepEqual(coreClockResponse({ threadId: "child" }, owned, 10099), {
    result: { currentTimeAt: 10 },
  });
  for (const params of [null, {}, { threadId: 1 }, { threadId: "other" }])
    assert.equal(coreClockResponse(params, owned).error?.code, -32602);
});
test("Device authentication fails explicitly without fabricated proof or foreign identity", () => {
  const owned = new Set(["root"]);
  assert.equal(
    deviceVerificationError({ threadId: "root" }, owned).error.code,
    -32601,
  );
  assert.equal(
    deviceVerificationError({ threadId: "foreign" }, owned).error.code,
    -32602,
  );
  assert.equal(deviceVerificationError(null, owned).error.code, -32602);
  assert.ok(
    !("result" in deviceVerificationError({ threadId: "root" }, owned)),
  );
});
test("New advertised approval decisions stay exact; no implicit wider permission grant", () => {
  assert.equal(commandDecisionAllowed({}, "accept"), true);
  assert.equal(
    commandDecisionAllowed({ availableDecisions: null }, "decline"),
    true,
  );
  assert.equal(
    commandDecisionAllowed({ availableDecisions: ["decline"] }, "accept"),
    false,
  );
  assert.equal(
    commandDecisionAllowed({ availableDecisions: ["decline"] }, "decline"),
    true,
  );
  for (const choices of [
    [],
    ["acceptForSession"],
    [{ acceptWithExecpolicyAmendment: {} }],
    "accept",
  ])
    assert.equal(
      commandDecisionAllowed({ availableDecisions: choices }, "accept"),
      false,
    );
});
