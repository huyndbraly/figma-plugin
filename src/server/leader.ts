/**
 * Leader election + coordinator.
 *
 * First process to bind the bridge port becomes the LEADER: it writes
 * LeaderInfo (with a random token) to $TMPDIR/figma-plugin/
 * leader-<port>.json at mode 0600 and services operations directly against
 * its bridge. Discovery is PER-PORT: a leader owns its port exclusively, so
 * it owns its discovery file exclusively — several legitimate leaders on
 * different ports (custom FIGMA_MCP_PORT cohorts, default port once squatted)
 * coexist without ever contending for one file. The legacy global leader.json
 * is still written best-effort for old-version followers.
 *
 * A process that hits EADDRINUSE verifies the incumbent via GET /health and
 * becomes a FOLLOWER, forwarding every operation via POST /rpc with the
 * leader's Bearer token. Followers run a jittered 3–5 s health monitor and,
 * on leader death (connection refused, or no answer from a process that is
 * gone), take over by contending for the dead leader's port only. A forward
 * refused by the leader takes over at once and sends the op again. A leader
 * that is merely busy (its process alive, its /health late) is followed,
 * never stepped around. A 401 from the leader triggers a re-read of the
 * discovery file (the leader restarted with a fresh token) before the error
 * is surfaced.
 *
 * CRITICAL: the `runValidated` callback — passed in by index.ts — wraps
 * validateOperation() and is invoked in exactly ONE place per role:
 *   - leader: for both its own tool calls AND for /rpc forwards (Bridge.onRpc).
 *   - follower: before forwarding, the follower ALSO validates locally so a
 *     bad op never even leaves the machine; the leader validates again on
 *     receipt. Either way an op cannot reach the bridge unvalidated.
 */
import { mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Bridge } from "./bridge.js";
import { DEFAULT_PORT, PORT_RANGE, READ_OPERATIONS, type LeaderInfo } from "../shared/protocol.js";
import { baseDir, leaderFilePath, leaderFilePathFor } from "./paths.js";
import { VERSION } from "./version.js";
import { ErrorCode, OpError, toBridgeError } from "./errors.js";
import { Follower, LeaderUnreachable, pidAlive } from "./follower.js";

export type Role = "leader" | "follower";

/**
 * Runs one validated op end-to-end (validate → bridge dispatch). index.ts
 * supplies this; it is the single validation choke point. Signature matches
 * both the leader-direct path and the /rpc path. `channel` targets a specific
 * Figma window; `sessionId` also feeds Figma-side session→channel bindings.
 * `signal` aborts when the caller stops waiting.
 */
