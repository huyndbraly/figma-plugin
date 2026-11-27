/**
 * Bridge: HTTP + WebSocket server the plugin connects to and followers
 * forward through.
 *
 *   WS   /ws      — Figma plugin UIs. A `hello` handshake is required before
 *                   any request is dispatched. Heartbeat ping/pong.
 *                   MULTI-CHANNEL: each connection is joined to a channel
 *                   (requested in hello, or assigned by the server and echoed
 *                   back with a `{type:"assigned"}` message). Multiple Figma
 *                   windows stay connected simultaneously, one per channel. A
 *                   resume hello (channel + token) on an EXISTING channel
 *                   replaces that channel's connection only when the old
 *                   socket no longer answers a ping (its in-flight requests
 *                   fail, its queued ones move over); a live incumbent keeps
 *                   its channel and the newcomer gets a fresh one.
 *   GET  /health  — diagnostics JSON (used by follower discovery + status).
 *   POST /rpc     — follower → leader forwarding, Bearer-token authed. The
 *                   forwarded op still goes through the same validate + queue
 *                   + bridge path as a leader-direct op.
 *
 * Routing: dispatch() resolves the target connection from opts.channel —
 *   explicit channel → that connection (CHANNEL_NOT_FOUND if absent);
 *   no channel + exactly one connection → it (zero-config single-window UX);
 *   no channel + none → held in an unrouted queue until a plugin connects
 *     (same wait-for-plugin behaviour the single-connection bridge had);
 *   no channel + several → file/page match, then session sticky, then
 *     focused window, then AMBIGUOUS_CHANNEL listing files not channel ids.
 *   An op whose window disconnected moments ago (route.ts RECONNECT_GRACE_MS)
 *     waits for it in the same queue, re-resolved on every hello.
 *
 * Correlation: every dispatched request gets an id; responses/progress are
 * matched via the owning connection's `pending` map. Each op has a per-op
 * timeout from OP_TIMEOUTS; a `progress` message resets that timer (long
 * batches / exports must never trip the timeout while the plugin is actively
 * working). Timers arm at DISPATCH (dequeue), never while queued.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID, randomInt } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { safeEqualString, newResumeToken } from "./security.js";
import {
  DEFAULT_OP_TIMEOUT_MS,
  HEARTBEAT_DEAD_MS,
  HEARTBEAT_INTERVAL_MS,
  OP_TIMEOUTS,
  WRITE_OPERATIONS,
  type BridgeRequest,
  type BridgeResponse,
  type Operation,
  type PluginHello,
  type SessionSummaryWire,
  type RestStatusWire,
  type RestStatusUpdate,
  type RestEventWire,
  type WireMessage,
} from "../shared/protocol.js";
import { ErrorCode, OpError, toBridgeError } from "./errors.js";
import {
  namesMatch,
  resolveRoute,
  RECONNECT_GRACE_MS,
  USER_ACTIVITY_FRESH_MS,
  type RouteArg,
  type RouteDecision,
} from "./route.js";

/**
 * Does this operation CHANGE the document? A timeout on a read is just a
 * missing answer; a timeout on a write leaves the caller not knowing whether
 * the work happened, which is a different problem and needs a different hint.
 */
const MUTATING = new Set<string>(WRITE_OPERATIONS as readonly string[]);
function mutates(op: string): boolean {
  return MUTATING.has(op);
}

/**
 * The hint for a write whose outcome is unknown — it reached the plugin and
 * then the answer was lost. Saying only "retry" is how a page ends up with
 * every diagram on it twice.
 */
function mayHaveCompletedHint(op: string): string {
  return `The Figma plugin was NOT cancelled — "${op}" may well have completed. Do NOT simply retry: check with figma_read op:"get_page_model" (or get_design_context) first, and if the frame is there, use \`update\` with its id rather than drawing a second one.`;
}

/**
 * The error for a request lost with its connection. Three different
 * situations, three different next steps: never sent (retry is safe), a read
 * on the wire (retry is safe), a write on the wire (check before retrying).
 */
function connectionLostError(op: string, sent: boolean, message: string, reconnectHint: string): OpError {
  if (!sent) {
    return new OpError(
      ErrorCode.NOT_CONNECTED,
      message,
      `Nothing was sent to Figma for "${op}" — it is safe to retry. ${reconnectHint}`,
    );
  }
  if (mutates(op)) {
    return new OpError(ErrorCode.NOT_CONNECTED, message, `${mayHaveCompletedHint(op)} ${reconnectHint}`);
  }
  return new OpError(ErrorCode.NOT_CONNECTED, message, `The answer was lost; a read is safe to retry. ${reconnectHint}`);
}

/** How long a resume hello waits for the incumbent socket to answer a ping. */
const DEFAULT_LIVENESS_PROBE_MS = 1500;
/** Disconnected channels remembered for routing (last file/page shown). */
const MAX_GONE = 64;

/** Cap on requests waiting for a plugin slot (per connection + unrouted). */
const MAX_QUEUE = 100;
/**
 * Cap on concurrent in-flight requests handed to ONE plugin connection.
 *
 * ARCHITECTURE root-cause #16 — per-connection write serialization: the Figma
 * Plugin API is single-threaded and races/times out when two mutations overlap
 * (`code.js` runs on one main thread; overlapping async handlers corrupt each
 * other's transient state). The simplest correct fix is to serialize ALL
 * dispatch through a single in-flight gate per plugin connection: at most one
 * op is on the wire at a time, the rest wait FIFO. Reads are cheap and rare
 * enough that serializing them too costs nothing and removes an entire class of
 * interleaving bugs. Different channels are different Figma windows (separate
 * main threads), so they run in parallel — the gate is per connection, not
 * global.
 */
const MAX_IN_FLIGHT = 1;

/**
 * WS upgrade Origin allowlist (CSWSH guard). Browsers always send an Origin
 * header on WebSocket upgrades, and every browser page — including a
 * malicious tab — may open a cross-origin socket to 127.0.0.1. The Figma
 * plugin iframe is a sandboxed opaque origin, so its upgrades carry
 * `Origin: null`; non-browser clients (the `ws` library, tests, drivers)
 * send none. Anything presenting a real http(s) origin is a web page posing
 * as the plugin — the upgrade is refused before a socket ever opens.
 */
const TRUSTED_WS_ORIGINS = new Set(["https://www.figma.com", "https://figma.com"]);

/** How long a socket may sit staged (connected but no `hello`) before it is
 * terminated. A connect-and-say-nothing client is pure resource cost — the
 * heartbeat monitor only watches established channels. */
const DEFAULT_HELLO_TIMEOUT_MS = 30_000;

/** Largest WS frame accepted on the plugin channel. Responses carry base64
 * screenshots/exports, so this sits well above those and far below the `ws`
 * default (100 MiB). */
const DEFAULT_MAX_PAYLOAD = 64 * 1024 * 1024;

