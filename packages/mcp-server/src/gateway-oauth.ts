import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { OAuthClientInformationFullSchema, type OAuthClientInformationFull, type OAuthTokens, type OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError, InvalidRequestError, ServerError, TemporarilyUnavailableError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { consumeOwnerPairing, digest, readPrivateFile, sameSecret, secret, writePrivateFile } from "./gateway-state.js";

const SCOPE = "ide.tools";
const COOKIE = "__Host-gemini-mcp-consent";
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
type Pending = { clientId: string; params: AuthorizationParams; csrf: string; expiresAt: number; attempts: number };
type Code = { clientId: string; redirect: string; challenge: string; expiresAt: number };
type Family = { clientId: string; expiresAt: number; revoked: boolean };
type Access = { family: string; expiresAt: number };
type Refresh = Access & { spent: boolean };

/** OAuth protocol endpoints/PKCE metadata are provided by the official MCP SDK. */
export class GatewayOAuth implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  // Validate S256 here so client/resource/redirect validation and code consumption share one atomic boundary.
  readonly skipLocalPkceValidation = true;
  private clients = new Map<string, OAuthClientInformationFull>();
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Code>();
  private families = new Map<string, Family>();
  private access = new Map<string, Access>();
  private refresh = new Map<string, Refresh>();
  private failed = false;
  private closed = false;
  private readonly file: string;

  constructor(readonly directory: string, readonly issuer: URL, readonly resource: URL, private readonly now = () => Date.now()) {
    this.file = path.join(directory, "oauth-clients.json");
    try {
      if (fs.existsSync(this.file)) {
        const data: unknown = JSON.parse(readPrivateFile(this.file));
        if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("issuer" in data) || data.issuer !== issuer.href || !("clients" in data) || !Array.isArray(data.clients) || data.clients.length > 64) throw Error("Invalid OAuth state");
        for (const raw of data.clients) {
          const client = OAuthClientInformationFullSchema.parse(raw);
          this.validateMetadata(client);
          if (this.clients.has(client.client_id)) throw Error("Duplicate OAuth client");
          this.clients.set(client.client_id, client);
        }
      }
    } catch { throw new ServerError("OAuth client storage is unavailable or belongs to another issuer."); }
    this.clientsStore = {
      getClient: id => { this.assertReady(); const client = this.clients.get(id); return client ? structuredClone(client) : undefined; },
      registerClient: data => this.register(data)
    };
  }

  private assertReady() {
    if (this.failed || this.closed) throw new ServerError("OAuth gateway state is unavailable.");
  }
  private validateMetadata(client: Omit<OAuthClientInformationFull, "client_id">) {
    if (client.redirect_uris.length < 1 || client.redirect_uris.length > 8 || (client.client_name?.length ?? 0) > 128 || !["none", "client_secret_post"].includes(client.token_endpoint_auth_method ?? "client_secret_post") || client.grant_types?.some(g => !["authorization_code", "refresh_token"].includes(g)) || client.response_types?.some(r => r !== "code")) throw new InvalidClientMetadataError("Unsupported client metadata.");
    for (const text of client.redirect_uris) {
      const uri = new URL(text);
      if (text.length > 2048 || uri.protocol !== "https:" || uri.username || uri.password || uri.hash) throw new InvalidClientMetadataError("Redirect URIs must use HTTPS without credentials or fragments.");
    }
    if (client.scope && client.scope !== SCOPE) throw new InvalidClientMetadataError("Only ide.tools is supported.");
  }
  private register(data: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
    this.assertReady(); this.validateMetadata(data);
    if (this.clients.size >= 64) throw new TemporarilyUnavailableError("Client registration capacity reached. Owner review is required.");
    // SDK generates the ID/secret before invoking the store. Never fetch untrusted logo/client URLs.
    const parsed = OAuthClientInformationFullSchema.parse(data);
    const client: OAuthClientInformationFull = {
      client_id: parsed.client_id, client_id_issued_at: parsed.client_id_issued_at,
      client_secret: parsed.client_secret, client_secret_expires_at: parsed.client_secret_expires_at,
      client_name: parsed.client_name ?? "MCP connector", redirect_uris: parsed.redirect_uris,
      token_endpoint_auth_method: parsed.token_endpoint_auth_method ?? "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: SCOPE
    };
    if (this.clients.has(client.client_id)) throw new InvalidClientMetadataError("Duplicate client ID.");
    const serialized = JSON.stringify({ version: 1, issuer: this.issuer.href, clients: [...this.clients.values(), client] });
    if (Buffer.byteLength(serialized, "utf8") > 131072) throw new TemporarilyUnavailableError("Client registration storage capacity reached. Owner review is required.");
    try { writePrivateFile(this.file, serialized); }
    catch { this.failed = true; throw new ServerError("Client registration could not be persisted."); }
    this.clients.set(client.client_id, client);
    return structuredClone(client);
  }
  private requireResource(resource?: URL) {
    if (resource?.href !== this.resource.href) throw new InvalidTargetError("The resource must match this MCP endpoint.");
  }
  private requireScope(scopes?: string[]) {
    if (scopes?.length && (scopes.length !== 1 || scopes[0] !== SCOPE)) throw new InvalidScopeError("Only ide.tools is supported.");
  }
  private prune() {
    const now = this.now();
    for (const [id, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(id);
    for (const [id, value] of this.codes) if (value.expiresAt <= now) this.codes.delete(id);
    for (const [id, value] of this.families) if (value.expiresAt <= now) this.families.delete(id);
    for (const [id, value] of this.access) if (value.expiresAt <= now || !this.families.has(value.family)) this.access.delete(id);
    // Keep spent refresh hashes until family expiry to detect reuse and revoke the replacement tokens.
    for (const [id, value] of this.refresh) if (!this.families.has(value.family)) this.refresh.delete(id);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, response: Response) {
    this.assertReady(); this.prune(); this.requireResource(params.resource); this.requireScope(params.scopes);
    if (!/^[a-zA-Z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 1024) throw new InvalidRequestError("Invalid authorization parameters.");
    if (this.pending.size >= 64) throw new TemporarilyUnavailableError("Too many pending authorization requests.");
    const id = secret(), csrf = secret();
    this.pending.set(id, { clientId: client.client_id, params: { ...params, scopes: params.scopes?.slice(), resource: params.resource ? new URL(params.resource) : undefined }, csrf, expiresAt: this.now() + 300000, attempts: 0 });
    response.cookie(COOKIE, csrf, { secure: true, httpOnly: true, sameSite: "lax", path: "/", maxAge: 300000 });
    response.type("html").send(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Cấp quyền MCP</title><body><main><h1>Cấp quyền kết nối công cụ IDE</h1><p>Ứng dụng: <strong>${escapeHtml(client.client_name ?? "MCP connector")}</strong></p><p>Chuyển về: ${escapeHtml(params.redirectUri)}</p><p>Quyền: ide.tools — gửi yêu cầu tới các công cụ được task IDE cho phép. IDE vẫn xác nhận và thực thi lệnh. Kết nối này không cấp quyền chạy shell trực tiếp.</p><p>Chỉ tiếp tục nếu chính bạn đang thêm connector này. Lấy mã cấp quyền một lần bằng lệnh <code>npm run mcp:gateway:pair</code> trên máy đang chạy gateway. Không gửi mã cho người khác.</p><form method="post" action="/consent"><input type="hidden" name="request_id" value="${id}"><label>Mã cấp quyền <input type="password" name="owner_code" maxlength="64" autocomplete="off"></label><p><button name="decision" value="allow">Cấp quyền</button> <button name="decision" value="deny">Từ chối</button></p></form></main></body></html>`);
  }

  consent(request: Request, response: Response) {
    this.assertReady(); this.prune();
    const body = request.body as Record<string, unknown> | undefined;
    const id = typeof body?.request_id === "string" ? body.request_id : "";
    const pending = this.pending.get(id);
    const cookies = (request.headers.cookie ?? "").split(";").map(c => c.trim());
    const cookie = cookies.find(c => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) ?? "";
    if (request.headers.origin !== this.issuer.origin || !pending || !sameSecret(cookie, pending.csrf)) { response.status(403).json({ error: "access_denied" }); return; }
    const redirect = new URL(pending.params.redirectUri);
    if (pending.params.state) redirect.searchParams.set("state", pending.params.state);
    if (body?.decision === "deny") redirect.searchParams.set("error", "access_denied");
    else if (body?.decision === "allow" && typeof body.owner_code === "string") {
      pending.attempts++;
      if (!consumeOwnerPairing(this.directory, body.owner_code, this.now())) {
        if (pending.attempts >= 5) this.pending.delete(id);
        response.status(403).json({ error: "access_denied", error_description: "Invalid or expired owner code. No permission was granted." }); return;
      }
      if (this.codes.size >= 64) throw new TemporarilyUnavailableError("Authorization code capacity reached.");
      const code = secret();
      this.codes.set(digest(code), { clientId: pending.clientId, redirect: pending.params.redirectUri, challenge: pending.params.codeChallenge, expiresAt: this.now() + 60000 });
      redirect.searchParams.set("code", code);
    } else { response.status(400).json({ error: "invalid_request" }); return; }
    this.pending.delete(id);
    response.clearCookie(COOKIE, { secure: true, httpOnly: true, sameSite: "lax", path: "/" });
    response.redirect(303, redirect.href);
  }

  private codeFor(client: OAuthClientInformationFull, code: string) {
    this.assertReady(); this.prune();
    const value = this.codes.get(digest(code));
    if (!value || value.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code.");
    return value;
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) { return this.codeFor(client, code).challenge; }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, verifier?: string, redirect?: string, resource?: URL): Promise<OAuthTokens> {
    const entry = this.codeFor(client, code);
    this.requireResource(resource);
    if (redirect !== entry.redirect || !verifier || !/^[a-zA-Z0-9._~-]{43,128}$/.test(verifier) || !sameSecret(createHash("sha256").update(verifier).digest("base64url"), entry.challenge)) throw new InvalidGrantError("Code binding or PKCE verification failed.");
    this.codes.delete(digest(code));
    if (this.families.size >= 128) throw new TemporarilyUnavailableError("Token capacity reached.");
    const family = secret();
    this.families.set(family, { clientId: client.client_id, expiresAt: this.now() + 86400000, revoked: false });
    return this.issueTokens(family);
  }
  private issueTokens(family: string): OAuthTokens {
    if (this.access.size >= 2048 || this.refresh.size >= 2048) throw new TemporarilyUnavailableError("Token capacity reached. Reauthorization is required.");
    const access = secret(), refresh = secret(), expiresAt = this.now() + 600000;
    this.access.set(digest(access), { family, expiresAt });
    this.refresh.set(digest(refresh), { family, expiresAt: this.families.get(family)!.expiresAt, spent: false });
    return { access_token: access, token_type: "Bearer", expires_in: 600, refresh_token: refresh, scope: SCOPE };
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.assertReady(); this.prune(); this.requireResource(resource); this.requireScope(scopes);
    const entry = this.refresh.get(digest(token));
    const family = entry && this.families.get(entry.family);
    if (!entry || !family || family.revoked || family.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token.");
    if (entry.spent) { family.revoked = true; throw new InvalidGrantError("Refresh token reuse detected. Reauthorization is required."); }
    entry.spent = true;
    return this.issueTokens(entry.family);
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.assertReady(); this.prune();
    const entry = this.access.get(digest(token));
    const family = entry && this.families.get(entry.family);
    if (!entry || !family || family.revoked) throw new InvalidTokenError("Invalid or expired access token.");
    return { token, clientId: family.clientId, scopes: [SCOPE], expiresAt: Math.floor(entry.expiresAt / 1000), resource: this.resource };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    this.assertReady(); this.prune();
    const entry = this.access.get(digest(request.token)) ?? this.refresh.get(digest(request.token));
    const family = entry && this.families.get(entry.family);
    if (family?.clientId === client.client_id) family.revoked = true;
  }
  close() { this.closed = true; this.pending.clear(); this.codes.clear(); this.families.clear(); this.access.clear(); this.refresh.clear(); }
}
