import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthClientInformationFullSchema, type OAuthClientInformationMixed, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { HostTurnBroker } from "./host-broker.js";
import { startHostHttp } from "./host-http.js";
import { publicIssuer, readHostDescriptor, startOAuthGateway } from "./gateway-http.js";
import { GatewayOAuth } from "./gateway-oauth.js";
import { createOwnerPairing, readPrivateFile, secret, writePrivateFile } from "./gateway-state.js";
import { removeOwnedFixture } from "./fixture-cleanup.js";

const issuer = "https://gateway.example";
const resource = issuer + "/mcp";
const callback = "https://connector.example/oauth/callback";
const decode = (value: unknown): Record<string, any> => JSON.parse((value as { content: { text: string }[] }).content[0].text);

// Node fetch deliberately replaces Host; use a real HTTP proxy request to preserve it in the fixture.
const wireFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer());
  return new Promise<Response>((resolve, reject) => {
    const outgoing = http.request(request.url, { method: request.method, headers: Object.fromEntries(request.headers), signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
      incoming.on("error", reject);
      incoming.on("end", () => {
        const headers = new Headers();
        for (const [key, values] of Object.entries(incoming.headers)) if (values !== undefined) for (const value of Array.isArray(values) ? values : [values]) headers.append(key, value);
        const status = incoming.statusCode!;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    outgoing.on("error", reject); outgoing.end(body);
  });
};

async function fixture(t: TestContext, now?: () => number) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-host-test-"));
  const broker = new HostTurnBroker();
  let host: Awaited<ReturnType<typeof startHostHttp>> | undefined;
  let gateway: Awaited<ReturnType<typeof startOAuthGateway>> | undefined;
  t.after(async () => { await gateway?.close(); await host?.close(); removeOwnedFixture(directory); });
  host = await startHostHttp(broker, 0);
  const descriptor = path.join(directory, "connector.json");
  writePrivateFile(descriptor, JSON.stringify({ version: 1, pid: process.pid, endpoint: host.endpoint, bearerToken: host.bearer, authentication: "local_bearer" }));
  gateway = await startOAuthGateway({ publicUrl: issuer, stateDirectory: directory, hostDescriptor: descriptor, port: 0, now });
  const bind = `http://127.0.0.1:${gateway.port}`;
  // An owned HTTP fixture emulates the TLS proxy headers. This is not a TLS/public deployment test.
  const proxyFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, issuer, "OAuth client must never fetch an arbitrary external origin");
    const headers = new Headers(request.headers);
    headers.set("Host", new URL(issuer).host); headers.set("X-Forwarded-Proto", "https");
    return wireFetch(bind + url.pathname + url.search, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(), redirect: "manual", signal: request.signal });
  };
  const fetchPath = (route: string, init?: RequestInit) => proxyFetch(new URL(route, issuer), init);
  return { directory, broker, descriptor, host, gateway, bind, proxyFetch, fetchPath };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function register(f: Fixture, extra: Record<string, unknown> = {}) {
  const response = await f.fetchPath("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Owned connector fixture", redirect_uris: [callback], token_endpoint_auth_method: "none", ...extra }) });
  assert.equal(response.status, 201);
  return OAuthClientInformationFullSchema.parse(await response.json());
}
async function consentPage(f: Fixture, clientId: string, extra: Record<string, string> = {}) {
  const verifier = secret();
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), state: "fixture-state", scope: "ide.tools", resource, ...extra });
  const response = await f.fetchPath("/authorize?" + params);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(response.headers.get("set-cookie")!, /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  return { verifier, id: html.match(/name="request_id" value="([a-zA-Z0-9_-]+)"/)![1], cookie: response.headers.get("set-cookie")!.split(";")[0], html };
}
function pair(f: Fixture, now = Date.now()) {
  const result = createOwnerPairing(f.directory, now);
  const code = readPrivateFile(result.codeFile).trim();
  assert.equal(readPrivateFile(path.join(f.directory, "owner-pairing.json")).includes(code), false);
  return code;
}
async function approve(f: Fixture, clientId: string, now?: number) {
  const page = await consentPage(f, clientId);
  const response = await f.fetchPath("/consent", { method: "POST", headers: { Cookie: page.cookie, Origin: issuer, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request_id: page.id, owner_code: pair(f, now), decision: "allow" }) });
  assert.equal(response.status, 303);
  const redirect = new URL(response.headers.get("location")!);
  assert.equal(redirect.origin + redirect.pathname, callback);
  assert.equal(redirect.searchParams.get("state"), "fixture-state");
  assert.equal(fs.existsSync(path.join(f.directory, "owner-pairing-code.txt")), false);
  return { ...page, code: redirect.searchParams.get("code")! };
}
const postForm = (f: Fixture, route: string, body: Record<string, string>) => f.fetchPath(route, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
async function grant(f: Fixture) {
  const client = await register(f);
  const flow = await approve(f, client.client_id);
  const fields = { client_id: client.client_id, grant_type: "authorization_code", code: flow.code, code_verifier: flow.verifier, redirect_uri: callback, resource };
  const response = await postForm(f, "/token", fields);
  assert.equal(response.status, 200);
  const tokens = await response.json() as OAuthTokens;
  return { client, flow, fields, tokens };
}

test("Gateway discovery, owner-approved SDK OAuth/PKCE and MCP task loop work through a real loopback proxy fixture", async t => {
  const f = await fixture(t);
  const protectedMetadata = await (await f.fetchPath("/.well-known/oauth-protected-resource/mcp")).json() as Record<string, unknown>;
  assert.equal(protectedMetadata.resource, resource);
  const metadata = await (await f.fetchPath("/.well-known/oauth-authorization-server")).json() as Record<string, unknown>;
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["client_secret_post", "none"]);
  let clientInfo: OAuthClientInformationMixed | undefined, tokens: OAuthTokens | undefined, verifier = "", redirect: URL | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: callback,
    clientMetadata: { client_name: "SDK connector fixture", redirect_uris: [callback], token_endpoint_auth_method: "none", scope: "ide.tools", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
    clientInformation: () => clientInfo, saveClientInformation: value => { clientInfo = value; },
    tokens: () => tokens, saveTokens: value => { tokens = value; },
    redirectToAuthorization: value => { redirect = value; },
    saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier,
    state: () => "sdk-state"
  };
  assert.equal(await auth(provider, { serverUrl: resource, fetchFn: f.proxyFetch }), "REDIRECT");
  assert.ok(redirect); assert.ok(clientInfo);
  const page = await f.proxyFetch(redirect);
  assert.equal(page.status, 200);
  const html = await page.text();
  const id = html.match(/name="request_id" value="([a-zA-Z0-9_-]+)"/)![1];
  const consent = await f.fetchPath("/consent", { method: "POST", headers: { Cookie: page.headers.get("set-cookie")!.split(";")[0], Origin: issuer, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request_id: id, owner_code: pair(f), decision: "allow" }) });
  assert.equal(consent.status, 303);
  const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
  assert.equal(await auth(provider, { serverUrl: resource, authorizationCode: code, fetchFn: f.proxyFetch }), "AUTHORIZED");
  const web = new Client({ name: "oauth-web-fixture", version: "1" });
  t.after(() => web.close());
  await web.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider, fetch: f.proxyFetch, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 } }));
  const tools = (await web.listTools()).tools.map(value => value.name);
  assert.deepEqual(tools.sort(), ["ide_tool_call", "ide_tool_inventory", "ide_tool_result", "ide_turn_complete"]);
  const task = f.broker.begin("oauth_task_01", "owned fixture workspace", [{ name: "read_file", description: "Fixture native inventory", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }], 10000);
  await web.callTool({ name: "ide_tool_call", arguments: { turn_token: task.turn_token, call_id: "oauth_call_01", tool: "read_file", arguments: { path: "fixture.txt" } } });
  assert.equal(f.broker.next(task.taskId).status, "action");
  assert.equal(f.broker.next(task.taskId).status, "awaiting_result");
  // Deliberate fixture result, not an Antigravity executor action or Gemini live connector.
  f.broker.finishAction(task.taskId, "oauth_call_01", { fixture: true, text: "fixture content" }, false);
  const result = decode(await web.callTool({ name: "ide_tool_result", arguments: { turn_token: task.turn_token, call_id: "oauth_call_01" } }));
  assert.equal(result.result.text, "fixture content");
  await web.callTool({ name: "ide_turn_complete", arguments: { turn_token: task.turn_token, final_text: "Fixture task finished" } });
  assert.equal(f.broker.next(task.taskId).status, "completed");
  assert.equal((await web.callTool({ name: "ide_host_result", arguments: {} })).isError, true);
  const disk = readPrivateFile(path.join(f.directory, "oauth-clients.json"));
  assert.equal(disk.includes(tokens!.access_token), false); assert.equal(disk.includes(tokens!.refresh_token!), false); assert.equal(disk.includes(task.turn_token), false);
});

