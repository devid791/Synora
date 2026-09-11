// CPU-only stdio MCP qualification; does not invoke Core, Qwen, Alice or a GPU.
// node tests/codex_web_mcp_test.mjs /absolute/binary [--live http://existing-searxng:8888]
// Local HTTP cases test faults/limits only. --live MUST search the real provider
// and fetch a URL from its response; no fixture/fallback can satisfy that gate.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const [binaryArg, flag, provider, ...extra] = process.argv.slice(2);
assert(binaryArg && (!flag || (flag === '--live' && provider)) && !extra.length,
  'Usage: node tests/codex_web_mcp_test.mjs /absolute/binary [--live SEARXNG_BASE_URL]');
const binary = resolve(binaryArg);
if (provider) {
  const parsed = new URL(provider);
  assert(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash);
}
const dir = mkdtempSync(join(tmpdir(), 'synora-web-mcp-evidence-'));
console.log(`Evidence: ${dir}`);
const transcript = [], checks = [], children = [], hashes = {};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => {
  const bytes = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  writeFileSync(`${dir}/${name}`, bytes, { mode: 0o600, flag: 'wx' });
  hashes[name] = digest(bytes);
};
class Client {
  constructor(phase, env = {}) {
    this.phase = phase; this.next = 1; this.pending = new Map(); this.stderr = ''; this.buffer = '';
    this.process = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {
      ...process.env, AXIOM_SEARCH_URL: '', AXIOM_WEB_TIMEOUT_MS: '15000',
      AXIOM_WEB_MAX_RESPONSE_BYTES: '1048576', ...env,
    } });
    children.push(this);
    this.closed = new Promise(ok => this.process.once('close', (code, signal) => {
      this.exit = { code, signal }; this.rejectAll(new Error(`MCP closed: ${code}/${signal}`)); ok(this.exit);
    }));
    this.process.on('error', error => this.rejectAll(error));
    this.process.stdin.on('error', error => this.rejectAll(error));
    this.process.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-10000); });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    this.process.stdout.on('data', chunk => {
      try {
        this.buffer += decoder.decode(chunk, { stream: true });
        assert(this.buffer.length <= 2000000, 'unbounded MCP output');
        for (;;) {
          const end = this.buffer.indexOf('\n'); if (end < 0) break;
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
          const reply = JSON.parse(line);
          assert.equal(reply.jsonrpc, '2.0');
          transcript.push({ phase, direction: 'response', message: reply });
          const pending = this.pending.get(reply.id);
          assert(pending, `unsolicited reply ${JSON.stringify(reply)}`);
          this.pending.delete(reply.id); clearTimeout(pending.timer); pending.ok(reply);
        }
      } catch (error) { this.rejectAll(error); this.process.kill('SIGTERM'); }
    });
  }
  rejectAll(error) {
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.bad(error); }
    this.pending.clear();
  }
  raw(line, id) {
    return new Promise((ok, bad) => {
      const timer = setTimeout(() => { this.pending.delete(id); bad(new Error(`MCP deadline in ${this.phase}`)); this.process.kill('SIGTERM'); }, 35000);
      this.pending.set(id, { ok, bad, timer });
      transcript.push({ phase: this.phase, direction: 'request', line });
      this.process.stdin.write(Buffer.isBuffer(line) ? Buffer.concat([line, Buffer.from('\n')]) : line + '\n');
    });
  }
  rpc(method, params, id = this.next++) {
    return this.raw(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }), id);
  }
  notify(method, params) { this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  async init(version = '2025-06-18') {
    const response = await this.rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'axiom-web-qualification', version: '1' } });
    assert(!response.error, JSON.stringify(response));
    assert.deepEqual(response.result.capabilities, { tools: {} });
    this.notify('notifications/initialized', {});
    return response.result;
  }
  async call(name, args) {
    const response = await this.rpc('tools/call', { name, arguments: args });
    assert(!response.error, JSON.stringify(response));
    assert.equal(response.result.content.length, 1);
    assert.equal(response.result.content[0].type, 'text');
    return { mcp: response.result, data: JSON.parse(response.result.content[0].text) };
  }
  async stop() {
    if (!this.exit) this.process.stdin.end();
    const timer = setTimeout(() => this.process.kill('SIGKILL'), 2000);
    try { return await this.closed; } finally { clearTimeout(timer); }
  }
}
const fault = async (client, name, args, code) => {
  const result = await client.call(name, args);
  assert.equal(result.mcp.isError, true, JSON.stringify(result));
  assert.equal(result.data.error.code, code, JSON.stringify(result));
  checks.push(`${client.phase}:${code}`);
  return result;
};
let server, summary = { started_at: new Date().toISOString(), binary, live_requested: Boolean(provider), status: 'FAIL' };
try {
  summary.binary_sha256 = digest(readFileSync(binary));
  const source = fileURLToPath(new URL('../native/web/axiom_codex_web_mcp.cpp', import.meta.url));
  summary.source_sha256 = digest(readFileSync(source));
  summary.test_sha256 = digest(readFileSync(fileURLToPath(import.meta.url)));
  const client = new Client('protocol');
  assert.equal((await client.rpc('tools/list')).error.code, -32002);
  assert.equal((await client.raw('{', null)).error.code, -32700);
  assert.equal((await client.raw('[]', null)).error.code, -32600);
  assert.equal((await client.raw('{"jsonrpc":"2.0","id":"\\ud800","method":"ping"}', null)).error.code, -32700);
  assert.equal((await client.init('2099-01-01')).protocolVersion, '2025-06-18');
  assert.equal((await client.rpc('initialize', { protocolVersion: '2025-06-18' })).error.code, -32602);
  const catalog = (await client.rpc('tools/list')).result;
  assert.deepEqual(catalog.tools.map(x => x.name), ['web_fetch']);
  assert.deepEqual(catalog._meta['axiom/search_provider'], {
    status: 'unconfigured', error_code: 'search_provider_missing', advertised: false, runtime_probed: false,
  });
  for (const tool of catalog.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, true);
  }
  save('catalog.json', catalog);
  client.notify('notifications/ignored', {});
  assert.deepEqual((await client.rpc('ping', {}, 'string-id')).result, {});
  assert.equal((await client.rpc('not-a-method')).error.code, -32601);
  assert.equal((await client.rpc('tools/list', { cursor: 'bogus' })).error.code, -32602);
  assert.equal((await client.rpc('tools/call', { name: 'bash', arguments: {} })).error.code, -32602);
  await fault(client, 'web_search', { query: 'IANA' }, 'search_provider_missing');
  for (const args of [{}, { query: '' }, { query: '   ' }, { query: 3 }, { query: 'a\u0000b' },
    { query: 'a'.repeat(513) }, { query: 'IANA', limit: 0 }, { query: 'IANA', limit: 9 },
    { query: 'IANA', limit: 1.5 }, { query: 'IANA', limit: '5' }, { query: 'IANA', extra: true }])
    await fault(client, 'web_search', args, 'invalid_arguments');
  for (const url of ['file:///etc/passwd', 'ftp://example.com', '//example.com', 'https://user:secret@example.com', 'http://', 'http://example.com/a b', 'https://example.com\\@localhost'])
    await fault(client, 'web_fetch', { url }, 'invalid_url');
  assert.deepEqual(await client.stop(), { code: 0, signal: null });
  checks.push('protocol:initialize-discover-notifications-errors-EOF');

  // Private ephemeral server: fault injection is NOT live search evidence.
  const requests = [];
  server = createServer((req, res) => {
    requests.push(req.url);
    const path = req.url.split('?')[0];
    if (path === '/timeout') return; // socket is closed on test cleanup
    if (path === '/redirect-file') { res.writeHead(302, { location: 'file:///etc/passwd' }); return res.end(); }
    if (path === '/redirect-ftp') { res.writeHead(302, { location: 'ftp://example.com/no' }); return res.end(); }
    if (path === '/redirect') { res.writeHead(302, { location: '/text' }); return res.end(); }
    if (path === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (path === '/status') { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('unavailable'); }
    if (path === '/binary') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end('binary'); }
    if (path === '/empty') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(); }
    if (path === '/bad/search') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>not SearXNG JSON</html>'); }
    if (path === '/none/search') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"results":[]}'); }
    if (path === '/large-length') { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 4096 }); return res.end('x'.repeat(4096)); }
    if (path === '/large-chunked') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('x'.repeat(900)); return res.end('x'.repeat(4096)); }
    if (path === '/large-gzip') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); return res.end(gzipSync('x'.repeat(4096))); }
    if (path === '/headers') { res.writeHead(200, Object.fromEntries(Array.from({ length: 80 }, (_, n) => [`x-large-${n}`, 'x'.repeat(1000)]))); return res.end('body'); }
    if (path === '/utf8') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('é'.repeat(6500)); }
    if (path === '/invalid-utf8') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(Buffer.from([0x61, 0xff, 0x62])); }
    if (path === '/text') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<p title=\"a>b\">visible</p><script>DO_NOT_INCLUDE</script><!-- hidden --><style>STYLE_SECRET</style><p>café</p>'); }
    res.writeHead(404); res.end();
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  // No external search: an empty-results fixture proves exact query transport
  // at the schema boundary without claiming successful live-provider evidence.
  const boundaries = new Client('unicode-argument-bounds', { AXIOM_SEARCH_URL: base + '/none' });
  await boundaries.init();
  const configuredCatalog = (await boundaries.rpc('tools/list')).result;
  assert.deepEqual(configuredCatalog.tools.map(x => x.name), ['web_search', 'web_fetch']);
  assert.equal(configuredCatalog._meta['axiom/search_provider'].status, 'configured_not_probed');
  assert.equal(configuredCatalog._meta['axiom/search_provider'].runtime_probed, false);
  checks.push('catalog:configured-search-only-no-invented-provider');
  for (const spelling of ['1', '2.0', '2e0', '8.000']) {
    const before = requests.length;
    const reply = await boundaries.raw('{"jsonrpc":"2.0","id":777,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"IANA","limit":' + spelling + '}}}', 777);
    assert.equal(JSON.parse(reply.result.content[0].text).error.code, 'search_no_results');
    assert.equal(requests.length, before + 1, 'valid JSON Schema integer must reach the provider');
  }
  checks.push('numeric-limit:integer-decimal-exponent-spellings');
  for (const character of ['é', '€', '😀']) {
    const query = character.repeat(512), before = requests.length;
    await fault(boundaries, 'web_search', { query }, 'search_no_results');
    assert.equal(requests.length, before + 1, '512 Unicode codepoints must reach the provider');
    assert.equal(new URL(requests.at(-1), base).searchParams.get('q'), query);
    const rejected = await fault(boundaries, 'web_search', { query: query + character }, 'invalid_arguments');
    assert.match(rejected.data.error.message, /512 Unicode code points/);
    assert.equal(requests.length, before + 1, '513 codepoints must not issue an HTTP request');
  }
  // A fragment keeps this an argument-length test, independent of the local
  // HTTP parser's handling of unescaped non-ASCII request-target bytes.
  const prefix = base + '/empty#', url = prefix + 'é'.repeat(2048 - prefix.length);
  assert.equal([...url].length, 2048); assert(Buffer.byteLength(url) > 2048);
  const beforeUrl = requests.length;
  await fault(boundaries, 'web_fetch', { url }, 'empty_response');
  assert.equal(requests.length, beforeUrl + 1, '2048-codepoint URL must reach HTTP');
  const longUrl = await fault(boundaries, 'web_fetch', { url: url + 'é' }, 'invalid_arguments');
  assert.match(longUrl.data.error.message, /2048 Unicode code points/);
  assert.equal(requests.length, beforeUrl + 1);
  // Raw malformed UTF-8 and escaped lone surrogates fail at the MCP boundary.
  for (const invalid of [Buffer.from([0x80]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xe2, 0x82]),
    Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf4, 0x90, 0x80, 0x80])]) {
    const raw = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":100,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"'),
      invalid, Buffer.from('"}}}')]);
    assert.equal((await boundaries.raw(raw, null)).error.code, -32700);
  }
  assert.equal((await boundaries.raw(JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/call',
    params: { name: 'web_search', arguments: { query: '\ud800' } } }), null)).error.code, -32700);
  assert.equal(requests.length, beforeUrl + 1, 'invalid UTF-8 must not issue HTTP requests');
  await boundaries.stop();
  checks.push('unicode-argument-bounds:512/513-query-2048/2049-url-invalid-utf8-no-external-search');
  const local = new Client('http-safety', { AXIOM_WEB_TIMEOUT_MS: '250', AXIOM_WEB_MAX_RESPONSE_BYTES: '1024' });
  await local.init('2024-11-05');
  for (const [path, code] of [['/status', 'http_status_error'], ['/binary', 'unsupported_content_type'], ['/empty', 'empty_response'],
    ['/redirect-file', 'http_transport_error'], ['/redirect-ftp', 'http_transport_error'], ['/loop', 'http_transport_error'],
    ['/large-length', 'response_too_large'], ['/large-chunked', 'response_too_large'], ['/large-gzip', 'response_too_large'], ['/headers', 'headers_too_large']])
    await fault(local, 'web_fetch', { url: base + path }, code);
  const start = Date.now();
  await fault(local, 'web_fetch', { url: base + '/timeout' }, 'http_timeout');
  const elapsed = Date.now() - start;
  assert(elapsed >= 100 && elapsed < 2000, `HTTP deadline exceeded: ${elapsed}ms`);
  summary.timeout_observed_ms = elapsed;
  const text = await local.call('web_fetch', { url: base + '/redirect' });
  assert.equal(text.mcp.isError, false);
  assert.equal(text.data.effective_url, base + '/text');
  assert.equal(text.data.content.trim(), 'visible café');
  assert.equal(text.data.untrusted, true);
  assert.equal((await local.call('web_fetch', { url: base + '/invalid-utf8' })).data.content, 'a\ufffdb');
  // A tools/call notification must not execute a GET.
  const before = requests.length;
  local.notify('tools/call', { name: 'web_fetch', arguments: { url: base + '/text' } });
  await local.rpc('ping'); assert.equal(requests.length, before);
  await local.stop();
  for (const [suffix, code] of [['/bad', 'search_provider_invalid_response'], ['/none', 'search_no_results']]) {
    const bad = new Client('provider-fault', { AXIOM_SEARCH_URL: base + suffix });
    await bad.init(); await fault(bad, 'web_search', { query: 'IANA' }, code); await bad.stop();
  }
  const invalid = new Client('configuration', { AXIOM_SEARCH_URL: base + '?bad=true', AXIOM_WEB_TIMEOUT_MS: 'oops' });
  await invalid.init();
  await fault(invalid, 'web_search', { query: 'IANA' }, 'configuration_invalid');
  await fault(invalid, 'web_fetch', { url: base + '/text' }, 'configuration_invalid');
  await invalid.stop();
  const unicode = new Client('bounded-unicode', { AXIOM_WEB_MAX_RESPONSE_BYTES: '16384' });
  await unicode.init('2025-03-26');
  const clipped = await unicode.call('web_fetch', { url: base + '/utf8' });
  assert.equal(clipped.mcp.isError, false);
  assert.equal(Buffer.byteLength(clipped.data.content), 12000);
  assert(!clipped.data.content.includes('\ufffd'));
  assert.equal(clipped.data.possibly_truncated, true);
  await unicode.stop();
  const oversized = new Client('bounded-input');
  assert.equal((await oversized.raw('x'.repeat(65537), null)).error.code, -32600);
  assert.deepEqual(await oversized.stop(), { code: 2, signal: null });
  checks.push('http-safety:redirect-text-unicode-notification-no-execution', 'bounds:utf8-output-and-oversized-input');

  if (provider) {
    console.log('Safety checks passed; starting real SearXNG search -> returned-URL fetch.');
    const live = new Client('LIVE', { AXIOM_SEARCH_URL: provider });
    await live.init();
    const query = 'IANA reserved example domains';
    const search = await live.call('web_search', { query, limit: 5 });
    save('live-search.json', search);
    assert.equal(search.mcp.isError, false, JSON.stringify(search.data));
    assert.equal(search.data.backend, 'searxng');
    assert.equal(search.data.http_status, 200);
    assert(search.data.results.length > 0 && search.data.results.length <= 5);
    assert.equal(search.data.result_count, search.data.results.length);
    // Prefer the authoritative public result; otherwise try at most 3 actual
    // returned URLs. No hardcoded fetch URL or invented result is ever used.
    const candidates = [...search.data.results].sort((a, b) => Number(new URL(b.url).hostname === 'www.iana.org') - Number(new URL(a.url).hostname === 'www.iana.org')).slice(0, 3);
    let fetched;
    for (const [i, result] of candidates.entries()) {
      const attempt = await live.call('web_fetch', { url: result.url });
      save(`live-fetch-${i}.json`, attempt);
      if (!attempt.mcp.isError) { fetched = attempt; break; }
    }
    assert(fetched, 'No returned URL was successfully fetched (see evidence)');
    assert(search.data.results.some(result => result.url === fetched.data.url));
    assert(fetched.data.http_status >= 200 && fetched.data.http_status < 300);
    assert(fetched.data.response_bytes > 100);
    assert(fetched.data.content.length > 100 && /domain|IANA/i.test(fetched.data.content));
    assert(Buffer.byteLength(fetched.data.content) <= 12000);
    save('live-fetch-content.txt', fetched.data.content);
    summary.live = { provider, query, result_count: search.data.result_count, search_http_status: search.data.http_status,
      fetched_url: fetched.data.url, effective_url: fetched.data.effective_url, fetch_http_status: fetched.data.http_status,
      fetch_response_bytes: fetched.data.response_bytes, content_bytes: Buffer.byteLength(fetched.data.content),
      content_sha256: digest(fetched.data.content), provider_warnings: search.data.provider_warnings };
    checks.push('LIVE:real-search-and-fetch-returned-url');
    await live.stop();
  }
  summary.status = provider ? 'PASS_LIVE_AND_SAFETY' : 'PASS_SAFETY_ONLY';
} catch (error) {
  summary.error = error.stack || String(error); process.exitCode = 1;
} finally {
  for (const child of children) await child.stop();
  if (server) { server.closeAllConnections(); await new Promise(ok => server.close(ok)); }
  save('transcript.json', transcript);
  save('processes.json', children.map(child => ({ phase: child.phase, exit: child.exit, stderr: child.stderr })));
  summary = { ...summary, completed_at: new Date().toISOString(), checks, evidence_sha256: hashes };
  save('result.json', summary);
  console.log(JSON.stringify({ ...summary, evidence_dir: dir }, null, 2));
}