/** Word lists for human-friendly generated channel names (adj-noun-NN). */
const CHANNEL_ADJECTIVES = [
  "brave", "calm", "eager", "fancy", "gentle", "happy", "jolly", "kind",
  "lively", "merry", "noble", "proud", "quick", "sunny", "swift", "witty",
];
const CHANNEL_NOUNS = [
  "otter", "falcon", "panda", "tiger", "whale", "fox", "lynx", "koala",
  "heron", "bison", "gecko", "dolphin", "badger", "crane", "maple", "cedar",
];

export interface PluginInfo {
  version: string;
  /** When the bundle Figma is running was built; absent on an older plugin. */
  build?: string;
  protocolVersion: number;
  fileKey: string | null;
  fileName: string;
  pageName: string;
  editorType: string;
  connectedAt: number;
}

/** One row of list_channels / figma_status.channels / health.channels. */
export interface ChannelSummary {
  channel: string;
  plugin: PluginInfo;
  queueLength: number;
  pendingCount: number;
  lastHeartbeatMs: number;
  /** ms since the user last touched this window; null = never. */
  lastUserActivityMs: number | null;
  /** True on the window with the most recent fresh user activity. */
  focused?: boolean;
}

interface Pending {
  id: string;
  op: Operation;
  resolve: (r: BridgeResponse) => void;
  reject: (e: OpError) => void;
  /**
   * The per-op timeout timer. Undefined while the request sits in the queue —
   * it is armed only when the op is actually dispatched to the plugin
   * (`drainQueue`), so a queued op never burns its timeout budget waiting for
   * the in-flight op ahead of it to settle. The clock starts at dispatch.
   */
  timer?: NodeJS.Timeout;
  timeoutMs: number;
  onProgress?: (p: NonNullable<BridgeResponse["progress"]>) => void;
}

interface QueueItem {
  request: BridgeRequest;
  pending: Pending;
}

/** An op waiting for its window (none connected, or the right one away). */
interface ParkedItem extends QueueItem {
  opts: DispatchOptions;
  /** When it stops waiting and gets a final answer (epoch ms). */
  deadlineAt: number;
  parkedAt: number;
}

export interface DispatchOptions {
  timeoutMs?: number;
  chunk?: BridgeRequest["chunk"];
  onProgress?: (p: NonNullable<BridgeResponse["progress"]>) => void;
  /**
   * Target channel (Figma window). Omit for the zero-config default: with one
   * window connected everything routes there. With several, pass `file`/`page`
   * (or `channel`); a session also stickies after the first successful route,
   * and a brand-new session follows the focused window when activity is fresh.
   */
  channel?: string;
  /** Figma file name (fuzzy). Preferred over channel when several windows are open. */
  file?: string;
  /** Page name (fuzzy). Pins to a window already on that page, or switches. */
  page?: string;
  /**
   * The calling agent session. Used for Figma-side pairing: when the user
   * picks this session in a plugin window's UI, ops from the session route to
   * that window without an explicit channel. Also the key for auto-sticky
   * after the first file/page/focus route.
   */
  sessionId?: string;
  /**
   * Aborted by the caller once it has stopped waiting (figma_write gave up on
   * its budget). An op still waiting in a queue is dropped and rejected; one
   * already on the wire cannot be recalled from the plugin and is left alone.
   * Without this, a queued op outlived the call that issued it and later ran
   * on whichever window happened to connect.
   */
  signal?: AbortSignal;
}

export interface BridgeHandlers {
  /**
   * Called for POST /rpc after Bearer auth passes. Returns the op result.
   * `signal` aborts when the follower stops waiting (its HTTP request
   * closed), so an op still queued is dropped instead of running for nobody.
   */
  onRpc?: (
    op: string,
    params: Record<string, unknown>,
    sessionId?: string,
    route?: RouteArg,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  /**
   * A plugin window saved (string) or cleared (null) the Figma REST token —
   * in its hello, or with set_rest_token. The bridge never stores or echoes
   * it; whoever handles this owns it (see rest-hub.ts).
   */
  onRestToken?: (token: string | null, channel: string, meta?: { expiresAt?: number | null }) => void;
}

export interface BridgeOptions {
  /** ms a socket may stay staged (connected, no `hello`) before termination. */
  helloTimeoutMs?: number;
  /** Max accepted WS frame size in bytes. */
  maxPayloadBytes?: number;
  /** ms a resume hello waits for the incumbent socket's pong. */
  livenessProbeMs?: number;
  /** ms an op waits for a window that disconnected (default RECONNECT_GRACE_MS). */
  reconnectGraceMs?: number;
}

/**
 * One established (hello-completed) plugin connection joined to a channel.
 * Owns its own queue, in-flight gate, pending map and heartbeat clock so
 * channels never serialize or fail each other.
 */
class PluginConnection {
  readonly pending = new Map<string, Pending>();
  readonly queue: QueueItem[] = [];
  inFlight = 0;
  lastHeartbeatAt = Date.now();
  /** User (not plugin) last touched this window. 0 = never. */
  lastUserActivityAt = 0;

  constructor(
    public readonly channel: string,
    public ws: WebSocket,
    public info: PluginInfo,
    /** Secret required to replace this connection on reconnect. */
    public readonly resumeToken: string,
  ) {}

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  get lastHeartbeatMs(): number {
    return Date.now() - this.lastHeartbeatAt;
  }

  enqueue(request: BridgeRequest, pending: Pending): void {
    if (this.queue.length >= MAX_QUEUE) {
      pending.reject(
        new OpError(
          ErrorCode.QUEUE_FULL,
          `Request queue for channel "${this.channel}" is full (${this.queue.length}/${MAX_QUEUE}) — plugin is busy (${this.inFlight} in flight).`,
          "Wait for in-flight operations to finish, or batch related ops into one figma_write.",
        ),
      );
      return;
    }
    this.pending.set(pending.id, pending);
    this.queue.push({ request, pending });
    this.drainQueue();
  }

  drainQueue(): void {
    if (!this.open) {
      return; // hold until the socket is replaced or closed (close fails all)
    }
    while (this.queue.length > 0 && this.inFlight < MAX_IN_FLIGHT) {
      const item = this.queue.shift();
      if (!item) break;
      if (!this.pending.has(item.pending.id)) {
        continue; // already timed out / cancelled while queued
      }
      this.inFlight++;
      // Arm the per-op timeout only now, as the op goes on the wire — the clock
      // starts at dispatch, not at enqueue. With MAX_IN_FLIGHT === 1 this is the
      // serialization gate: the next op is not sent until the current one
      // settles (settle() calls drainQueue()).
      item.pending.timer = this.armTimer(item.pending.id, item.pending.op, item.pending.timeoutMs);
      this.send({ type: "request", payload: item.request });
    }
  }