test("Gateway fails closed on missing OAuth, raw backend tokens, bad Host/proto/origin and non-MCP paths", async t => {
  const f = await fixture(t);
  const body = JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 });
  const noAuth = await f.fetchPath("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(noAuth.status, 401); assert.match(noAuth.headers.get("www-authenticate")!, /resource_metadata="https:\/\/gateway.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal((await f.fetchPath("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.host.bearer}` }, body })).status, 401);
  const { tokens } = await grant(f);
  assert.equal((await f.fetchPath("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.access_token}`, Origin: "https://untrusted.example" }, body })).status, 403);
  assert.equal((await fetch(f.bind + "/health")).status, 403);
  assert.equal((await wireFetch(f.bind + "/health", { headers: { Host: new URL(issuer).host } })).status, 403);
  assert.equal((await wireFetch(f.bind + "/health", { headers: { Host: "other.example", "X-Forwarded-Proto": "https" } })).status, 403);
  assert.equal((await f.fetchPath("/connector.json")).status, 404);
  assert.equal((await f.fetchPath("/mcp", { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 405);
  fs.unlinkSync(f.descriptor);
  assert.equal((await f.fetchPath("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.access_token}` }, body })).status, 503);
});

test("Consent requires matching browser CSRF, owner code, expiry and explicit choice; untrusted metadata stays inert", async t => {
  let now = Date.now();
  const f = await fixture(t, () => now);
  const client = await register(f, { client_name: '<script>alert("fixture")</script>', logo_uri: "https://arbitrary.example/tracker" });
  const page = await consentPage(f, client.client_id);
  assert.ok(page.html.includes("&lt;script&gt;")); assert.equal(page.html.includes('<script>'), false); assert.equal(page.html.includes("arbitrary.example/tracker"), false);
  const ownerCode = pair(f, now);
  const fields = { request_id: page.id, owner_code: ownerCode, decision: "allow" };
  const consent = (headers: Record<string, string>, body = fields) => f.fetchPath("/consent", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
  assert.equal((await consent({ Origin: issuer })).status, 403);
  assert.equal((await consent({ Origin: "https://attacker.example", Cookie: page.cookie })).status, 403);
  assert.equal((await consent({ Origin: issuer, Cookie: page.cookie }, { ...fields, owner_code: "wrong" })).status, 403);
  assert.equal((await consent({ Origin: issuer, Cookie: page.cookie })).status, 303);
  assert.equal((await consent({ Origin: issuer, Cookie: page.cookie })).status, 403);
  const next = await consentPage(f, client.client_id);
  assert.equal((await consent({ Origin: issuer, Cookie: next.cookie }, { ...fields, request_id: next.id })).status, 403);
  const denied = await consent({ Origin: issuer, Cookie: next.cookie }, { request_id: next.id, owner_code: "", decision: "deny" });
  assert.equal(new URL(denied.headers.get("location")!).searchParams.get("error"), "access_denied");
  const expired = await consentPage(f, client.client_id);
  const expiredPair = pair(f, now); now += 300001;
  assert.equal((await consent({ Origin: issuer, Cookie: expired.cookie }, { request_id: expired.id, owner_code: expiredPair, decision: "allow" })).status, 403);
  const fresh = await consentPage(f, client.client_id);
  assert.equal((await consent({ Origin: issuer, Cookie: fresh.cookie }, { request_id: fresh.id, owner_code: expiredPair, decision: "allow" })).status, 403);
  assert.equal((await consent({ Origin: issuer, Cookie: fresh.cookie }, { request_id: fresh.id, owner_code: pair(f, now), decision: "allow" })).status, 303);
});

test("OAuth binds code to client, S256 verifier, redirect and resource, and consumes authorization once", async t => {
  let now = Date.now();
  const f = await fixture(t, () => now);
  const client = await register(f, { token_endpoint_auth_method: "client_secret_post" });
  const other = await register(f);
  const flow = await approve(f, client.client_id);
  const fields = { client_id: client.client_id, client_secret: client.client_secret!, grant_type: "authorization_code", code: flow.code, code_verifier: flow.verifier, redirect_uri: callback, resource };
  const wrongSecret = await postForm(f, "/token", { ...fields, client_secret: "wrong" });
  assert.equal(wrongSecret.status, 400); assert.equal((await wrongSecret.json() as { error: string }).error, "invalid_client");
  const wrongClient = await postForm(f, "/token", { ...fields, client_id: other.client_id, client_secret: "" });
  assert.equal(wrongClient.status, 400);
  for (const change of [{ code_verifier: secret() }, { redirect_uri: "https://attacker.example/callback" }, { resource: "https://other.example/mcp" }, { resource: "" }]) {
    assert.equal((await postForm(f, "/token", { ...fields, ...change })).status, 400);
  }
  const accepted = await Promise.all([postForm(f, "/token", fields), postForm(f, "/token", fields)]);
  assert.deepEqual(accepted.map(response => response.status).sort(), [200, 400]);
  const badScope = await f.fetchPath("/authorize?" + new URLSearchParams({ client_id: client.client_id, response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(secret()).digest("base64url"), resource, scope: "shell.admin" }));
  assert.equal(new URL(badScope.headers.get("location")!).searchParams.get("error"), "invalid_scope");
  const expired = await approve(f, client.client_id, now); now += 60001;
  assert.equal((await postForm(f, "/token", { ...fields, code: expired.code, code_verifier: expired.verifier })).status, 400);
});

test("Refresh rotates, rejects other client/audience, detects reuse and revokes the replacement grant", async t => {
  const f = await fixture(t);
  const { client, tokens } = await grant(f);
  const other = await register(f);
  const fields = { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token!, resource };
  assert.equal((await postForm(f, "/token", { ...fields, client_id: other.client_id })).status, 400);
  assert.equal((await postForm(f, "/token", { ...fields, resource: "https://other.example/mcp" })).status, 400);
  assert.equal((await postForm(f, "/token", { ...fields, scope: "shell.admin" })).status, 400);
  const rotated = await postForm(f, "/token", fields);
  assert.equal(rotated.status, 200);
  const next = await rotated.json() as OAuthTokens;
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.equal((await postForm(f, "/token", fields)).status, 400);
  assert.equal((await f.fetchPath("/mcp", { headers: { Authorization: `Bearer ${next.access_token}` } })).status, 401);
  assert.equal((await postForm(f, "/token", { ...fields, refresh_token: next.refresh_token! })).status, 400);
});

test("Access expiry, refresh family expiry and explicit revocation block subsequent requests", async t => {
  let now = Date.now();
  const f = await fixture(t, () => now);
  const { client, tokens } = await grant(f);
  const get = (token: string) => f.fetchPath("/mcp", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await get(tokens.access_token)).status, 405);
  now += 600001;
  assert.equal((await get(tokens.access_token)).status, 401);
  const fields = { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token!, resource };
  const refreshed = await postForm(f, "/token", fields);
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json() as OAuthTokens;
  assert.equal((await postForm(f, "/revoke", { client_id: client.client_id, token: next.refresh_token! })).status, 200);
  assert.equal((await get(next.access_token)).status, 401);
  now += 86400001;
  assert.equal((await postForm(f, "/token", { ...fields, refresh_token: next.refresh_token! })).status, 400);
});

test("OAuth registrations persist, active grants do not survive restart; corrupt or unwritable storage fails closed", async t => {
  const f = await fixture(t);
  const { client, tokens } = await grant(f);
  const replacement = new GatewayOAuth(f.directory, new URL(issuer), new URL(resource));
  t.after(() => replacement.close());
  assert.ok(await replacement.clientsStore.getClient(client.client_id));
  await assert.rejects(replacement.verifyAccessToken(tokens.access_token));
  assert.throws(() => new GatewayOAuth(f.directory, new URL("https://changed.example"), new URL("https://changed.example/mcp")));
  fs.writeFileSync(path.join(f.directory, "oauth-clients.json"), "[corrupted");
  assert.throws(() => new GatewayOAuth(f.directory, new URL(issuer), new URL(resource)));
  const blocked = path.join(f.directory, "blocked-store");
  const provider = new GatewayOAuth(blocked, new URL(issuer), new URL(resource));
  t.after(() => provider.close());
  fs.mkdirSync(path.join(blocked, "oauth-clients.json"), { recursive: true });
  assert.throws(() => provider.clientsStore.registerClient!({ client_id: "test-client", redirect_uris: [callback] } as any));
  assert.throws(() => provider.clientsStore.getClient("test-client"));
});

test("Gateway rejects unsafe deployment/backend metadata and unsupported client auth/redirects", async t => {
  const f = await fixture(t);
  for (const input of ["http://gateway.example", "https://localhost", "https://127.0.0.1", issuer + "/nested", issuer + "?query=secret", "https://user:password@gateway.example"]) assert.throws(() => publicIssuer(input));
  for (const endpoint of ["https://upstream.example/mcp", "http://localhost:9234/mcp", "http://127.0.0.1:9234/mcp?secret=1", "http://127.0.0.1:9234/host"]) {
    writePrivateFile(f.descriptor, JSON.stringify({ version: 1, pid: process.pid, endpoint, bearerToken: f.host.bearer, authentication: "local_bearer" }));
    assert.throws(() => readHostDescriptor(f.descriptor));
  }
  for (const extra of [{ token_endpoint_auth_method: "client_secret_basic" }, { redirect_uris: ["http://redirect.example/cb"] }, { redirect_uris: ["https://redirect.example/cb#fragment"] }, { scope: "shell.admin" }]) {
    const response = await f.fetchPath("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [callback], ...extra }) });
    assert.equal(response.status, 400);
  }
  const callbacks = Array.from({ length: 8 }, (_, index) => `https://connector.example/${index}/` + "x".repeat(1900));
  let capacityReached = false;
  for (let index = 0; index < 12; index++) {
    const response = await f.fetchPath("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: callbacks, token_endpoint_auth_method: "none" }) });
    if (response.status !== 201) {
      assert.equal((await response.json() as { error: string }).error, "temporarily_unavailable");
      capacityReached = true; break;
    }
  }
  assert.equal(capacityReached, true); assert.ok(fs.statSync(path.join(f.directory, "oauth-clients.json")).size <= 131072);
  const restored = new GatewayOAuth(f.directory, new URL(issuer), new URL(resource));
  restored.close(); // A full registry must remain readable after restart.
});

test("Gateway CLI binds loopback, owns one state writer and keeps owner pairing secrets out of output", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-host-test-"));
  const cli = fileURLToPath(new URL("./gateway-cli.js", import.meta.url));
  const env = { ...process.env, AG_MCP_PUBLIC_URL: issuer, AG_MCP_GATEWAY_STATE_DIR: directory, AG_MCP_GATEWAY_PORT: "0" };
  const child = spawn(process.execPath, [cli], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", data => { output += String(data); }); child.stderr.on("data", data => { errors += String(data); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill(); await stopped;
    }
    removeOwnedFixture(directory);
  });
  const expires = Date.now() + 5000;
  while (!output.includes('"gateway":"listening"') && Date.now() < expires && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(output, /"gateway":"listening"/); assert.equal(errors, "");
  const descriptor = JSON.parse(readPrivateFile(path.join(directory, "gateway.json")));
  assert.match(descriptor.bind, /^127\.0\.0\.1:\d+$/);
  assert.equal(descriptor.publicReachability, "not_verified");
  assert.equal((await wireFetch("http://" + descriptor.bind + "/health", { headers: { Host: new URL(issuer).host, "X-Forwarded-Proto": "https" } })).status, 200);
  const execute = promisify(execFile);
  await assert.rejects(execute(process.execPath, [cli], { env, windowsHide: true, timeout: 5000 }));
  const paired = await execute(process.execPath, [cli, "--pair"], { env, windowsHide: true, timeout: 5000 });
  const codeFile = JSON.parse(paired.stdout).codeFile;
  const code = readPrivateFile(codeFile).trim();
  assert.equal(paired.stdout.includes(code), false); assert.equal(output.includes(code), false); assert.equal(paired.stderr, "");
  const stopped = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill(); await stopped;
  await assert.rejects(wireFetch("http://" + descriptor.bind + "/health"));
});

test("Gateway cuts off stalled bodies and a silent backend within real deadlines without retrying the POST", async t => {
  const f = await fixture(t);
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const request = http.request(f.bind + "/register", { method: "POST", headers: { Host: new URL(issuer).host, "X-Forwarded-Proto": "https", "Content-Type": "application/json", "Content-Length": "100" }, signal: AbortSignal.timeout(7500) }, response => { response.resume(); response.on("end", resolve); });
    request.on("error", (error: NodeJS.ErrnoException) => error.code === "ECONNRESET" ? resolve() : reject(error));
    request.write("{"); // Keep the socket open without completing the declared body.
  });
  assert.ok(Date.now() - started < 7000);
  assert.equal((await f.fetchPath("/health")).status, 200);
  const { tokens } = await grant(f);
  let calls = 0;
  const silent = http.createServer(request => { calls++; request.resume(); });
  t.after(async () => { silent.closeAllConnections(); await new Promise<void>(resolve => silent.close(() => resolve())); });
  await new Promise<void>(resolve => silent.listen(0, "127.0.0.1", resolve));
  writePrivateFile(f.descriptor, JSON.stringify({ version: 1, pid: process.pid, endpoint: `http://127.0.0.1:${(silent.address() as { port: number }).port}/mcp`, bearerToken: f.host.bearer, authentication: "local_bearer" }));
  const forwarded = Date.now();
  const response = await f.fetchPath("/mcp", { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(response.status, 503); assert.ok(Date.now() - forwarded < 12500); assert.equal(calls, 1);
});