export type RunValidated = (
  op: string,
  params: Record<string, unknown>,
  sessionId?: string,
  route?: import("./route.js").RouteArg,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * Forwards that only read: safe to send again after the connection to the
 * leader reset under them. A write might have started on the old leader.
 */
const REPEATABLE_FORWARDS = new Set<string>([
  ...(READ_OPERATIONS as readonly string[]),
  "list_channels",
  "__status__",
  "__register__",
]);

export interface CoordinatorDeps {
  /** Validate + dispatch (leader path). Also used for /rpc forwards. */
  runValidated: RunValidated;
  /**
   * Fires for EVERY bridge this coordinator ever creates — the initial
   * election AND any follower→leader takeover. Wiring (sessions provider,
   * etc.) must happen here, not once after start(); a takeover creates a NEW
   * Bridge and one-time wiring left the replacement bridge dead (real bug:
   * every op after a takeover failed NOT_CONNECTED).
   */
  onBridgeCreated?: (bridge: Bridge) => void;
  /** A plugin window saved/cleared the Figma REST token (see rest-hub.ts). */
  onRestToken?: (token: string | null, channel: string, meta?: { expiresAt?: number | null }) => void;
  /**
   * Fires whenever this process starts following a leader — at election,
   * after a takeover by another process, after the leader restarted with a
   * new token. The new leader knows nothing of this process's session, so
   * index.ts registers it again; otherwise the plugin's session picker lost
   * every follower after a failover.
   */
  onFollowerCreated?: () => void;
  /** Health poll interval bounds (ms); default 3000–5000 jittered. */
  healthIntervalMs?: [number, number];
  startPort?: number;
}

export class Coordinator {
  role: Role = "leader";
  bridge?: Bridge;
  follower?: Follower;
  private leaderInfo?: LeaderInfo;
  private healthTimer?: NodeJS.Timeout;
  private closed = false;
  /**
   * Guards against an unbounded elect→follow→elect loop (e.g. a foreign
   * process squatting the port with no valid leader file) WITHIN one election
   * run. Reset at the top of every start(): the counter previously persisted
   * across runs, so once a takeover attempt exhausted it, every later attempt
   * threw instantly — the follower could never take over even after the
   * blocking condition cleared.
   */
  private electionAttempts = 0;
  private static readonly MAX_ELECTION_ATTEMPTS = 5;

  constructor(private readonly deps: CoordinatorDeps) {}

  /**
   * Elect role by walking the port range once. For each port, in order:
   *   1. If a live Figma Plugin MCP server already answers /health there → FOLLOW it
   *      (read its token from leader-<port>.json, falling back to the legacy
   *      leader.json). This is the fix for the "every window becomes its own
   *      leader" bug: a second instance now discovers the incumbent instead
   *      of grabbing the next free port.
   *   2. Else, if nobody listens, try to BIND it → become LEADER. A foreign
   *      process that squats a port is skipped so a Figma Plugin MCP leader
   *      can still live on a higher port (the plugin walks the same range to
   *      find it). A port that accepts but answers late is skipped only when
   *      its discovery file does not name a live process — a busy leader of
   *      ours is followed, never stepped around.
   * Ties/races on the same port (bind loses to a peer that just came up) are
   * resolved by a bounded retry of the whole election. Each start() call is a
   * fresh run with a fresh retry budget.
   */
  async start(): Promise<Role> {
    this.electionAttempts = 0;
    return this.elect();
  }

  /**
   * @param onlyPort A takeover: contend for the dead leader's port and
   *   nothing else. Walking on to port+1 there is how a briefly busy leader
   *   ended up with a second leader beside it — one the plugin, still on the
   *   first port, never talks to.
   */
  private async elect(onlyPort?: number): Promise<Role> {
    this.electionAttempts++;
    if (this.closed) throw new Error("Coordinator closed.");
    if (this.electionAttempts > Coordinator.MAX_ELECTION_ATTEMPTS) {
      throw new Error(
        `Could not become leader or follower after ${Coordinator.MAX_ELECTION_ATTEMPTS} attempts — ` +
          `port ${onlyPort ?? this.deps.startPort ?? DEFAULT_PORT}${onlyPort === undefined ? `..+${PORT_RANGE - 1}` : ""} may be held by a foreign process. ` +
          `Free one of those ports, or set FIGMA_MCP_PORT to a free port in ` +
          `${DEFAULT_PORT}-${DEFAULT_PORT + PORT_RANGE - 1} (the range the Figma plugin scans).`,
      );
    }
    const startPort = onlyPort ?? this.deps.startPort ?? DEFAULT_PORT;
    const span = onlyPort === undefined ? PORT_RANGE : 1;
    const token = randomBytes(24).toString("hex");

    for (let i = 0; i < span; i++) {
      const port = startPort + i;
      const state = await Follower.probe(port);

      // 1. A Figma Plugin MCP leader lives here → follow it (or retry on
      // race). A `busy` port counts when its discovery file names a live
      // process: a leader blocked past the health timeout by a long op is
      // still the leader, and skipping its port split the cohort in two.
      if (state === "ok" || (state === "busy" && (await this.ownedByLiveLeader(port)))) {
        const followed = await this.tryFollowOn(port);
        if (followed) return "follower";
        // It answers /health but its discovery file isn't visible/matching
        // yet (it is still starting up). Back off and re-run the election.
        await delay(250);
        return this.elect(onlyPort);
      }
      if (state !== "refused") {
        // Something that is not ours holds it. Skip it — except in a
        // takeover, which waits for this port rather than moving.
        if (onlyPort !== undefined) {
          await delay(250);
          return this.elect(onlyPort);
        }
        continue;
      }

      // 2. Nobody listens here → try to become leader.
      const bridge = new Bridge({
        // The /rpc forward path: a follower forwarded an op → leader runs it
        // through the SAME validate+dispatch choke point as its own calls.
        onRpc: (op, params, sessionId, channel) => this.deps.runValidated(op, params, sessionId, channel),
        onRestToken: (token, channel, meta) => this.deps.onRestToken?.(token, channel, meta),
      });
      try {
        const bound = await bridge.listen(port, token);
        const info: LeaderInfo = { port: bound, token, pid: process.pid, startedAt: Date.now(), version: VERSION };
        // Commit role state only AFTER the post-bind steps succeed — a throw
        // here used to leave role:"leader" bound to a bridge the catch then
        // closed, parking every later op in the unrouted queue forever.
        await this.writeLeaderFile(info);
        this.deps.onBridgeCreated?.(bridge);
        this.bridge = bridge;
        this.role = "leader";
        this.leaderInfo = info;
        this.electionAttempts = 0;
        return "leader";
      } catch (err) {
        await bridge.close().catch(() => {});
        if (!isAddrInUse(err)) throw err;
        // The port was taken between the probe and our bind. If a Figma
        // Plugin MCP peer grabbed it (healthy, still starting, or ours and
        // busy), re-run election so we follow it; only a foreign process
        // sends us on to the next port.
        const again = await Follower.probe(port);
        if (
          onlyPort !== undefined ||
          again === "ok" ||
          again === "refused" ||
          (again === "busy" && (await this.ownedByLiveLeader(port)))
        ) {
          await delay(200);
          return this.elect(onlyPort);
        }
        continue;
      }
    }

    // Whole range is held by foreign/unhealthy processes.
    await delay(250);
    return this.elect(onlyPort);
  }

  /** Does leader-<port>.json name a process that is still running? */
  private async ownedByLiveLeader(port: number): Promise<boolean> {
    const info = await this.readLeaderFile(port);
    return !!info && info.port === port && pidAlive(info.pid);
  }

  /**
   * Take over from a leader that stopped answering — once, however many
   * callers notice at the same moment (the health monitor and several
   * failing forwards). Contends only for the dead leader's port.
   */
  private takeoverRun?: Promise<void>;
  private takeover(deadPort: number): Promise<void> {
    if (this.takeoverRun) return this.takeoverRun;
    this.stopHealthMonitor();
    this.takeoverRun = (async () => {
      try {
        this.electionAttempts = 0;
        await this.elect(deadPort);
      } catch {
        // Lost or blocked: keep following and let the monitor try again.
        if (!this.closed && this.role === "follower") this.startHealthMonitor();
      } finally {
        this.takeoverRun = undefined;
      }
    })();
    return this.takeoverRun;
  }

  /**
   * Become a follower of the Figma Plugin MCP leader on `port`, using the token from
   * leader-<port>.json (or the legacy leader.json for an old-version leader).
   * Returns false if no discovery file matches (startup race) so the caller
   * can retry election.
   */
  private async tryFollowOn(port: number): Promise<boolean> {
    const info = await this.readLeaderFile(port);
    if (!info || info.port !== port || !info.token) return false;
    this.role = "follower";
    this.follower = new Follower(info);
    this.startHealthMonitor();
    this.electionAttempts = 0;
    this.deps.onFollowerCreated?.();
    return true;
  }

  /** Follower path used by index.ts to run an op (validate happens upstream). */
  async forward(
    op: string,
    params: Record<string, unknown>,
    sessionId?: string,
    channel?: string,
    timeoutMs?: number,
    route?: { file?: string; page?: string; signal?: AbortSignal },
  ): Promise<unknown> {
    if (!this.follower) {
      throw new OpError(ErrorCode.INTERNAL, "forward() called without a follower.", "This is a server bug.");
    }
    const opts = {
      ...(route?.file ? { file: route.file } : {}),
      ...(route?.page ? { page: route.page } : {}),
      ...(route?.signal ? { signal: route.signal } : {}),
    };
    try {
      return await this.follower.forward(op, params, sessionId, channel, timeoutMs, opts);
    } catch (err) {
      // 401: the leader restarted on the same port with a fresh token (e.g.
      // the user reloaded that window's MCP server). /health stays green, so
      // the health monitor never notices — without this refresh every forward
      // 401s forever and the only way out was restarting this follower too.
      if (
        err instanceof OpError &&
        err.code === ErrorCode.UNAUTHORIZED &&
        (await this.refreshFollowerInfo())
      ) {
        return this.follower.forward(op, params, sessionId, channel, timeoutMs, opts);
      }
      // The leader is gone: take over NOW rather than at the next health
      // tick (3–5s away), then send the op once more — to ourselves if we
      // won, to the new leader if someone else did. A refused connection
      // never reached anyone, so any op may go again; a reset one may have
      // started on the dead leader, so only reads are repeated.
      if (err instanceof LeaderUnreachable && this.follower && !this.closed) {
        await this.takeover(this.follower.info.port);
        if (err.kind === "refused" || REPEATABLE_FORWARDS.has(op)) {
          if (this.role === "leader") {
            return this.deps.runValidated(
              op,
              params,
              sessionId,
              { ...(channel ? { channel } : {}), ...(route?.file ? { file: route.file } : {}), ...(route?.page ? { page: route.page } : {}) },
              route?.signal,
            );
          }
          return this.follower.forward(op, params, sessionId, channel, timeoutMs, opts);
        }
      }
      throw err;
    }
  }

  /**
   * Re-read the discovery file for the followed port and adopt a CHANGED
   * token. Returns true only when a fresh, different token was found — the
   * caller then retries exactly once (an unchanged token means the 401 has
   * some other cause and must surface).
   */
  private async refreshFollowerInfo(): Promise<boolean> {
    const stale = this.follower?.info;
    if (!stale) return false;
    const fresh = await this.readLeaderFile(stale.port);
    if (!fresh || fresh.port !== stale.port || !fresh.token || fresh.token === stale.token) {
      return false;
    }
    this.follower = new Follower(fresh);
    this.deps.onFollowerCreated?.();
    return true;
  }

  private startHealthMonitor(): void {
    this.stopHealthMonitor();
    const [lo, hi] = this.deps.healthIntervalMs ?? [3000, 5000];
    const tick = async () => {
      if (this.closed || this.role !== "follower" || !this.follower) return;
      const leader = this.follower.info;
      let state = await Follower.probe(leader.port).catch(() => "refused" as const);
      if (state === "busy" || state === "foreign") {
        // A single slow or garbled /health does not prove that the leader is
        // dead. In particular, deleting its discovery file after one miss
        // strands a still-listening leader: new MCP processes can see the
        // healthy port but have no token with which to follow it.
        await delay(250);
        state = await Follower.probe(leader.port).catch(() => "refused" as const);
      }
      // Refused = nothing listens: the leader is dead, take over at once.
      // Busy while its process lives = a long op blocks its event loop; it
      // is still the leader and the plugin is still connected to it.
      const dead = state === "refused" || (state !== "ok" && !(state === "busy" && pidAlive(leader.pid)));
      if (dead) {
        // Do not remove another process's discovery file here. If the
        // leader really died, binding its now-free port and publishing our
        // own token replaces the stale file atomically. If this was merely
        // a transient health failure, leaving the file alone keeps the live
        // leader discoverable.
        await this.takeover(leader.port);
        return;
      }
      this.scheduleHealth(lo, hi, tick);
    };
    this.scheduleHealth(lo, hi, tick);
  }

  private scheduleHealth(lo: number, hi: number, tick: () => void): void {
    const jitter = lo + Math.floor(Math.random() * Math.max(1, hi - lo));
    this.healthTimer = setTimeout(tick, jitter);
    this.healthTimer.unref?.();
  }

  private stopHealthMonitor(): void {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = undefined;
  }

  // ---- leader file I/O ----

  /**
   * Publish this leader's info.
   *
   * The authoritative record is PER-PORT (leader-<port>.json). Owning the
   * bound port means owning that file — no other LIVE leader can legitimately
   * write it, so publication never contends. (The previous single global
   * leader.json meant a second leader on another port — normal when
   * FIGMA_MCP_PORT is set — either clobbered a healthy incumbent's entry and
   * later deleted it on exit, stranding an undiscoverable live leader, or
   * "deferred" and became undiscoverable itself, wedging every later
   * election. Per-port files remove the shared resource entirely.)
   *
   * The legacy global leader.json is still written for old-version followers
   * (mixed-version rollout), best-effort: defer to a DIFFERENT live leader —
   * never clobber a healthy incumbent's entry — but take over from a corpse.
   */
  private async writeLeaderFile(info: LeaderInfo): Promise<void> {
    await mkdir(baseDir(), { recursive: true });
    await writeInfoFileAtomic(leaderFilePathFor(info.port), info);
    const current = await readInfoFile(leaderFilePath());
    if (current && current.port !== info.port && (await Follower.checkHealth(current.port))) {
      return; // a live incumbent owns the legacy entry
    }
    await writeInfoFileAtomic(leaderFilePath(), info);
  }

  /**
   * Discovery read for the leader on `port`: leader-<port>.json first, then
   * the legacy leader.json (an old-version leader publishes only there).
   */
  async readLeaderFile(port: number): Promise<LeaderInfo | undefined> {
    const perPort = await readInfoFile(leaderFilePathFor(port));
    if (perPort && perPort.port === port) return perPort;
    const legacy = await readInfoFile(leaderFilePath());
    if (legacy && legacy.port === port) return legacy;
    return undefined;
  }

  /**
   * Remove discovery files that still record `known` — and ONLY then.
   * Identity is pid + startedAt + port: matching on pid+startedAt alone let a
   * leader on ANOTHER port delete the live leader's legacy entry on shutdown,
   * leaving a healthy leader with no discoverable token — every new process
   * then failed election and exited silently.
   */
  private async removeLeaderFileIfStale(known: LeaderInfo): Promise<void> {
    const owns = (info: LeaderInfo | undefined): boolean =>
      !!info &&
      info.pid === known.pid &&
      info.startedAt === known.startedAt &&
      info.port === known.port;
    if (owns(await readInfoFile(leaderFilePathFor(known.port)))) {
      await rm(leaderFilePathFor(known.port), { force: true });
    }
    if (owns(await readInfoFile(leaderFilePath()))) {
      await rm(leaderFilePath(), { force: true });
    }
  }

  info(): LeaderInfo | undefined {
    return this.leaderInfo ?? this.follower?.info;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopHealthMonitor();
    if (this.role === "leader") {
      await this.removeLeaderFileIfStale(this.leaderInfo!).catch(() => {});
      await this.bridge?.close().catch(() => {});
    }
  }
}

function isAddrInUse(err: unknown): boolean {
  if (err instanceof OpError) {
    // Bridge maps "whole range busy" to INTERNAL; treat as addr-in-use too so
    // a fully-occupied range still results in follower election.
    return err.code === ErrorCode.INTERNAL && /No free port/.test(err.message);
  }
  return !!err && typeof err === "object" && (err as { code?: string }).code === "EADDRINUSE";
}

/** Parse a discovery file; undefined on absence, torn JSON, or bad shape. */
async function readInfoFile(path: string): Promise<LeaderInfo | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const info = JSON.parse(raw) as LeaderInfo;
    if (typeof info.port === "number" && typeof info.token === "string") {
      return info;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write at mode 0600 (only the owner may read the token) via tmp + rename:
 * readers never observe a torn file, and two racing writers can't interleave
 * — the last rename wins wholesale.
 */
async function writeInfoFileAtomic(path: string, info: LeaderInfo): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

export { toBridgeError };
