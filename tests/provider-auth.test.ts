import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { ProviderCredentials } from "../src/main/provider-credentials";
import { bearerHeaders, validateBearer } from "../src/engine/axiom-auth";
import { axiomModels } from "../src/engine/axiom-process";
import { AxiomStatus } from "../src/engine/axiom-status";
import {
  axiomContextBridge,
  CONTEXT_TOKEN_HEADER,
} from "../src/engine/axiom-context-bridge";
const provider = {
  id: "external-axiom",
  name: "External Axiom fixture",
  kind: "provider" as const,
  auth: "api-key" as const,
  endpoint: "https://axiom.example.invalid/codex/v1",
  tools: [],
  enabled: true,
};
test("Bearer vault persists only private host-side state, isolates endpoint, replaces/deletes and never returns secrets as status", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-bearer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = new ProviderCredentials(directory),
    token = `fixture-${randomBytes(20).toString("hex")}`;
  assert.equal((await credentials.status(provider)).present, false);
  await assert.rejects(credentials.load(provider), /Save a Bearer/);
  await credentials.save(provider, token);
  const status = await credentials.status(provider);
  assert.equal(status.present, true);
  assert.equal(status.usable, true);
  assert.ok(!JSON.stringify(status).includes(token));
  assert.equal(await new ProviderCredentials(directory).load(provider), token);
  assert.equal(
    await credentials.load({ ...provider, auth: "none" }),
    undefined,
  );
  if (process.platform !== "win32")
    assert.equal(
      (await stat(join(directory, `${provider.id}.json`))).mode & 0o777,
      0o600,
    );
  const other = {
    ...provider,
    endpoint: "https://other.example.invalid/codex/v1",
  };
  assert.equal((await credentials.status(other)).present, false);
  await assert.rejects(credentials.load(other), /exact Axiom provider/);
  await assert.rejects(
    credentials.save(provider, "invalid\r\nAuthorization:x"),
    /raw Bearer/,
  );
  assert.equal(await credentials.load(provider), token);
  await credentials.save(provider, "fixture-replacement");
  assert.equal(await credentials.load(provider), "fixture-replacement");
  await credentials.remove(provider);
  assert.equal((await credentials.status(provider)).present, false);
  for (const v of ["", "Bearer x", "abc\r\nx", "a b", "é"])
    assert.throws(() => validateBearer(v));
  assert.throws(
    () => bearerHeaders("http://public.example/codex/v1", token),
    /HTTPS/,
  );
  assert.deepEqual(bearerHeaders("http://10.23.45.10:8015/codex/v1"), {});
});
test("Encrypted provider credential adapter cannot downgrade an existing encrypted envelope or expose plaintext", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-bearer-seal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const cipher = {
    seal(value: string) {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), data]);
    },
    open(value: Buffer) {
      const c = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      c.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString(
        "utf8",
      );
    },
  };
  const vault = new ProviderCredentials(directory, cipher);
  await vault.save(provider, "fixture-encrypted-token");
  assert.ok(
    !(await readFile(join(directory, `${provider.id}.json`), "utf8")).includes(
      "fixture-encrypted-token",
    ),
  );
  assert.equal(
    await new ProviderCredentials(directory, cipher).load(provider),
    "fixture-encrypted-token",
  );
  const locked = new ProviderCredentials(directory);
  assert.equal((await locked.status(provider)).usable, false);
  await assert.rejects(locked.load(provider), /unavailable or invalid/);
  await assert.rejects(locked.save(provider, "replacement"), /Unlock the OS/);
  assert.equal(await vault.load(provider), "fixture-encrypted-token");
});
test('Async OS credential reads redact rejection details and failed writes retain the previous encrypted envelope',async(t)=>{
 const directory=await mkdtemp(join(tmpdir(),'synora-async-vault-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 let reject=false;
 const ciphertext=Buffer.from('opaque-encrypted-qa-bytes');
 const cipher={
  async seal(){if(reject)throw Error('PRIVATE_OS_DETAIL');return ciphertext;},
  async open(value:Buffer){assert.deepEqual(value,ciphertext);if(reject)throw Error('PRIVATE_OS_DETAIL');return 'fixture-encrypted-token';},
 };
 const vault=new ProviderCredentials(directory,cipher);
 await vault.save(provider,'fixture-encrypted-token');
 const file=join(directory,provider.id+'.json'),before=await readFile(file);
 assert.equal(await vault.load(provider),'fixture-encrypted-token');
 assert.deepEqual(await readFile(file),before);
 reject=true;
 await assert.rejects(vault.load(provider),error=>error instanceof Error&&/unavailable or invalid/.test(error.message)&&!error.message.includes('PRIVATE_OS_DETAIL'));
 await assert.rejects(vault.save(provider,'replacement'),/previous saved token was not replaced/);
 assert.deepEqual(await readFile(file),before);
});
test('Removing a credential waits for an already-authorized asynchronous save and cannot be undone by its late completion',async(t)=>{
 const directory=await mkdtemp(join(tmpdir(),'synora-async-remove-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 let entered!:()=>void,finish!:(v:Buffer)=>void;
 const started=new Promise<void>(r=>{entered=r;});
 const cipher={seal(){entered();return new Promise<Buffer>(r=>{finish=r;});},open(){return 'fixture-token';}};
 const vault=new ProviderCredentials(directory,cipher);
 const save=vault.savePrivateRecord(provider,'fixture-token');
 await started;
 const remove=vault.remove(provider);
 await new Promise<void>(r=>setTimeout(r,15));
 finish(Buffer.from('encrypted-qa'));
 await Promise.all([save,remove]);
 assert.equal((await vault.status(provider)).present,false);
});
test("Bearer is used for catalog, independent telemetry and incremental SSE; wrong tokens/redirects fail without changing no-auth path", async () => {
  const seen: { url: string; authorized: boolean; forwardedBody?: unknown }[] =
    [];
  const token = `fixture-${randomBytes(24).toString("hex")}`;
  let redirect = false;
  const sse =
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK","item_id":"item-1"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"response-1","status":"completed"}}\n\n';
  const upstream = createServer((req, res) => {
    const request = {
      url: req.url!,
      authorized: req.headers.authorization === `Bearer ${token}`,
      forwardedBody: undefined as unknown,
    };
    seen.push(request);
    if (!request.authorized) {
      res.writeHead(401);
      return res.end('{"error":"unauthorized"}');
    }
    if (redirect) {
      res.writeHead(302, { Location: "http://127.0.0.1:9/do-not-follow" });
      return res.end();
    }
    if (req.url === "/codex/v1/models")
      return res.end(
        JSON.stringify({
          data: [
            {
              id: "fixture-model",
              context_window: 262144,
              context_window_options: [262144],
              reasoning_efforts: ["ultra-fast"],
            },
          ],
          models: [{ slug: "fixture-model" }],
        }),
      );
    if (req.url?.startsWith("/ops/")) return res.end("{}"); // Header transport only; not a claim of valid runtime telemetry.
    let body = "";
    req.on("data", (b) => {
      body += b;
    });
    req.on("end", () => {
      request.forwardedBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const boundary = sse.indexOf("event: response.completed");
      res.write(sse.slice(0, boundary));
      setTimeout(() => res.end(sse.slice(boundary)), 30);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/codex/v1`;
  const monitor = new AxiomStatus();
  const bridge = await axiomContextBridge({
    endpoint,
    model: "fixture-model",
    context: 262144,
    bearerToken: token,
  });
  try {
    await assert.rejects(axiomModels(endpoint), /401/);
    await assert.rejects(axiomModels(endpoint, "wrong"), /401/);
    assert.equal((await axiomModels(endpoint, token))[0].id, "fixture-model");
    const status = await monitor.read(endpoint, token);
    assert.equal(status.mode, "live");
    if (status.mode === "live") {
      assert.equal(status.runtime.httpStatus, 200);
      assert.equal(status.runtime.state, "unavailable");
    }
    const wrong = await monitor.read(endpoint, "wrong");
    if (wrong.mode === "live") assert.equal(wrong.runtime.httpStatus, 401);
    const payload = {
      model: "fixture-model",
      stream: true,
      session_id: "session-1",
      input: [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "unchanged",
        },
      ],
    };
    const response = await fetch(`${bridge.endpoint}/responses`, {
      method: "POST",
      headers: {
        [CONTEXT_TOKEN_HEADER]: bridge.token,
        Authorization: "Bearer attacker-override",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(),
      first = await reader.read();
    const firstText = new TextDecoder().decode(first.value);
    assert.match(firstText, /response.output_text.delta/);
    assert.ok(!firstText.includes("response.completed"));
    let rest = "";
    for (;;) {
      const v = await reader.read();
      if (v.done) break;
      rest += new TextDecoder().decode(v.value);
    }
    assert.equal(firstText + rest, sse);
    assert.deepEqual(
      seen.find((v) => v.url === "/codex/v1/responses")?.forwardedBody,
      { context_window: 262144, ...payload },
    );
    assert.ok(seen.find((v) => v.url === "/codex/v1/responses")?.authorized);
    assert.ok(!JSON.stringify(seen).includes(token));
    redirect = true;
    const before = seen.length;
    await assert.rejects(axiomModels(endpoint, token));
    const r = await fetch(`${bridge.endpoint}/models`, {
      headers: { [CONTEXT_TOKEN_HEADER]: bridge.token },
    });
    assert.equal(r.status, 502);
    assert.match(await r.text(), /UPSTREAM_REDIRECT/);
    assert.equal(seen.length - before, 2);
  } finally {
    monitor.dispose();
    await bridge.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