  onResponse(res: BridgeResponse): void {
    const pending = this.pending.get(res.id);
    if (!pending) {
      return; // late response for an already-settled request
    }

    // A progress message is any message carrying `progress` but NO final result
    // and no error. It resets the timer but must NOT settle the request. The
    // plugin sends progress with `ok:true` (dispatch always stamps ok:true), so
    // we must NOT gate on `res.ok !== true` here — doing so made a batch's final
    // progress ping settle the request in place of the real result message,
    // leaving res.result undefined and every batch item reported as "no result".
    if (res.progress && res.error === undefined && !hasResult(res)) {
      pending.onProgress?.(res.progress);
      this.resetTimer(pending);
      return;
    }
    if (res.progress) {
      pending.onProgress?.(res.progress);
    }

    // Settle, let the owner react, THEN send the next op. A page switch
    // queued ahead of its op cancels that op from its resolve/reject — it
    // must run before drainQueue() puts the op on the wire.
    this.settle(res.id);
    pending.resolve(res);
    this.drainQueue();
  }

  private armTimer(id: string, op: Operation, timeoutMs: number): NodeJS.Timeout {
    const t = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.settle(id);
      queueMicrotask(() => this.drainQueue()); // after the reject below
      pending.reject(
        new OpError(
          ErrorCode.PLUGIN_TIMEOUT,
          `Operation "${op}" timed out after ${timeoutMs}ms.`,
          mutates(op)
            ? // The plugin is not cancelled by this timeout — it keeps going and
              // usually finishes. Saying only "timed out" invites a retry, and a
              // retry of a draw that actually landed is how a page ends up with
              // every diagram on it twice. Ask before repeating the work.
              `The Figma plugin did not answer in time, but it was NOT cancelled — "${op}" may well have completed. Do NOT simply retry: check with figma_read op:"get_page_model" (or get_design_context) first, and if the frame is there, use \`update\` with its id rather than drawing a second one. figma_status shows whether the window is throttled (lastHeartbeatMs well over ~2s means it is in the background).`
            : "The Figma plugin did not respond in time — check figma_status; the window may be minimized or the op may be very large.",
        ),
      );
    }, timeoutMs);
    // Do not keep the process alive purely for a pending timer.
    t.unref?.();
    return t;
  }

  private resetTimer(pending: Pending): void {
    clearTimeout(pending.timer);
    pending.timer = this.armTimer(pending.id, pending.op, pending.timeoutMs);
  }

  /** Forget a finished request and free its in-flight slot. The caller
   * drains the queue once the request's owner has been told. */
  private settle(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (this.inFlight > 0) this.inFlight--;
  }

  /**
   * Remove and return the requests already on the wire (sent, unanswered).
   * Queued requests stay put, so a rejected page switch can still cancel the
   * op queued behind it before the queue is handed on.
   */
  takeInFlight(): Pending[] {
    const queued = new Set(this.queue.map((item) => item.pending.id));
    const out: Pending[] = [];
    for (const [id, p] of this.pending) {
      if (queued.has(id)) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      out.push(p);
    }
    this.inFlight = 0;
    return out;
  }

  /** Remove and return every request still waiting (never sent), in order. */
  takeQueued(): QueueItem[] {
    const out = this.queue.splice(0).filter((item) => this.pending.has(item.pending.id));
    this.pending.clear();
    return out;
  }

  /**
   * Drop a request that is still waiting in this connection's queue. Returns
   * false when it is not queued here — already on the wire or settled — so
   * the caller knows it was not cancelled.
   */
  cancelQueued(id: string): boolean {
    const at = this.queue.findIndex((item) => item.pending.id === id);
    if (at < 0 || !this.pending.has(id)) return false;
    this.queue.splice(at, 1);
    this.pending.delete(id);
    return true;
  }

  failAllPending(err: OpError): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    this.queue.length = 0;
    this.inFlight = 0;
    for (const p of all) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  send(msg: WireMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  summary(): ChannelSummary {
    return {
      channel: this.channel,
      plugin: this.info,
      queueLength: this.queue.length,
      pendingCount: this.pending.size,
      lastHeartbeatMs: this.lastHeartbeatMs,
      lastUserActivityMs: this.lastUserActivityAt > 0 ? Date.now() - this.lastUserActivityAt : null,
    };
  }
}

export class Bridge {
  private http?: HttpServer;
  private wss?: WebSocketServer;
  /** Established connections by channel. One Figma window per channel. */
  private readonly channels = new Map<string, PluginConnection>();
  /** Reverse lookup for socket events. */
  private readonly bySocket = new Map<WebSocket, PluginConnection>();
  /** Sockets that have NOT yet completed their hello handshake, mapped to
   * their hello deadline timer. Kept apart from `channels` so a socket that
   * dies before handshaking never disturbs established connections and their
   * in-flight requests. */
  private readonly stagedSockets = new Map<WebSocket, NodeJS.Timeout>();
  /**
   * Ops waiting for their window: none is connected yet ("start the agent
   * first, open Figma second"), or the one they belong to disconnected
   * moments ago and is most likely reconnecting. Each is resolved again
   * through the router on every hello — never drained wholesale onto
   * whichever window happens to say hello first — and gets a final answer
   * at its deadline. The per-op timer is not armed while parked; the clock
   * starts at dispatch.
   */
  private readonly unrouted: ParkedItem[] = [];
  /**
   * Channels that disconnected, with what they last showed. Routing waits
   * for one that left within the reconnect grace, and names the file a
   * session was on when its window does not come back.
   */
  private readonly gone = new Map<string, { info: PluginInfo; goneAt: number }>();
  /** Resume hellos waiting on the incumbent socket's liveness probe. */
  private readonly probing = new Set<WebSocket>();
  /**
   * Figma-side pairing: sessionId → channel. `user` is a Connect click in the
   * plugin UI; `auto` is a successful file/page/focus route. `notified` flips
   * after the first op has carried a warning back to the agent.
   */
  private readonly sessionBindings = new Map<
    string,
    { channel: string; notified: boolean; source: "user" | "auto" }
  >();
  /** Supplied by index.ts so channel pushes can list agent sessions. */
  private sessionsProvider?: () => SessionSummaryWire[];
  private restStatusProvider?: () => RestStatusWire;

  private boundPort = 0;
  private authToken = "";
  private heartbeatTimer?: NodeJS.Timeout;

  private readonly helloTimeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly livenessProbeMs: number;
  private readonly reconnectGraceMs: number;

  constructor(private readonly handlers: BridgeHandlers = {}, opts: BridgeOptions = {}) {
    this.helloTimeoutMs = opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.maxPayloadBytes = opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD;
    this.livenessProbeMs = opts.livenessProbeMs ?? DEFAULT_LIVENESS_PROBE_MS;
    this.reconnectGraceMs = opts.reconnectGraceMs ?? RECONNECT_GRACE_MS;
  }

  /** What a window joining now is told about the REST token (rest_status). */
  setRestStatusProvider(fn: () => RestStatusWire): void {
    this.restStatusProvider = fn;
  }

  /**
   * Push a server→plugin message to every established window (REST token
   * status, REST activity). Never used for requests — those are routed.
   */
  broadcast(msg: RestStatusUpdate | RestEventWire): void {
    for (const conn of this.channels.values()) conn.send(msg);
  }

  setSessionsProvider(fn: () => SessionSummaryWire[]): void {
    this.sessionsProvider = fn;
  }

  /** The channel a session is bound to (plugin UI or auto-sticky), if any. */
  sessionBinding(sessionId: string): string | undefined {
    return this.sessionBindings.get(sessionId)?.channel;
  }

