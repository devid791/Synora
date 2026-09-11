// An actual local HTTP OAuth/MCP service for protocol qualification. No accounts.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
export async function oauthMcpServer() {
  // Only returned by the real tool handler, never included in model instructions.
  const toolMarker = `SYNORA_PLUGIN_RESULT_${randomUUID()}`;
  const toolCalls: { id: unknown; name: string; arguments: unknown }[] = [];
  const events: { method: string; path: string; operation?: string }[] = [];
  const clients = new Map<string, string[]>(),
    codes = new Map<
      string,
      { client: string; redirect: string; challenge: string }
    >();
  const access = new Map<string, number>(),
    refresh = new Set<string>();
  let base = "",
    denied = false,
    lifetime = 60,
    grants = 0,
    refreshes = 0,
    pkce = 0;
  const failures: string[] = [];
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      assert.ok(length < 65536);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, base);
      events.push({ method: req.method!, path: url.pathname });
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return json(res, 200, {
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ["fixture:read"],
        });
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["fixture:read"],
        });
      if (url.pathname === "/register") {
        const value = JSON.parse(await body(req)),
          client = randomUUID();
        assert.ok(Array.isArray(value.redirect_uris));
        clients.set(client, value.redirect_uris);
        return json(res, 201, {
          ...value,
          client_id: client,
          token_endpoint_auth_method: "none",
        });
      }
      if (url.pathname === "/authorize") {
        const p = url.searchParams,
          client = p.get("client_id")!,
          redirect = p.get("redirect_uri")!;
        assert.ok(clients.get(client)?.includes(redirect));
        assert.equal(p.get("code_challenge_method"), "S256");
        assert.ok(p.get("state"));
        const callback = new URL(redirect);
        assert.ok(
          ["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname),
        );
        callback.searchParams.set("state", p.get("state")!);
        if (denied) callback.searchParams.set("error", "access_denied");
        else {
          const code = randomUUID();
          codes.set(code, {
            client,
            redirect,
            challenge: p.get("code_challenge")!,
          });
          callback.searchParams.set("code", code);
        }
        res.writeHead(302, { Location: callback.href });
        return res.end();
      }
      if (url.pathname === "/token") {
        const p = new URLSearchParams(await body(req));
        if (p.get("grant_type") === "authorization_code") {
          const code = p.get("code")!,
            grant = codes.get(code)!;
          assert.ok(grant);
          codes.delete(code);
          assert.equal(p.get("client_id"), grant.client);
          assert.equal(p.get("redirect_uri"), grant.redirect);
          assert.equal(
            createHash("sha256")
              .update(p.get("code_verifier")!)
              .digest("base64url"),
            grant.challenge,
          );
          pkce++;
          grants++;
        } else {
          assert.equal(p.get("grant_type"), "refresh_token");
          assert.ok(refresh.has(p.get("refresh_token")!));
          refresh.delete(p.get("refresh_token")!);
          refreshes++;
        }
        const token = randomUUID(),
          next = randomUUID();
        access.set(token, Date.now() + lifetime * 1000);
        refresh.add(next);
        return json(res, 200, {
          access_token: token,
          refresh_token: next,
          token_type: "Bearer",
          expires_in: lifetime,
          scope: "fixture:read",
        });
      }
      if (url.pathname === "/mcp") {
        const token = req.headers.authorization?.replace(/^Bearer /i, "");
        if (!token || (access.get(token) ?? 0) <= Date.now()) {
          res.setHeader(
            "WWW-Authenticate",
            `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
          );
          return json(res, 401, { error: "authorization_required" });
        }
        if (req.method !== "POST") {
          res.writeHead(405);
          return res.end();
        }
        const rpc = JSON.parse(await body(req));
        events.push({ method: "MCP", path: "/mcp", operation: rpc.method });
        if (rpc.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        if (rpc.method === "tools/call") {
          assert.equal(rpc.params.name, "read_fixture");
          assert.deepEqual(rpc.params.arguments ?? {}, {});
          toolCalls.push({
            id: rpc.id,
            name: rpc.params.name,
            arguments: rpc.params.arguments ?? {},
          });
          return json(res, 200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              content: [{ type: "text", text: toolMarker }],
              isError: false,
            },
          });
        }
        const result =
          rpc.method === "initialize"
            ? {
                protocolVersion: rpc.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "synora-oauth-fixture", version: "1.0" },
              }
            : rpc.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "read_fixture",
                      description: "Read controlled test evidence",
                      inputSchema: {
                        type: "object",
                        properties: {},
                        additionalProperties: false,
                      },
                      annotations: { readOnlyHint: true },
                    },
                  ],
                }
              : rpc.method === "resources/list"
                ? { resources: [] }
                : rpc.method === "resources/templates/list"
                  ? { resourceTemplates: [] }
                  : null;
        if (result)
          return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
        return json(res, 200, {
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: -32601,
            message: "Not implemented by controlled fixture",
          },
        });
      }
      return json(res, 404, { error: "not_found" });
    })().catch((e) => {
      failures.push(e instanceof Error ? e.message : "Fixture failure");
      if (!res.headersSent) json(res, 500, { error: "fixture_failed" });
      else res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    endpoint: `${base}/mcp`,
    toolMarker,
    toolCalls,
    events,
    failures,
    deny: (v: boolean) => {
      denied = v;
    },
    lifetime: (v: number) => {
      lifetime = v;
    },
    counts: () => ({ grants, refreshes, pkce }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
