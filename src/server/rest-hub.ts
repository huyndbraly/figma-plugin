/**
 * The Figma REST personal access token (PAT), held in RAM only, and every
 * request that uses it.
 *
 * Where the token comes from, in order:
 *   1. the plugin panel (REST Token field → figma.clientStorage → hello /
 *      set_rest_token over the WebSocket), held by the LEADER;
 *   2. `process.env.FIGMA_TOKEN` of this process.
 *
 * The token itself never leaves this module except as the `X-Figma-Token`
 * header of a request to api.figma.com: it is not written to disk, not
 * logged, and not returned to an agent. What the outside world gets is a
 * {@link TokenStatus} — state, source, the Figma handle it belongs to and a
 * masked preview (`figd_…a1b2`).
 *
 * Every request goes through {@link RestHub.fetch}: it injects the current
 * token, times the call, emits a {@link RestEvent} (the plugin panel counts and
 * logs them) and moves the status to invalid / rate-limited the moment a real
 * request says so — no waiting for the next check.
 *
 * A FOLLOWER process has no plugin connection of its own, so it holds no
 * plugin token: its requests are forwarded to the leader (`__rest_fetch__`
 * over the authenticated /rpc), which runs them with ITS token. The token
 * stays in one process; the follower gets the response.
 */
import { ErrorCode, OpError } from "./errors.js";
import { cleanRestToken, maskRestToken } from "../shared/rest-token.js";

export type RestFetch = (url: string, init: RequestInit) => Promise<Response>;

export const REST_API_BASE = "https://api.figma.com/v1";

export type TokenState =
  /** No plugin token and no FIGMA_TOKEN. */
  | "not_set"
  /** A token is set but has not been checked yet (env token before first use). */
  | "unverified"
  | "checking"
  | "valid"
  /** Figma answered 401/403 for the token itself (expired, revoked, mistyped). */
  | "invalid"
  | "rate_limited"
  /** The check could not run (offline, DNS, Figma 5xx). */
  | "error";

export interface TokenStatus {
  state: TokenState;
  source: "plugin" | "env" | null;
  /** `figd_…a1b2` — never the token. */
  masked?: string;
  /** Figma handle of the token's owner, from GET /v1/me. */
  handle?: string;
  /** HTTP status that put the token in its state (401, 403, 429…). */
  httpStatus?: number;
  message?: string;
  checkedAt?: number;
  /**
   * Scopes the token was created with, as Figma lists them in a 403
   * "Invalid scope: [...]" answer (probed once per check). Absent = unknown.
   */
  scopes?: string[];
  /** Scopes a real request was refused for ("This endpoint requires …"). */
  missingScopes?: string[];
  /** Rate-limited: when Figma said to try again (epoch ms, from Retry-After). */
  retryAt?: number;
  /** Rate-limited: Figma's plan tier / limit type headers ("starter", "low"). */
  planTier?: string;
  rateLimitType?: string;
  /**
   * When the token expires (epoch ms), as the USER said when saving it —
   * Figma's API has no way to ask. Absent = not stated.
   */
  expiresAt?: number;
}

/** One REST request, as the plugin panel shows it. Carries no token. */
export interface RestEvent {
  type: "rest_event";
  at: number;
  /** What the request did: get_nodes, render, get_comments, post_comment, me… */
  op: string;
  method: string;
  fileKey?: string;
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  ms: number;
  ok: boolean;
  kind: "read" | "write";
  /** Short human text for a failed request ("Token expired", "Rate-limited"). */
  message?: string;
}

/** Plain, JSON-safe response a leader hands a follower for `__rest_fetch__`. */
export interface ForwardedResponse {
  noToken?: true;
  status?: number;
  retryAfter?: string | null;
  contentType?: string | null;
  planTier?: string | null;
  rateLimitType?: string | null;
  upgradeLink?: string | null;
  bodyBase64?: string;
}

export interface ForwardedRequest {
  url: string;
  method?: string;
  body?: string;
  contentType?: string;
}

/** `figd_…a1b2`. Short or odd strings get no characters at all. */
export const maskToken = maskRestToken;
/** A token as typed: no spaces inside, sane length. Returns the trimmed token or null. */
export const cleanToken = cleanRestToken;