  sessionBindingSource(sessionId: string): "user" | "auto" | undefined {
    return this.sessionBindings.get(sessionId)?.source;
  }

  get port(): number {
    return this.boundPort;
  }

  get pluginConnected(): boolean {
    for (const conn of this.channels.values()) {
      if (conn.open) return true;
    }
    return false;
  }

  /** Info of the single connected plugin, when exactly one is connected.
   * With several windows use channels() — there is no single "the plugin". */
  get plugin(): PluginInfo | undefined {
    if (this.channels.size !== 1) return undefined;
    const first = this.channels.values().next().value as PluginConnection | undefined;
    return first?.info;
  }

  get lastHeartbeatMs(): number {
    // Most recent heartbeat across connections; -1 when none ever connected.
    let best = -1;
    for (const conn of this.channels.values()) {
      const ms = conn.lastHeartbeatMs;
      if (best === -1 || ms < best) best = ms;
    }
    return best;
  }

  get queueLength(): number {
    let n = this.unrouted.length;
    for (const conn of this.channels.values()) n += conn.queue.length;
    return n;
  }

  get pendingCount(): number {
    let n = this.unrouted.length;
    for (const conn of this.channels.values()) n += conn.pending.size;
    return n;
  }

  get channelCount(): number {
    return this.channels.size;
  }

  /** list_channels / figma_status / health: one row per connected window. */
  channelSummaries(): ChannelSummary[] {
    const rows = [...this.channels.values()].map((c) => c.summary());
    let focused: ChannelSummary | undefined;
    for (const r of rows) {
      if (r.lastUserActivityMs == null) continue;
      if (r.lastUserActivityMs > USER_ACTIVITY_FRESH_MS) continue;
      if (!focused || r.lastUserActivityMs < focused.lastUserActivityMs!) focused = r;
    }
    if (focused) focused.focused = true;
    return rows;
  }

  /**
   * Bind exactly ONE port (`startPort`) and become the bridge for it. On
   * EADDRINUSE this rejects with the raw error so the CALLER (the Coordinator)
   * decides whether the occupant is a Figma Plugin MCP leader to follow or a foreign
   * process to skip. Binding the whole fallback range here was the root cause
   * of the "every window becomes its own leader" bug — the range walk masked
   * EADDRINUSE so leader election never saw it. Port selection now lives in the
   * Coordinator, which interleaves bind-attempts with /health follow-checks.
   */
  async listen(startPort: number, authToken: string): Promise<number> {
    this.authToken = authToken;
    await this.tryListen(startPort);
    // Port 0 asks the OS for a free one (tests do); report the real port.
    const addr = this.http?.address();
    const bound = addr && typeof addr === "object" ? addr.port : startPort;
    this.boundPort = bound;
    this.startHeartbeatMonitor();
    return bound;
  }

