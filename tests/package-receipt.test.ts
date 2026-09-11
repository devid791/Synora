import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error QA-only JavaScript helper, no application API.
import { receiptArguments } from "./fixtures/package-receipt-arguments.mjs";

test("Fault-only QA directory receipts retain the same strict owned-path boundary", () => {
  for (const platform of ["linux", "windows"]) {
    const dir = `out/aligned-${platform}-67eed3d`;
    assert.equal(receiptArguments([dir, "test-results/desktop.json"]).directory, dir);
    assert.throws(() => receiptArguments([`${dir}/../escape`, "test-results/desktop.json"]));
  }
  for (const dir of ["out/aligned-linux-latest", "out/aligned-other-67eed3d", "out/aligned-windows-67eed3d/", "out/aligned-linux-67eed3d\\escape"]) {
    assert.throws(() => receiptArguments([dir, "test-results/desktop.json"]));
  }
  assert.equal(
    receiptArguments([
      "out/fault-qa-linux-UZDTcS",
      "test-results/cancel-native.json",
    ]).directory,
    "out/fault-qa-linux-UZDTcS",
  );
  assert.throws(() =>
    receiptArguments([
      "out/fault-qa-linux-UZDTcS/../escape",
      "test-results/cancel-native.json",
    ]),
  );
  assert.throws(() =>
    receiptArguments(["out/unrelated", "test-results/cancel-native.json"]),
  );
});

test("package receipts preserve the legacy output and allow a separate labelled subset", () => {
  const args = ["out/production-qa-macos-ea9df76", "test-results/desktop.json"];
  assert.deepEqual(receiptArguments(args), {
    directory: args[0],
    reports: [args[1]],
    suffix: "",
  });
  assert.deepEqual(receiptArguments([...args, "--label=live-five"]), {
    directory: args[0],
    reports: [args[1]],
    suffix: "-live-five",
  });
});

test("package receipt labels cannot escape the evidence directory or hide unknown options", () => {
  const args = ["out/production-qa-macos-ea9df76", "test-results/desktop.json"];
  for (const label of [
    "",
    "../replace",
    "a/b",
    "a\\b",
    "x.json",
    "a".repeat(65),
  ])
    assert.throws(() => receiptArguments([...args, `--label=${label}`]));
  assert.throws(() => receiptArguments([...args, "--label=a", "--label=b"]));
  assert.throws(() => receiptArguments([...args, "--overwrite"]));
  assert.throws(() => receiptArguments([args[0], "--label=empty"]));
  assert.throws(() => receiptArguments([`${args[0]}/../escape`, args[1]]));
});