/** Name a REST call by what it does, for the activity log. */
export function describeRequest(url: string, method: string): { op: string; fileKey?: string } {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* relative already */
  }
  path = path.replace(/^\/v1/, "");
  const m = /^\/(files|images)\/([^/?]+)(\/[^?]*)?/.exec(path);
  const fileKey = m ? decodeURIComponent(m[2]!) : undefined;
  const rest = m?.[3] ?? "";
  let op: string;
  if (path === "/me") op = "me";
  else if (m?.[1] === "images") op = "render";
  else if (rest.startsWith("/nodes")) op = "get_nodes";
  else if (rest.startsWith("/comments")) op = method === "POST" ? "post_comment" : method === "DELETE" ? "delete_comment" : "get_comments";
  else if (rest.startsWith("/versions")) op = "get_versions";
  else if (rest.startsWith("/styles")) op = "get_styles";
  else if (rest.startsWith("/component_sets")) op = "get_component_sets";
  else if (rest.startsWith("/components")) op = "get_components";
  else if (rest.startsWith("/variables")) op = "get_variables";
  else if (rest.startsWith("/images")) op = "image_fills";
  else if (m) op = "get_file";
  else op = path.split("/").filter(Boolean)[0] ?? "request";
  return { op, ...(fileKey ? { fileKey } : {}) };
}

/** What a failed Figma REST answer means — read from the status AND the body. */
export interface RestFailure {
  kind: "token" | "scope" | "access" | "not_found" | "rate" | "plan" | "other";
  /** The scope(s) the endpoint said it needs (kind "scope"). */
  requiredScopes?: string[];
  /** The scopes Figma says the token has (kind "scope"). */
  grantedScopes?: string[];
  /** Figma's own words, trimmed. */
  detail?: string;
}

/**
 * Figma's error bodies come in two shapes — `{status, err}` and
 * `{error, status, message}` — measured against the live API (2026-11-27):
 *   401 {"err":"Invalid token"} · 401 {"err":"Missing credentials"}
 *   403 {"message":"Invalid scope: [\"current_user:read\", …]. This endpoint
 *        requires the file_read or files:read or projects:read scope."}
 *   404 {"err":"Not found"}
 * A missing scope is NOT a bad token: the badge must stay "Valid" and the
 * error must name the scope to add.
 */
export function classifyRestFailure(status: number, body: string): RestFailure {
  let detail = body;
  try {
    const j = JSON.parse(body) as { err?: unknown; message?: unknown };
    detail = String(j.message ?? j.err ?? body);
  } catch {
    /* not JSON */
  }
  detail = detail.slice(0, 600);
  if (/invalid scope|requires the .* scope/i.test(detail)) {
    const req = /requires the (.+?) scopes?\b/i.exec(detail)?.[1];
    const requiredScopes = req ? req.split(/\s+or\s+|,\s*/).map((x) => x.trim()).filter(Boolean) : undefined;
    const list = /invalid scope:\s*(\[[^\]]*\])/i.exec(detail)?.[1];
    let grantedScopes: string[] | undefined;
    try {
      grantedScopes = list ? (JSON.parse(list) as string[]) : undefined;
    } catch {
      grantedScopes = undefined;
    }
    return { kind: "scope", ...(requiredScopes ? { requiredScopes } : {}), ...(grantedScopes ? { grantedScopes } : {}), detail };
  }
  if (status === 401) return { kind: "token", detail };
  if (status === 403) {
    if (/invalid token|token (has )?expired|expired token|revoked|missing credentials/i.test(detail)) return { kind: "token", detail };
    if (/plan|upgrade|enterprise|organization/i.test(detail)) return { kind: "plan", detail };
    return { kind: "access", detail };
  }
  if (status === 404) return { kind: "not_found", detail };
  if (status === 429) return { kind: "rate", detail };
  return { kind: "other", detail };
}

function failureText(status: number, f: RestFailure | null): string {
  if (status === 0) return "Network error";
  if (f?.kind === "token") return "Token expired / invalid";
  if (f?.kind === "scope") return `Missing scope ${f.requiredScopes?.join(" | ") ?? ""}`.trim();
  if (f?.kind === "plan") return "Needs a higher Figma plan";
  if (status === 403) return "No access";
  if (status === 404) return "Not found";
  if (status === 429) return "Rate-limited";
  return `HTTP ${status}`;
}

/**
 * The OpError a REST caller throws for a failed answer, with the next step
 * that fits the cause. `what` names the action ("read this file").
 */
