import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:https";
import { X509Certificate, createPublicKey } from "node:crypto";
import { GpuCollectorClient } from "../src/main/gpu-collector-client";
const token = "b".repeat(64), provider = "https://provider.fixture.invalid/codex/v1";
const sample = () => ({ schema: "synora_gpu_telemetry_v1", scope: "host-devices-not-inference-allocation", sampledAt: Date.now(), durationMs: 1, devices: [], issues: [] });
test("Private GPU TLS client authenticates exact provider/CA, rejects stale/redirect/bounds and cleans up requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "synora-gpu-tls-")), certPath = join(root, "cert.pem"), keyPath = join(root, "key.pem"), registry = join(root, "registry.json");
  let behavior = "ok", requests = 0, redirected = 0;
  const sockets = new Set<import("node:stream").Duplex>();
  let server: Server | undefined;
  const client = new GpuCollectorClient(registry);
  try {
    const absent = await client.read(provider);
    assert.equal(absent?.state === "unavailable" && absent.code, "GPU_NOT_CONFIGURED");
    const supplied = process.env.SYNORA_QA_GPU_TLS_DIR;
    if (supplied) {
      // QA-only portable certificate input. Keep TLS verification enabled and
      // validate the supplied fixture instead of modifying system trust.
      const cert = await readFile(join(supplied, "cert.pem"));
      const key = await readFile(join(supplied, "key.pem"));
      const x509 = new X509Certificate(cert);
      assert.equal(x509.checkIP("127.0.0.1"), "127.0.0.1");
      assert.ok(Date.parse(x509.validFrom) <= Date.now());
      assert.ok(Date.parse(x509.validTo) > Date.now());
      assert.deepEqual(x509.publicKey.export({ type: "spki", format: "der" }),
        createPublicKey(key).export({ type: "spki", format: "der" }));
      await writeFile(certPath, cert, { flag: "wx", mode: 0o600 });
      await writeFile(keyPath, key, { flag: "wx", mode: 0o600 });
    } else {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=collector.fixture.invalid", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
    }
    const certificate = await readFile(certPath, "utf8");
    server = createServer({ cert: certificate, key: await readFile(keyPath) }, (req, res) => {
      requests++; if (req.url !== "/v1/gpus") redirected++;
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
      if (behavior === "redirect") { res.writeHead(302, { location: "/forbidden" }); res.end(); return; }
      if (behavior === "hang") return;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (behavior === "large") { res.end("x".repeat(300000)); return; }
      if (behavior === "invalid") { res.end('{}'); return; }
      res.end(JSON.stringify({ ...sample(), ...(behavior === "stale" ? { sampledAt: 1 } : {}) }));
    });
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>(r => server!.listen(0, "127.0.0.1", r));
    const endpoint = `https://127.0.0.1:${(server.address() as any).port}/v1/gpus`;
    const save = (patch = {}) => writeFile(registry, JSON.stringify([{ providerEndpoint: provider, endpoint, token, certificate, ...patch }]), { mode: 0o600 });
    await save(); const good = await client.read(provider); assert.equal(good?.state, "available");
    assert.ok(!JSON.stringify(good).includes(token)); assert.equal(requests, 1);
    const unmatched = await client.read("https://different.fixture.invalid/codex/v1");
    assert.equal(unmatched?.state === "unavailable" && unmatched.code, "GPU_NOT_CONFIGURED"); assert.equal(requests, 1);
    for (const mode of ["stale", "redirect", "large", "invalid"]) { behavior = mode; const result = await client.read(provider);
      assert.equal(result?.state, "unavailable", mode); assert.ok(!JSON.stringify(result).includes(token)); }
    assert.equal(redirected, 0);
    behavior = "ok"; await save({ token: "c".repeat(64) }); assert.equal((await client.read(provider))?.httpStatus, 401);
    await save({ endpoint: endpoint.replace("127.0.0.1", "localhost") }); assert.equal((await client.read(provider))?.state, "unavailable");
    await save({ certificate: "invalid".repeat(30) }); assert.equal((await client.read(provider))?.state, "unavailable");
    await save();
    // POSIX mode bits have no Windows ACL semantics; the client deliberately
    // enforces this permission check only on POSIX. Other negatives run on all OSs.
    if (process.platform !== "win32") {
      await chmod(registry, 0o644); assert.equal((await client.read(provider))?.state, "unavailable"); await chmod(registry, 0o600);
    }
    const linked = join(root, "linked.json"); await symlink(registry, linked);
    const linkedClient = new GpuCollectorClient(linked); assert.equal((await linkedClient.read(provider))?.state, "unavailable"); linkedClient.dispose();
    behavior = "hang"; const pending = client.read(provider); await new Promise(r => setTimeout(r, 80)); client.reset();
    assert.equal((await pending)?.state, "unavailable");
    behavior = "ok"; assert.equal((await client.read(provider))?.state, "available");
    client.dispose(); const count = requests; assert.equal(await client.read(provider), undefined); assert.equal(requests, count);
  } finally { client.dispose(); for (const socket of sockets) socket.destroy(); if (server) await new Promise<void>(r => server!.close(() => r())); await rm(root, { recursive: true, force: true }); }
});