  private tryListen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const http = createServer((req, res) => this.handleHttp(req, res));
      const wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayloadBytes });

      http.on("upgrade", (req, socket, head) => {
        let pathname: string;
        try {
          pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        } catch {
          // Malformed request-target (e.g. absolute-form with an invalid
          // port) — llhttp accepts it, URL does not. Never let it throw.
          socket.destroy();
          return;
        }
        if (pathname !== "/ws") {
          socket.destroy();
          return;
        }
        // CSWSH guard — see TRUSTED_WS_ORIGINS. A browser page may open a
        // cross-origin WebSocket to this loopback port; only the Figma
        // plugin's opaque origin ("null"), figma.com itself, and non-browser
        // clients (no Origin header) are allowed through.
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== "null" && !TRUSTED_WS_ORIGINS.has(origin)) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (client) => this.onWsConnection(client));
      });

      const onError = (err: unknown) => {
        http.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        http.removeListener("error", onError);
        this.http = http;
        this.wss = wss;
        resolve();
      };
      http.once("error", onError);
      http.once("listening", onListening);
      http.listen(port, "127.0.0.1");
    });
  }

  // ---- WebSocket (plugin) ----

  private onWsConnection(client: WebSocket): void {
    // Stage the socket until it completes its hello handshake. Several sockets
    // may be staged at once (several Figma windows opening the plugin
    // together) — none of them disturbs an established connection until its
    // hello resolves a channel.
    this.stagedSockets.set(client, this.armHelloDeadline(client));

    client.on("message", (data) => this.onWsMessage(client, data));
    client.on("close", () => this.onWsClose(client));
    client.on("error", () => {
      /* close handler does the cleanup */
    });
  }

  /** A staged socket gets one deadline: `hello` within helloTimeoutMs or the
   * socket is terminated. Without it a connect-and-say-nothing client holds
   * the slot forever — nothing else reaps staged sockets. */
  private armHelloDeadline(client: WebSocket): NodeJS.Timeout {
    const t = setTimeout(() => {
      if (!this.stagedSockets.delete(client)) return;
      try {
        client.terminate();
      } catch {
        /* close handler cleans up */
      }
    }, this.helloTimeoutMs);
    t.unref?.();
    return t;
  }

  private onWsMessage(client: WebSocket, data: RawData): void {
    let msg: WireMessage;
    try {
      msg = JSON.parse(data.toString()) as WireMessage;
    } catch {
      return; // ignore malformed frames
    }
    // JSON.parse can yield null / primitives — a bare `null` or `"5"` frame
    // must not reach `msg.type` and crash the listener.
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      return;
    }

    const conn = this.bySocket.get(client);

    switch (msg.type) {
      case "hello": {
        this.acceptHello(client, msg);
        break;
      }
      case "ping": {
        if (!conn) break; // only established sockets heartbeat
        conn.lastHeartbeatAt = Date.now();
        conn.send({ type: "pong", at: Date.now() });
        break;
      }
      case "pong": {
        if (!conn) break;
        conn.lastHeartbeatAt = Date.now();
        break;
      }
      case "response": {
        if (!conn) break; // ignore responses from a stale/staged socket
        const payload = msg.payload;
        if (!payload || typeof payload !== "object" || typeof payload.id !== "string") break;
        conn.onResponse(payload);
        break;
      }
      case "bind": {
        // The user picked an agent session in this window's plugin UI: bind
        // the session to this channel. The session's next op carries a
        // warning so the agent learns about the pairing immediately.
        if (!conn) break;
        if (typeof msg.sessionId !== "string" || msg.sessionId.length === 0 || msg.sessionId.length > 128) break;
        // Unbounded growth guard: any client can mint session ids — cap the
        // map and evict the oldest binding first (Map iterates in insertion
        // order).
        if (this.sessionBindings.size >= 512 && !this.sessionBindings.has(msg.sessionId)) {
          const oldest = this.sessionBindings.keys().next().value;
          if (oldest !== undefined) this.sessionBindings.delete(oldest);
        }
        this.sessionBindings.set(msg.sessionId, { channel: conn.channel, notified: false, source: "user" });
        this.broadcastChannels();
        break;
      }
      case "set_rest_token": {
        // Only an established window may set it: a socket that never said
        // hello is nobody the user can see in a Figma panel.
        if (!conn) break;
        const token = (msg as { token?: unknown }).token;
        if (token !== null && (typeof token !== "string" || token.length > 512)) break;
        const exp = (msg as { expiresAt?: unknown }).expiresAt;
        this.handlers.onRestToken?.(token, conn.channel, { expiresAt: typeof exp === "number" ? exp : null });
        break;
      }
      case "context": {
        if (!conn) break;
        if (typeof msg.fileName === "string" && msg.fileName.length > 0) {
          conn.info = { ...conn.info, fileName: msg.fileName };
        }
        if (typeof msg.pageName === "string" && msg.pageName.length > 0) {
          conn.info = { ...conn.info, pageName: msg.pageName };
        }
        conn.lastUserActivityAt = typeof msg.at === "number" && msg.at > 0 ? msg.at : Date.now();
        conn.lastHeartbeatAt = Date.now();
        break;
      }
      default:
        break; // "request"/"assigned"/"channels" are server→plugin only
    }
  }

  /** Push the current windows+sessions snapshot to every established plugin. */
  private broadcastChannels(): void {
    const channels = [...this.channels.values()].map((c) => ({
      channel: c.channel,
      fileName: c.info.fileName,
      pageName: c.info.pageName,
    }));
    const sessions = (this.sessionsProvider?.() ?? []).map((s) => ({
      ...s,
      boundChannel: this.sessionBindings.get(s.id)?.channel ?? null,
    }));
    for (const conn of this.channels.values()) {
      conn.send({ type: "channels", self: conn.channel, channels, sessions });
    }
  }

  private acceptHello(client: WebSocket, hello: PluginHello): void {
    const established = this.bySocket.get(client);
    if (established) {
      // Re-hello from an established socket: the plugin refreshes its file /
      // page info (ui.html re-sends hello on page change). Update info in
      // place; the channel of a live connection never changes (changing
      // channel is a reconnect in the UI).
      const prevPage = established.info.pageName;
      established.info = {
        ...established.info,
        version: hello.pluginVersion,
        ...(hello.pluginBuild ? { build: hello.pluginBuild } : {}),
        protocolVersion: hello.protocolVersion,
        fileKey: hello.fileKey,
        fileName: hello.fileName,
        pageName: hello.pageName,
        editorType: hello.editorType,
      };
      established.lastHeartbeatAt = Date.now();
      // A re-hello with a new page name is the user working in this window.
      if (hello.pageName && hello.pageName !== prevPage) {
        established.lastUserActivityAt = Date.now();
      }
      this.takeHelloToken(hello, established.channel);
      this.broadcastChannels();
      return;
    }

    const staged = this.stagedSockets.get(client);
    if (!staged) {
      return; // a hello from a socket we already discarded
    }
    clearTimeout(staged);
    this.stagedSockets.delete(client);

    const requested = sanitizeChannel(hello.channel);
    const offeredResume =
      typeof hello.resumeToken === "string" && hello.resumeToken.length > 0
        ? hello.resumeToken
        : "";

    // Reclaiming an existing channel requires the resume token issued on
    // first assign. A hello that only knows the channel *name* (e.g. from
    // unauthenticated GET /health) gets a fresh channel instead of stealing.
    const previous = requested ? this.channels.get(requested) : undefined;
    if (!previous) {
      this.establish(client, hello, requested || this.generateChannel(), newResumeToken());
      return;
    }
    if (!offeredResume || !safeEqualString(offeredResume, previous.resumeToken)) {
      this.establish(client, hello, this.generateChannel(), newResumeToken());
      return;
    }
    if (!previous.open) {
      this.establish(client, hello, requested, previous.resumeToken, previous);
      return;
    }
    // The token proves this hello comes from a window that once held the
    // channel — but the plugin keys its stored channel by file NAME, so a
    // second window of the same file (or a second "Untitled") offers the
    // same channel and token. Taking over a socket that still answers
    // would steal a live window's channel. Ask the incumbent first: a live
    // socket answers a ping at once (the browser does it, however
    // throttled the page); a dead one (window closed without a FIN, laptop
    // asleep) does not, and only then is this a reconnect.
    this.probing.add(client);
    void this.probeAlive(previous.ws).then((alive) => {
      if (!this.probing.delete(client) || client.readyState !== WebSocket.OPEN) return;
      const current = this.channels.get(requested);
      if (current === previous && !alive) {
        this.establish(client, hello, requested, previous.resumeToken, previous);
      } else if (!current) {
        // The incumbent closed while we asked; the channel is free again.
        this.establish(client, hello, requested, previous.resumeToken);
      } else {
        this.establish(client, hello, this.generateChannel(), newResumeToken());
      }
    });
  }

  /** A hello carrying a saved REST token hands it over (never a clear — see PluginHello.restToken). */
  private takeHelloToken(hello: PluginHello, channel: string): void {
    const t = hello.restToken;
    const exp = hello.restTokenExpiresAt;
    if (typeof t === "string" && t.length > 0 && t.length <= 512) this.handlers.onRestToken?.(t, channel, { expiresAt: typeof exp === "number" ? exp : null });
  }

  /** Resolve true when `ws` answers a protocol ping within the probe window. */
  private probeAlive(ws: WebSocket): Promise<boolean> {
    return new Promise((resolve) => {
      if (ws.readyState !== WebSocket.OPEN) {
        resolve(false);
        return;
      }
      const done = (alive: boolean) => {
        clearTimeout(timer);
        ws.off("pong", onPong);
        ws.off("close", onClose);
        resolve(alive);
      };
      const onPong = () => done(true);
      const onClose = () => done(false);
      const timer = setTimeout(() => done(false), this.livenessProbeMs);
      timer.unref?.();
      ws.on("pong", onPong);
      ws.on("close", onClose);
      try {
        ws.ping();
      } catch {
        done(false);
      }
    });
  }

  /**
   * Join `client` to `channel`. With `previous`, this is a reconnect of the
   * same window onto its own channel: requests already on the wire die with
   * the old socket, but requests that never left the queue move over and
   * run on the new connection — they were never sent, so nothing is lost
   * or doubled.
   */
  private establish(
    client: WebSocket,
    hello: PluginHello,
    channel: string,
    resumeToken: string,
    previous?: PluginConnection,
  ): void {
    let carried: QueueItem[] = [];
    if (previous) {
      const message = `Plugin connection on channel "${channel}" was replaced by a new connection from that window.`;
      for (const p of previous.takeInFlight()) {
        p.reject(connectionLostError(p.op, true, message, "The new connection is active."));
      }
      carried = previous.takeQueued();
      this.bySocket.delete(previous.ws);
      if (previous.ws !== client) {
        try {
          previous.ws.close(1000, "replaced");
        } catch {
          /* ignore */
        }
      }
    }

    const info: PluginInfo = {
      version: hello.pluginVersion,
      ...(hello.pluginBuild ? { build: hello.pluginBuild } : {}),
      protocolVersion: hello.protocolVersion,
      fileKey: hello.fileKey,
      fileName: hello.fileName,
      pageName: hello.pageName,
      editorType: hello.editorType,
      connectedAt: Date.now(),
    };

    const conn = new PluginConnection(channel, client, info, resumeToken);
    this.channels.set(channel, conn);
    this.bySocket.set(client, conn);
    this.gone.delete(channel);

    // Tell the plugin which channel it is joined to (it shows this to the
    // user so they can point specific agents at specific windows). When it
    // differs from the one the plugin asked for, the UI says so.
    conn.send({ type: "assigned", channel, resumeToken });
    this.takeHelloToken(hello, channel);
    if (this.restStatusProvider) conn.send({ type: "rest_status", status: this.restStatusProvider() });

    for (const item of carried) conn.enqueue(item.request, item.pending);

    // Ops waiting for a window: each goes through the router again, so an op
    // for another file keeps waiting for ITS window instead of landing here.
    this.rerouteParked();

    conn.drainQueue();
    this.broadcastChannels();
  }

  private onWsClose(client: WebSocket): void {
    const staged = this.stagedSockets.get(client);
    if (staged) {
      clearTimeout(staged);
      this.stagedSockets.delete(client);
      return; // a never-handshaked socket died; nothing else to do
    }
    if (this.probing.delete(client)) return; // gave up while its resume was probed
    const conn = this.bySocket.get(client);
    if (!conn) {
      return; // an old, already-replaced socket closing
    }
    this.bySocket.delete(client);
    this.channels.delete(conn.channel);
    this.rememberGone(conn);
    const message = `Figma plugin on channel "${conn.channel}" (${conn.info.fileName || "untitled"}) disconnected.`;
    const reconnect =
      "If the window does not reconnect by itself within seconds, open the Figma Plugin MCP plugin in that file (Plugins → Figma Plugin MCP).";
    // In-flight first: a page switch rejected here cancels the op queued
    // behind it while that op is still in this queue.
    for (const p of conn.takeInFlight()) p.reject(connectionLostError(p.op, true, message, reconnect));
    for (const item of conn.takeQueued()) {
      item.pending.reject(connectionLostError(item.pending.op, false, message, reconnect));
    }
    // Session bindings to this channel are kept: the window usually reconnects
    // on the same channel (the plugin UI persists it), and routing waits for
    // it through the reconnect grace (see `gone`).
    this.broadcastChannels();
  }

  private rememberGone(conn: PluginConnection): void {
    this.gone.delete(conn.channel);
    this.gone.set(conn.channel, { info: conn.info, goneAt: Date.now() });
    while (this.gone.size > MAX_GONE) {
      const oldest = this.gone.keys().next().value;
      if (oldest === undefined) break;
      this.gone.delete(oldest);
    }
  }

  // ---- dispatch / routing ----

  /**
   * Send one validated op to the plugin on the resolved channel and await its
   * response. Callers must have run it through validateOperation() first.
   * `batch` streaming is done by executor.ts issuing one dispatch per chunk.
   */
  dispatch(op: Operation, params: Record<string, unknown>, opts: DispatchOptions = {}): Promise<BridgeResponse> {
    return new Promise<BridgeResponse>((resolve, reject) => {
      const id = randomUUID();
      const timeoutMs = opts.timeoutMs ?? OP_TIMEOUTS[op] ?? DEFAULT_OP_TIMEOUT_MS;
      // The timeout timer is NOT armed here: a queued op must not spend its
      // budget while waiting behind an in-flight op. The connection arms it at
      // the moment the op is put on the wire (drainQueue).
      const pending: Pending = {
        id,
        op,
        resolve,
        reject,
        timeoutMs,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      };
      const request: BridgeRequest = { id, op, params, ...(opts.chunk ? { chunk: opts.chunk } : {}) };

      const signal = opts.signal;
      const onAbort = () => {
        // Look everywhere it could be waiting: an unrouted op may have been
        // handed to a connection that has not put it on the wire yet.
        const cancelled =
          this.removeUnrouted(id) || [...this.channels.values()].some((c) => c.cancelQueued(id));
        if (!cancelled) return;
        clearTimeout(pending.timer);
        reject(
          new OpError(
            ErrorCode.PLUGIN_TIMEOUT,
            `Operation "${op}" was cancelled before it reached Figma — the call that issued it stopped waiting.`,
            "Nothing was sent to the plugin for this operation. Retry the call once a Figma window is connected and responsive.",
          ),
        );
      };
      if (signal) {
        if (signal.aborted) {
          reject(
            new OpError(
              ErrorCode.PLUGIN_TIMEOUT,
              `Operation "${op}" was cancelled before it was dispatched.`,
              "Nothing was sent to the plugin for this operation.",
            ),
          );
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        const release = () => signal.removeEventListener("abort", onAbort);
        const res0 = pending.resolve;
        const rej0 = pending.reject;
        pending.resolve = (r) => {
          release();
          res0(r);
        };
        pending.reject = (e) => {
          release();
          rej0(e);
        };
      }

      // From here on every refusal goes through pending.reject, which also
      // detaches the abort listener; the raw reject left it on the signal.
      this.routeAndEnqueue(request, pending, opts);
    });
  }

  /**
   * Resolve the target window (file/page/channel/session/focus) and put the
   * op on that connection's queue — or park it until its window is there.
   * Page switches run as a set_current_page queued directly ahead of the op
   * on the same channel, so they work with the plugin that is already open —
   * no extra protocol field.
   */
  private routeAndEnqueue(request: BridgeRequest, pending: Pending, opts: DispatchOptions): void {
    try {
      const decision = this.decide(opts, false);
      if (decision.ok) {
        this.enqueueRouted(decision, request, pending, opts);
        return;
      }
      // No window yet, or the one this op belongs to is reconnecting: wait.
      // Hinted ops used to fail in 0ms here while unhinted ones waited, so a
      // call naming its file died in exactly the gap a reload opens.
      if (this.channels.size === 0 || decision.waitUntil !== undefined) {
        this.park(request, pending, opts, decision.waitUntil);
        return;
      }
      pending.reject(new OpError(decision.code, decision.message, decision.hint));
    } catch (err) {
      pending.reject(err instanceof OpError ? err : new OpError(ErrorCode.INTERNAL, String(err)));
    }
  }

  /** Run the router over the connected (and recently disconnected) windows. */
  private decide(opts: DispatchOptions, final: boolean): RouteDecision {
    const windows = [...this.channels.values()].map((c) => ({
      channel: c.channel,
      fileName: c.info.fileName,
      pageName: c.info.pageName,
      lastUserActivityAt: c.lastUserActivityAt,
      queueLength: c.queue.length + c.inFlight,
    }));
    const bound = opts.sessionId ? this.sessionBindings.get(opts.sessionId) : undefined;
    const boundLast = bound ? this.gone.get(bound.channel)?.info : undefined;
    return resolveRoute({
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.file ? { file: opts.file } : {}),
      ...(opts.page ? { page: opts.page } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(bound ? { sessionBoundChannel: bound.channel, sessionBoundSource: bound.source } : {}),
      ...(boundLast ? { sessionBoundLast: { fileName: boundLast.fileName, pageName: boundLast.pageName } } : {}),
      windows,
      // At an op's deadline the wait is over: answer from what is connected.
      gone: final
        ? []
        : [...this.gone].map(([channel, g]) => ({
            channel,
            fileName: g.info.fileName,
            pageName: g.info.pageName,
            goneAt: g.goneAt,
          })),
      graceMs: this.reconnectGraceMs,
    });
  }

  private park(request: BridgeRequest, pending: Pending, opts: DispatchOptions, waitUntil?: number): void {
    if (this.unrouted.length >= MAX_QUEUE) {
      pending.reject(
        new OpError(
          ErrorCode.QUEUE_FULL,
          this.channels.size === 0
            ? `Request queue is full (${this.unrouted.length}/${MAX_QUEUE}) — no plugin is connected to drain the queue.`
            : `Request queue is full (${this.unrouted.length}/${MAX_QUEUE}) — ops are waiting for a Figma window to reconnect.`,
          "Open the Figma Plugin MCP plugin so queued operations can run.",
        ),
      );
      return;
    }
    const now = Date.now();
    const hinted = Boolean(opts.channel?.trim() || opts.file?.trim() || opts.page?.trim());
    // An unhinted op waits its whole budget for the first window (start the
    // agent first, open Figma second). One that names its target waits the
    // reconnect grace: long enough for a reload, short enough that a wrong
    // file name is not a 30s stall.
    let deadlineAt = now + (hinted ? Math.min(pending.timeoutMs, this.reconnectGraceMs) : pending.timeoutMs);
    if (waitUntil !== undefined) deadlineAt = Math.min(now + pending.timeoutMs, waitUntil);
    const item: ParkedItem = { request, pending, opts, deadlineAt: Math.max(deadlineAt, now + 1), parkedAt: now };
    this.unrouted.push(item);
    this.armParkTimer(item);
  }

  private armParkTimer(item: ParkedItem): void {
    clearTimeout(item.pending.timer);
    item.pending.timer = setTimeout(() => this.expireParked(item), Math.max(0, item.deadlineAt - Date.now()));
    item.pending.timer.unref?.();
  }

  /** The wait is over: route with what is connected now, or fail. */
  private expireParked(item: ParkedItem): void {
    if (!this.removeUnrouted(item.request.id)) return;
    item.pending.timer = undefined;
    const { pending } = item;
    if (this.channels.size === 0) {
      pending.reject(
        new OpError(
          ErrorCode.PLUGIN_TIMEOUT,
          `Operation "${pending.op}" waited ${Date.now() - item.parkedAt}ms for a Figma window and none connected.`,
          "Nothing was sent to Figma. Open the Figma Plugin MCP plugin in the file you want, then retry.",
        ),
      );
      return;
    }
    try {
      const decision = this.decide(item.opts, true);
      if (decision.ok) this.enqueueRouted(decision, item.request, pending, item.opts);
      else pending.reject(new OpError(decision.code, decision.message, decision.hint));
    } catch (err) {
      pending.reject(err instanceof OpError ? err : new OpError(ErrorCode.INTERNAL, String(err)));
    }
  }

  /** A window said hello: give every waiting op another routing attempt. */
  private rerouteParked(): void {
    for (const item of [...this.unrouted]) {
      if (!this.unrouted.includes(item)) continue;
      let decision: RouteDecision;
      try {
        decision = this.decide(item.opts, false);
      } catch {
        continue; // its deadline gives the answer
      }
      if (decision.ok) {
        this.removeUnrouted(item.request.id);
        clearTimeout(item.pending.timer);
        item.pending.timer = undefined;
        this.enqueueRouted(decision, item.request, item.pending, item.opts);
        continue;
      }
      // Still not routable. Keep waiting until the deadline — another window
      // may be on its way — but no longer than its own window's grace.
      if (decision.waitUntil !== undefined && decision.waitUntil < item.deadlineAt) {
        item.deadlineAt = decision.waitUntil;
        this.armParkTimer(item);
      }
    }
  }

  /** Bind/notify per the decision and queue the op on its window. */
  private enqueueRouted(
    decision: Extract<RouteDecision, { ok: true }>,
    request: BridgeRequest,
    pending: Pending,
    opts: DispatchOptions,
  ): void {
    const op = request.op;
    const explicit = Boolean(opts.channel?.trim() || opts.file?.trim() || opts.page?.trim());
    const conn = this.channels.get(decision.channel);
    if (!conn) {
      pending.reject(
        new OpError(
          ErrorCode.CHANNEL_NOT_FOUND,
          `No Figma window is connected on channel "${decision.channel}".`,
          `Connected: ${this.describeChannels()}.`,
        ),
      );
      return;
    }

    if (opts.sessionId) {
      const prev = this.sessionBindings.get(opts.sessionId);
      if (decision.sticky === "auto") {
        if (!prev || prev.source !== "user" || explicit) {
          this.sessionBindings.set(opts.sessionId, {
            channel: conn.channel,
            notified: prev?.notified ?? false,
            source: prev?.source === "user" && !explicit ? "user" : "auto",
          });
        }
      } else if (decision.reason === "session" && prev && prev.channel !== conn.channel) {
        // The bound window came back under a new channel: follow it, keep
        // who made the binding, and tell the agent once.
        this.sessionBindings.set(opts.sessionId, { channel: conn.channel, notified: false, source: prev.source });
      }
    }

    const binding = opts.sessionId ? this.sessionBindings.get(opts.sessionId) : undefined;
    const notice = decision.notice;
    if (notice && binding && !binding.notified) {
      const inner = pending.resolve;
      pending.resolve = (res) => {
        if (binding.notified) return inner(res);
        binding.notified = true;
        inner({ ...res, warnings: [...(res.warnings ?? []), notice] });
      };
    }

    if (decision.ensurePage && op !== "set_current_page" && !namesMatch(conn.info.pageName, decision.ensurePage)) {
      this.enqueueAfterPageSwitch(conn, decision.ensurePage, request, pending);
      return;
    }
    conn.enqueue(request, pending);
  }

  /**
   * Queue set_current_page and the op back to back, without yielding in
   * between. Awaiting the switch before queueing the op let another
   * session's switch to a different page slip in between, and this op ran
   * on THAT page. The op is cancelled — before it is sent — if the switch
   * fails.
   */
  private enqueueAfterPageSwitch(
    conn: PluginConnection,
    page: string,
    request: BridgeRequest,
    pending: Pending,
  ): void {
    const op = request.op;
    let failed: OpError | undefined;
    const failOp = (err: OpError) => {
      failed = err;
      const cancelled =
        conn.cancelQueued(pending.id) ||
        this.removeUnrouted(pending.id) ||
        [...this.channels.values()].some((c) => c.cancelQueued(pending.id));
      if (cancelled) pending.reject(err);
    };
    const switchId = randomUUID();
    const switchPending: Pending = {
      id: switchId,
      op: "set_current_page",
      timeoutMs: Math.min(pending.timeoutMs, 15_000),
      // Plain functions, not promise callbacks: they run synchronously when
      // the switch settles, before the connection sends the next op.
      resolve: (res) => {
        if (res.ok) {
          const named =
            res.result && typeof res.result === "object" ? (res.result as { name?: string }).name : undefined;
          if (named) conn.info.pageName = named;
          return;
        }
        const err = res.error;
        failOp(
          new OpError(
            (err?.code as ErrorCode | undefined) ?? ErrorCode.NODE_NOT_FOUND,
            err?.message ?? `Could not switch to page "${page}".`,
            err?.hint ?? `Open a window of this file already on "${page}", or create the page first.`,
          ),
        );
      },
      reject: (e) =>
        failOp(
          new OpError(
            e.code,
            `Could not switch to page "${page}" before "${op}": ${e.message}`,
            `"${op}" itself was not sent to Figma — it is safe to retry.`,
          ),
        ),
    };
    conn.enqueue({ id: switchId, op: "set_current_page", params: { name: page } }, switchPending);
    if (failed) {
      pending.reject(failed); // refused before it ever reached the queue
      return;
    }
    conn.enqueue(request, pending);
  }

  /** Take one request out of the unrouted queue; false when it is not there. */
  private removeUnrouted(id: string): boolean {
    const at = this.unrouted.findIndex((item) => item.pending.id === id);
    if (at < 0) return false;
    this.unrouted.splice(at, 1);
    return true;
  }

  private describeChannels(): string {
    return [...this.channels.values()]
      .map((c) => `"${c.channel}" (${c.info.fileName || "untitled"} · ${c.info.pageName || "?"})`)
      .join(", ");
  }

  private generateChannel(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const adj = CHANNEL_ADJECTIVES[randomInt(CHANNEL_ADJECTIVES.length)];
      const noun = CHANNEL_NOUNS[randomInt(CHANNEL_NOUNS.length)];
      const name = `${adj}-${noun}-${randomInt(10, 100)}`;
      if (!this.channels.has(name)) return name;
    }
    return `channel-${randomUUID().slice(0, 8)}`;
  }

  // ---- HTTP ----

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      // Absolute-form request-targets llhttp accepts but URL rejects (e.g. an
      // out-of-range port) must not escape the 'request' listener.
      this.respondJson(res, 400, { error: "bad request" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      this.respondJson(res, 200, this.healthPayload(this.isAuthorized(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/rpc") {
      void this.handleRpc(req, res);
      return;
    }
    this.respondJson(res, 404, { error: "not found" });
  }

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers["authorization"];
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!this.authToken || !token || !safeEqualString(token, this.authToken)) {
      this.respondJson(res, 401, {
        error: { code: ErrorCode.UNAUTHORIZED, message: "Invalid or missing bridge token.", hint: "Follower must send Authorization: Bearer <leader token from leader.json>." },
      });
      return;
    }

    let body: {
      op?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      channel?: string;
      file?: string;
      page?: string;
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      this.respondJson(res, 400, {
        error: { code: ErrorCode.INVALID_PARAMS, message: "Body must be JSON.", hint: "POST { op, params, sessionId?, channel?, file?, page? }." },
      });
      return;
    }

    if (!this.handlers.onRpc) {
      this.respondJson(res, 500, {
        error: { code: ErrorCode.INTERNAL, message: "RPC handler not wired.", hint: "This is a server bug." },
      });
      return;
    }

    // The follower gave up (its call was cancelled, or it died): the HTTP
    // request closes before we answered. Abort the op so one still queued is
    // dropped instead of running later for nobody.
    const abandoned = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abandoned.abort();
    });

    try {
      // NOTE: onRpc runs the op through the SAME validateOperation choke point
      // as leader-direct calls — see index.ts wiring. No bypass.
      const route = {
        ...(body.channel ? { channel: body.channel } : {}),
        ...(body.file ? { file: body.file } : {}),
        ...(body.page ? { page: body.page } : {}),
      };
      const result = await this.handlers.onRpc(
        body.op ?? "",
        body.params ?? {},
        body.sessionId,
        route,
        abandoned.signal,
      );
      if (!res.destroyed) this.respondJson(res, 200, { ok: true, result });
    } catch (err) {
      if (!res.destroyed) this.respondJson(res, 200, { ok: false, error: toBridgeError(err) });
    }
  }

  /**
   * Public /health stays minimal so channel names / file names are not an
   * unauthenticated local oracle for WS hijacks. Pass the bridge Bearer
   * token for the full diagnostics payload (followers that need detail use
   * __status__ over /rpc instead).
   */
  private healthPayload(detailed: boolean): Record<string, unknown> {
    const base: Record<string, unknown> = {
      ok: true,
      port: this.boundPort,
      pluginConnected: this.pluginConnected,
      lastHeartbeatMs: this.lastHeartbeatMs,
      queueLength: this.queueLength,
      pendingCount: this.pendingCount,
      channelCount: this.channels.size,
    };
    if (!detailed) return base;
    return {
      ...base,
      plugin: this.plugin ?? null,
      channels: this.channelSummaries(),
    };
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const auth = req.headers["authorization"];
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return Boolean(this.authToken && token && safeEqualString(token, this.authToken));
  }

  // ---- heartbeat monitor ----

  private startHeartbeatMonitor(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const conn of this.channels.values()) {
        if (conn.ws.readyState === WebSocket.OPEN) {
          // Proactively ping so we notice a silent-dead socket within DEAD window.
          conn.send({ type: "ping", at: Date.now() });
          if (Date.now() - conn.lastHeartbeatAt > HEARTBEAT_DEAD_MS) {
            try {
              conn.ws.terminate();
            } catch {
              /* close handler cleans up */
            }
          }
        }
      }
      // Keep the plugin UI's session picker fresh (activity/lastUsed change
      // without any WS event).
      if (this.channels.size > 0) this.broadcastChannels();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  // ---- utils ----

  private respondJson(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
    res.end(json);
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const shutdownErr = new OpError(ErrorCode.INTERNAL, "Bridge shutting down.", "Server is stopping.");
    for (const conn of this.channels.values()) {
      conn.failAllPending(shutdownErr);
    }
    for (const item of this.unrouted.splice(0)) {
      clearTimeout(item.pending.timer);
      item.pending.reject(shutdownErr);
    }
    // Terminate any live sockets first — WebSocketServer.close() otherwise
    // waits indefinitely for open clients to close.
    if (this.wss) {
      for (const client of this.wss.clients) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
    }
    this.channels.clear();
    this.bySocket.clear();
    for (const t of this.stagedSockets.values()) clearTimeout(t);
    this.stagedSockets.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.closeAllConnections?.();
      this.http.close(() => resolve());
    });
  }
}

/** Allow letters, digits, dashes, underscores, dots; cap length. Anything
 * else (or empty) → "" so the server assigns a generated channel. */
function sanitizeChannel(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!/^[\w.-]{1,64}$/.test(trimmed)) return "";
  return trimmed;
}

function hasResult(res: BridgeResponse): boolean {
  return Object.prototype.hasOwnProperty.call(res, "result");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      data += c;
      if (data.length > 8 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy(); // stop the client streaming into memory after the cap
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