/** "4.6 days", "3 h", "45 s". */
export function humanDuration(sec: number): string {
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172_800) return `${Math.round(sec / 360) / 10} h`;
  return `${Math.round(sec / 8640) / 10} days`;
}

/**
 * A 429 is retried only when Figma asks for a SHORT wait. Measured on a
 * Starter-plan token (2026-11-27): `Retry-After: 399946` (4.6 days),
 * `X-Figma-Rate-Limit-Type: low`, `X-Figma-Plan-Tier: starter` — retrying
 * that four times only hung the agent for minutes before the same failure.
 */
export const MAX_RETRY_WAIT_S = 20;

/** ms to wait before retrying a 429, or null to give up now. */
export function retryDelayMs(headers: Headers, attempt: number): number | null {
  if (attempt >= 3) return null;
  const raw = headers.get("retry-after");
  const sec = Number(raw);
  if (raw !== null && Number.isFinite(sec) && sec > 0) return sec > MAX_RETRY_WAIT_S ? null : sec * 1000;
  return Math.min(MAX_RETRY_WAIT_S, 2 ** attempt * 2) * 1000;
}

export function restError(status: number, body: string, what: string, headers?: Headers): OpError {
  const f = classifyRestFailure(status, body);
  if (f.kind === "rate") {
    const sec = Number(headers?.get("retry-after"));
    const tier = headers?.get("x-figma-plan-tier");
    const type = headers?.get("x-figma-rate-limit-type");
    const upgrade = headers?.get("x-figma-upgrade-link");
    const wait = Number.isFinite(sec) && sec > 0 ? humanDuration(sec) : null;
    return new OpError(
      ErrorCode.RATE_LIMITED,
      `Figma's REST rate limit for this token is used up${wait ? ` — retry in ${wait}` : ""}${tier ? ` (plan tier "${tier}"${type ? `, limit "${type}"` : ""})` : ""}.`,
      `Do not retry now. ${tier === "starter" || type === "low" ? "Starter / view-seat plans get very few file reads through REST; " : ""}read the file through the plugin instead: ask the user to open it in Figma Desktop with Figma Plugin MCP running (no REST quota there), then call again${upgrade ? `. Higher limits: ${upgrade}` : ""}.`,
    );
  }
  switch (f.kind) {
    case "scope":
      return new OpError(
        ErrorCode.UNAUTHORIZED,
        `The Figma token is missing a permission to ${what}: this endpoint needs ${f.requiredScopes?.map((x) => `\`${x}\``).join(" or ") ?? "another scope"}.`,
        `Ask the user to create a new personal access token with ${f.requiredScopes?.[0] ?? "that scope"} checked (Figma → Settings → Security → Personal access tokens) and paste it into the plugin panel (REST Token → Save).${f.grantedScopes ? ` The current token has: ${f.grantedScopes.join(", ")}.` : ""}`,
      );
    case "token":
      return new OpError(
        ErrorCode.UNAUTHORIZED,
        `Figma rejected the token (${status}: ${f.detail}).`,
        "It has expired (personal access tokens last 1–90 days), been revoked, or was mistyped. Ask the user to generate a new one and paste it into the plugin panel (REST Token → Save), or update FIGMA_TOKEN.",
      );
    case "plan":
      return new OpError(ErrorCode.PLAN_LIMIT, `Figma refused to ${what} on this plan (${status}: ${f.detail}).`, "This endpoint needs a higher Figma plan (e.g. Variables REST needs Enterprise). Open the file with the plugin instead — the Plugin API has no such limit.");
    case "access":
      return new OpError(ErrorCode.UNAUTHORIZED, `The token's owner has no access to ${what} (403).`, "Check the file is shared with the account that made the token (the handle in figma_status.restToken), or open it in Figma with the plugin running.");
    case "not_found":
      return new OpError(ErrorCode.NODE_NOT_FOUND, "Figma has no such file or node (404).", "Check the link / fileKey — it is the part after /design/ or /file/ in the URL. A file the token cannot see also answers 404.");
    default:
      return new OpError(ErrorCode.INTERNAL, `Figma REST ${status}: ${f.detail}`);
  }
}

export interface RestHubOptions {
  /** Where the env token comes from (default: process.env.FIGMA_TOKEN). */
  env?: () => string | undefined;
  /** The network (default: global fetch). */
  fetch?: RestFetch;
  now?: () => number;
}

export class RestHub {
  private pluginToken: string | null = null;
  /** When the user said the plugin token expires (epoch ms). */
  private pluginExpiresAt?: number;
  private status: TokenStatus;
  /** Bumped on every token change; stale checks and caches compare it. */
  private gen = 0;
  private checking?: Promise<TokenStatus>;
  private checkingGen = -1;
  private recheckTimer?: NodeJS.Timeout;
  private readonly statusListeners = new Set<(s: TokenStatus) => void>();
  private readonly eventListeners = new Set<(e: RestEvent) => void>();
  private remoteFn?: () => ((req: ForwardedRequest) => Promise<ForwardedResponse>) | undefined;
  private remoteStatusFn?: () => Promise<TokenStatus | undefined>;
  private remoteStatusCache?: { at: number; value: TokenStatus | undefined };
  private envFn: () => string | undefined;
  private net: RestFetch;
  private now: () => number;

  constructor(opts: RestHubOptions = {}) {
    this.envFn = opts.env ?? (() => process.env.FIGMA_TOKEN);
    this.net = opts.fetch ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? Date.now;
    this.status = this.baseStatus();
  }

  /** Test seam / reconfiguration. */
  configure(opts: RestHubOptions): void {
    if (opts.env) this.envFn = opts.env;
    if (opts.fetch) this.net = opts.fetch;
    if (opts.now) this.now = opts.now;
    this.status = this.baseStatus();
  }

  /** Back to a fresh state (tests). */
  reset(): void {
    this.pluginToken = null;
    this.pluginExpiresAt = undefined;
    this.gen++;
    this.checking = undefined;
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = undefined;
    this.remoteFn = undefined;
    this.remoteStatusFn = undefined;
    this.remoteStatusCache = undefined;
    this.statusListeners.clear();
    this.eventListeners.clear();
    this.status = this.baseStatus();
  }

  /**
   * On a follower: how to run a request on the leader, and how to read the
   * leader's token status. Called per request, so a takeover (follower →
   * leader) switches to local at once.
   */
  setRemote(
    fn: () => ((req: ForwardedRequest) => Promise<ForwardedResponse>) | undefined,
    statusFn?: () => Promise<TokenStatus | undefined>,
  ): void {
    this.remoteFn = fn;
    this.remoteStatusFn = statusFn;
  }

  private remote(): ((req: ForwardedRequest) => Promise<ForwardedResponse>) | undefined {
    return this.remoteFn?.();
  }

  private envToken(): string | undefined {
    return cleanToken(this.envFn()) ?? undefined;
  }

  /** The token requests use: the plugin's, else FIGMA_TOKEN. Server-internal only. */
  token(): string | undefined {
    return this.pluginToken ?? this.envToken();
  }

  source(): "plugin" | "env" | null {
    return this.pluginToken ? "plugin" : this.envToken() ? "env" : null;
  }

  /** Changes whenever the token does (cache keys). */
  generation(): number {
    return this.gen;
  }

  private baseStatus(): TokenStatus {
    const token = this.token();
    if (!token) return { state: "not_set", source: null };
    return { state: "unverified", source: this.source(), masked: maskToken(token), ...this.expiryField() };
  }

  private expiryField(): { expiresAt?: number } {
    return this.pluginToken && this.pluginExpiresAt ? { expiresAt: this.pluginExpiresAt } : {};
  }

  /**
   * Which scopes the token has. Figma has no introspection endpoint, but a
   * 403 for a missing scope lists the token's scopes — so ask an endpoint
   * that needs a scope a PAT normally lacks (projects:read). Any other
   * answer means "unknown" (or that it HAS projects:read): never a failure.
   */
  private async probeScopes(token: string): Promise<string[] | undefined> {
    try {
      const res = await this.net(`${REST_API_BASE}/teams/0/projects`, { headers: { "X-Figma-Token": token } });
      if (res.status !== 403) return undefined;
      const f = classifyRestFailure(403, await res.text());
      return f.kind === "scope" ? f.grantedScopes : undefined;
    } catch {
      return undefined;
    }
  }

  getStatus(): TokenStatus {
    return { ...this.status };
  }

  /**
   * Status as THIS process sees it: on a follower with no token of its own,
   * the leader's (that is the one its requests will use).
   */
  async effectiveStatus(): Promise<TokenStatus> {
    if (this.remote() && this.remoteStatusFn) {
      const c = this.remoteStatusCache;
      let leader: TokenStatus | undefined;
      if (c && this.now() - c.at < 5_000) leader = c.value;
      else {
        leader = await this.remoteStatusFn().catch(() => undefined);
        this.remoteStatusCache = { at: this.now(), value: leader };
      }
      if (leader && leader.state !== "not_set") return { ...leader };
    }
    return this.getStatus();
  }

  /** Can a REST request be made from this process right now? */
  async available(): Promise<boolean> {
    if (this.token()) return true;
    const s = await this.effectiveStatus();
    return s.state !== "not_set";
  }

  onStatus(fn: (s: TokenStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  onEvent(fn: (e: RestEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  private setStatus(s: TokenStatus): void {
    this.status = s;
    for (const fn of this.statusListeners) {
      try {
        fn({ ...s });
      } catch {
        /* a listener must not break the hub */
      }
    }
  }

  private emit(e: RestEvent): void {
    for (const fn of this.eventListeners) {
      try {
        fn(e);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * The plugin panel saved (string) or cleared (null) the token. Returns the
   * status right away ("checking" / "not_set"); the check runs in the
   * background and reports through onStatus.
   */
  setPluginToken(raw: string | null, meta: { expiresAt?: number | null } = {}): TokenStatus {
    const token = raw === null ? null : cleanToken(raw);
    const expiresAt = typeof meta.expiresAt === "number" && Number.isFinite(meta.expiresAt) && meta.expiresAt > 0 ? meta.expiresAt : undefined;
    if (raw !== null && !token) {
      this.setStatus({
        state: "invalid",
        source: "plugin",
        message: "That does not look like a Figma personal access token (figd_…).",
        checkedAt: this.now(),
      });
      return this.getStatus();
    }
    if (token === this.pluginToken && this.status.state !== "not_set") {
      if (expiresAt !== undefined && expiresAt !== this.pluginExpiresAt) {
        this.pluginExpiresAt = expiresAt;
        this.setStatus({ ...this.status, expiresAt });
      }
      // Same token again (reconnect hello): keep the state, re-check only if
      // it never succeeded.
      if (this.status.state === "error" || this.status.state === "unverified") void this.check();
      return this.getStatus();
    }
    this.pluginToken = token;
    this.pluginExpiresAt = token ? expiresAt : undefined;
    this.gen++;
    if (!this.token()) {
      this.setStatus({ state: "not_set", source: null });
      return this.getStatus();
    }
    void this.check();
    return this.getStatus();
  }

  /** GET /v1/me with the current token. Concurrent callers share one request. */
  check(): Promise<TokenStatus> {
    const token = this.token();
    if (!token) {
      this.setStatus({ state: "not_set", source: null });
      return Promise.resolve(this.getStatus());
    }
    // Share an in-flight check only when it is about the same token.
    if (this.checking && this.checkingGen === this.gen) return this.checking;
    const gen = this.gen;
    this.checkingGen = gen;
    const source = this.source();
    const masked = maskToken(token);
    this.setStatus({ state: "checking", source, masked, ...this.expiryField() });
    const started = this.now();
    const run = (async (): Promise<TokenStatus> => {
      let next: TokenStatus;
      let status = 0;
      try {
        const res = await this.net(`${REST_API_BASE}/me`, { headers: { "X-Figma-Token": token } });
        status = res.status;
        if (res.ok) {
          const me = (await res.json().catch(() => ({}))) as { handle?: unknown; email?: unknown };
          const scopes = await this.probeScopes(token);
          next = {
            state: "valid",
            source,
            masked,
            ...(typeof me.handle === "string" && me.handle ? { handle: me.handle } : {}),
            httpStatus: res.status,
            checkedAt: this.now(),
            ...(scopes ? { scopes } : {}),
          };
        } else if (res.status === 401 || res.status === 403) {
          const f = classifyRestFailure(res.status, await res.text().catch(() => ""));
          next =
            f.kind === "scope"
              ? // A token made without current_user:read cannot call /me — but it is not a bad token.
                { state: "valid", source, masked, httpStatus: res.status, message: "The token works but lacks current_user:read, so its owner is unknown.", checkedAt: this.now(), ...(f.grantedScopes ? { scopes: f.grantedScopes } : {}) }
              : { state: "invalid", source, masked, httpStatus: res.status, message: `Figma rejected the token (${f.detail ?? res.status}) — expired, revoked or mistyped.`, checkedAt: this.now() };
        } else if (res.status === 429) {
          next = { state: "rate_limited", source, masked, httpStatus: 429, message: "Figma is rate-limiting this token; requests retry with Retry-After.", checkedAt: this.now() };
        } else {
          next = { state: "error", source, masked, httpStatus: res.status, message: `Figma answered HTTP ${res.status} to the token check.`, checkedAt: this.now() };
        }
      } catch (e) {
        next = { state: "error", source, masked, message: `The token check could not reach api.figma.com (${e instanceof Error ? e.message : "network error"}).`, checkedAt: this.now() };
      }
      const ok = next.state === "valid";
      this.emit({
        type: "rest_event",
        at: this.now(),
        op: "me",
        method: "GET",
        status,
        ms: this.now() - started,
        ok,
        kind: "read",
        ...(ok ? {} : { message: next.state === "invalid" ? "Token expired / invalid" : failureText(status, null) }),
      });
      // A token change while this ran: its result is about a token nobody uses.
      if (gen === this.gen) this.setStatus({ ...next, ...this.expiryField() });
      return next;
    })();
    this.checking = run;
    void run.finally(() => {
      if (this.checking === run) this.checking = undefined;
    });
    return run;
  }

  /** Check an env-only token once, the first time anybody looks. */
  ensureChecked(): void {
    if (this.status.state === "unverified" && this.token()) void this.check();
  }

  private scheduleRecheck(): void {
    if (this.recheckTimer) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = undefined;
      void this.check();
    }, 250);
    this.recheckTimer.unref?.();
  }

  /**
   * THE fetch every REST caller uses. Injects the current token (whatever the
   * caller put in X-Figma-Token is replaced), reports the call, and updates
   * the token state from what Figma actually answered.
   */
  readonly fetch: RestFetch = async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const { op, fileKey } = describeRequest(url, method);
    const kind: "read" | "write" = method === "GET" ? "read" : "write";
    const started = this.now();
    const report = (status: number, ok: boolean, message?: string) =>
      this.emit({ type: "rest_event", at: this.now(), op, method, ...(fileKey ? { fileKey } : {}), status, ms: this.now() - started, ok, kind, ...(message ? { message } : {}) });

    // Priority: the plugin token (held by the leader) over FIGMA_TOKEN. A
    // follower holds no plugin token, so it asks the leader first and uses
    // its own env token only when the leader has none.
    const remote = this.pluginToken ? undefined : this.remote();
    if (remote) {
      const forwarded = await this.forwardToLeader(remote, url, init, method);
      if (forwarded) return forwarded;
    }
    const token = this.token();
    if (!token) {
      throw new OpError(
        ErrorCode.UNAUTHORIZED,
        "No Figma REST token is set.",
        "Paste a personal access token into the plugin panel (REST Token → Save), or set FIGMA_TOKEN in the MCP server's environment.",
      );
    }
    const headers = new Headers(init.headers ?? {});
    headers.set("X-Figma-Token", token);
    const gen = this.gen;
    let res: Response;
    try {
      res = await this.net(url, { ...init, headers });
    } catch (e) {
      report(0, false, "Network error");
      throw e;
    }
    if (res.ok) {
      report(res.status, true);
      // A real success proves the token works — clear a stale 429 / error.
      if (gen === this.gen && (this.status.state === "rate_limited" || this.status.state === "error" || this.status.state === "unverified")) {
        if (this.status.state === "unverified") this.scheduleRecheck();
        else this.setStatus({ ...this.status, state: "valid", httpStatus: res.status, message: undefined, checkedAt: this.now() });
      }
      return res;
    }
    const body = res.status === 401 || res.status === 403 ? await res.clone().text().catch(() => "") : "";
    const failure = res.status === 401 || res.status === 403 ? classifyRestFailure(res.status, body) : null;
    report(res.status, false, failureText(res.status, failure));
    if (gen === this.gen) {
      if (failure?.kind === "token") {
        this.setStatus({ state: "invalid", source: this.source(), masked: maskToken(token), httpStatus: res.status, message: `Figma rejected the token on a real request (${failure.detail}) — it has expired or been revoked.`, checkedAt: this.now(), ...this.expiryField() });
      } else if (failure?.kind === "scope") {
        // The token is fine; it cannot do THIS. Say which scope, keep the state.
        const missing = [...new Set([...(this.status.missingScopes ?? []), ...(failure.requiredScopes?.slice(0, 1) ?? [])])];
        this.setStatus({
          ...this.status,
          missingScopes: missing,
          ...(failure.grantedScopes ? { scopes: failure.grantedScopes } : {}),
          message: `The token lacks ${missing.join(", ")} — create a token with it to use that feature.`,
        });
      } else if (res.status === 403) {
        // No access to THIS file is not a bad token — ask /me which it is.
        this.scheduleRecheck();
      } else if (res.status === 429) {
        const type = res.headers.get("x-figma-rate-limit-type") ?? undefined;
        const tier = res.headers.get("x-figma-plan-tier") ?? undefined;
        const sec = Number(res.headers.get("retry-after"));
        const retryAt = Number.isFinite(sec) && sec > 0 ? this.now() + sec * 1000 : undefined;
        this.setStatus({
          ...this.status,
          state: "rate_limited",
          source: this.source(),
          masked: maskToken(token),
          httpStatus: 429,
          ...(retryAt ? { retryAt } : {}),
          ...(tier ? { planTier: tier } : {}),
          ...(type ? { rateLimitType: type } : {}),
          message: `Rate-limited${retryAt ? ` — retry in ${humanDuration(sec)}` : ""}${tier ? ` (plan ${tier}${type ? `, limit ${type}` : ""})` : ""}. Other endpoint tiers (comments, versions) may still work.`,
          checkedAt: this.now(),
        });
      }
    }
    return res;
  };

  private async forwardToLeader(
    remote: (req: ForwardedRequest) => Promise<ForwardedResponse>,
    url: string,
    init: RequestInit,
    method: string,
  ): Promise<Response | null> {
    const ct = new Headers(init.headers ?? {}).get("content-type");
    const fwd = await remote({
      url,
      method,
      ...(typeof init.body === "string" ? { body: init.body } : {}),
      ...(ct ? { contentType: ct } : {}),
    });
    if (fwd.noToken) return null;
    const headers = new Headers();
    if (fwd.retryAfter) headers.set("retry-after", fwd.retryAfter);
    if (fwd.planTier) headers.set("x-figma-plan-tier", fwd.planTier);
    if (fwd.rateLimitType) headers.set("x-figma-rate-limit-type", fwd.rateLimitType);
    if (fwd.upgradeLink) headers.set("x-figma-upgrade-link", fwd.upgradeLink);
    if (fwd.contentType) headers.set("content-type", fwd.contentType);
    const bytes = fwd.bodyBase64 ? Buffer.from(fwd.bodyBase64, "base64") : new Uint8Array();
    const status = fwd.status ?? 500;
    return new Response(status === 204 || status === 304 ? null : bytes, { status, headers });
  }

  /**
   * Leader side of `__rest_fetch__`: run a follower's request with this
   * process's token. Only api.figma.com, only the methods the tools use.
   */
  async serveForwarded(req: ForwardedRequest): Promise<ForwardedResponse> {
    const url = typeof req.url === "string" ? req.url : "";
    if (!url.startsWith(`${REST_API_BASE}/`)) {
      throw new OpError(ErrorCode.INVALID_PARAMS, "Only api.figma.com/v1 requests can be forwarded.", "This is a server bug if a follower sent it.");
    }
    const method = (req.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "DELETE"].includes(method)) {
      throw new OpError(ErrorCode.INVALID_PARAMS, `Method ${method} cannot be forwarded.`, "GET, POST or DELETE.");
    }
    if (!this.token()) return { noToken: true };
    const res = await this.fetch(url, {
      method,
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(req.contentType ? { headers: { "content-type": req.contentType } } : {}),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      retryAfter: res.headers.get("retry-after"),
      planTier: res.headers.get("x-figma-plan-tier"),
      rateLimitType: res.headers.get("x-figma-rate-limit-type"),
      upgradeLink: res.headers.get("x-figma-upgrade-link"),
      contentType: res.headers.get("content-type"),
      bodyBase64: buf.toString("base64"),
    };
  }
}

/** The one hub of this process. */
export const restHub = new RestHub();
