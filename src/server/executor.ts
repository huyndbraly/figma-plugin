/**
 * figma_write executor.
 *
 * Runs the caller's modern-ES JavaScript inside a Node `vm` context. The
 * context exposes:
 *   - `figma`  — a proxy whose camelCase methods map to snake_case protocol
 *                ops and each perform ONE bridge round-trip (a Promise).
 *   - `state`  — the persistent per-session object (survives figma_write calls).
 *   - `console`— captured (log/info/warn/error) and returned to the caller.
 *   - standard globals (Math, JSON, Object, Array, Promise, Date, ...).
 * Banned: require, process, fetch, setTimeout/setInterval, eval, Function.
 *
 * Why a worker: `vm`'s timeout only bounds SYNCHRONOUS execution — a
 * `while(true){}` that starts AFTER an `await` resumes on the host event loop
 * with no timeout able to fire, and used to freeze the whole server (every
 * Figma channel, every session). Inside a worker the loop blocks only that
 * thread; the parent's deadline still fires and `worker.terminate()` kills
 * it. The invoke boundary was already pure JSON-RPC (method name + JSON args
 * in, JSON envelope out), so moving the context across a thread changed the
 * transport, not the trust boundary.
 *
 * figma.batch(ops) is special: it splits into BATCH_CHUNK_SIZE chunks streamed
 * sequentially, each chunk a separate bridge dispatch timed by the sum of its
 * items' op budgets. The plugin pings progress after every item, which resets
 * that timer; per-item try/catch on the plugin side yields exact per-index
 * errors and warnings; partial results are committed (no rollback).
 */
import { VERSION } from "./version.js";
import { Worker } from "node:worker_threads";
import { setMaxListeners } from "node:events";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
  BATCH_CHUNK_SIZE,
  DEFAULT_OP_TIMEOUT_MS,
  OP_TIMEOUTS,
  VM_TIMEOUT_MS,
  type AnyOperation,
  type BridgeResponse,
  type Operation,
} from "../shared/protocol.js";
import { ErrorCode, OpError, toBridgeError } from "./errors.js";
import {
  assertHostResolvesPublic,
  assertSafeImageUrl,
  defaultHostResolver,
  type HostResolver,
} from "./security.js";
import type { Session } from "./session.js";
import { validateOperation, isReadOp } from "./validate.js";
import { loadIconSvg, searchIcons as searchIconsSvc, type Fetcher, type IconLibrary } from "./icons.js";
import { runUserflow } from "./userflow.js";
import { translateProps, type ComponentMap, type Translated } from "../shared/component-map.js";

/**
 * A single op runner: validate → dispatch → unwrap. This IS the leader-direct
 * path. index.ts builds it around the bridge; the executor calls it for every
 * figma.* method so validation is never skipped. Accepts server ops too
 * (list_channels) — index.ts answers those from bridge state.
 */
export type OpRunner = (
  op: AnyOperation,
  params: Record<string, unknown>,
  ctx?: {
    /** Aborted when the figma_write that issued the op has given up waiting —
     * the runner hands it to the bridge so a still-queued op is dropped. */
    signal?: AbortSignal;
    /** Overrides the bridge's per-op budget — a batch chunk is timed by what
     * is IN it, not by the 30s every batch dispatch otherwise gets. */
    timeoutMs?: number;
  },
) => Promise<BridgeResponse>;

export interface ExecutorDeps {
  runOp: OpRunner;
  /** Injectable for tests — real icon fetch is server-side over the CDN. */
  iconFetcher?: Fetcher;
  /** Injectable for tests — resolves an image URL to base64 bytes. */
  imageFetcher?: (url: string, init?: { signal?: AbortSignal }) => Promise<string>;
  /** The calling figma_write's abort signal (set by executeWrite): server-side
   * fetches made for the call stop when it stops waiting. */
  signal?: AbortSignal;
  /** Injectable for tests — the per-hop HTTP transport under loadImage's
   * redirect and address checks (default: pinnedHttpsFetch). */
  imageFetch?: ImageFetch;
  /** Injectable for tests — DNS for loadImage's address check. */
  resolveHost?: HostResolver;
}

export interface WriteResult {
  ok: boolean;
  result?: unknown;
  logs: string[];
  warnings: string[];
  error?: { code: ErrorCode; message: string; hint?: string };
}

/** camelCase sandbox method → snake_case protocol op. */
const METHOD_TO_OP: Record<string, AnyOperation> = {
  create: "create",
  modify: "modify",
  delete: "delete",
  del: "delete",
  clone: "clone",
  move: "move",
  resize: "resize",
  group: "group",
  ungroup: "ungroup",
  flatten: "flatten",
  batch: "batch",
  setupTokens: "setup_tokens",
  setupTextStyles: "setup_text_styles",
  setTextStyle: "set_text_style",
  setupEffectStyles: "setup_effect_styles",
  applyVariable: "apply_variable",
  createVariable: "create_variable",
  updateVariable: "update_variable",
  renameVariable: "rename_variable",
  deleteVariable: "delete_variable",
  exportTokens: "export_tokens",
  importTokens: "import_tokens",
  setText: "set_text",
  loadImage: "load_image",
  createPage: "create_page",
  setCurrentPage: "set_current_page",
  deletePage: "delete_page",
  deleteStyle: "delete_style",
  deleteUnusedStyles: "delete_unused_styles",
  overlay: "create_overlay",
  zoomToFit: "zoom_to_fit",
  setSelection: "set_selection",
  // Edit-in-place composite write ops (business logic lives in the plugin).
  setSelectionColors: "set_selection_colors",
  setGradient: "set_gradient",
  setEffects: "set_effects",
  setReactions: "set_reactions",
  // Put a drawn diagram's arrows back on its boxes after they were moved.
  reflowDiagram: "reflow_diagram",
  // Components and instances.
  findComponent: "find_component",
  findOrCreateComponent: "find_or_create_component",
  componentize: "componentize",
  createVariants: "create_variants",
  arrangeComponentSet: "arrange_component_set",
  setComponentDescription: "set_component_description",
  addComponentProperty: "add_component_property",
  editComponentProperty: "edit_component_property",
  deleteComponentProperty: "delete_component_property",
  instantiate: "instantiate",
  createInstance: "instantiate",
  setInstanceProperties: "set_instance_properties",
  setProperties: "set_instance_properties",
  getInstanceOverrides: "get_instance_overrides",
  setInstanceOverrides: "set_instance_overrides",
  swapComponent: "swap_component",
  exposeNestedInstance: "expose_nested_instance",
  detachInstance: "detach_instance",
  resetInstanceOverrides: "reset_instance_overrides",
  // Quality audits.
  a11yAudit: "a11y_audit",
  auditDesignSystem: "audit_design_system",
  applyDesignSystem: "apply_design_system",
  responsiveAudit: "responsive_audit",
  // Code ↔ Figma component map (render/useComponentMap are custom below).
  exportComponentMap: "export_component_map",
  checkComponentMap: "check_component_map",
  // read ops usable from write code
  readSelection: "read_selection",
  getNodeById: "get_node",
  getNode: "get_node",
  getNodes: "get_nodes",
  getChildren: "get_children" as Operation, // handled specially below
  getDocumentInfo: "get_document_info",
  getSelection: "get_selection",
  getDesignContext: "get_design_context",
  searchNodes: "search_nodes",
  scanTextNodes: "scan_text_nodes",
  scanNodesByTypes: "scan_nodes_by_types",
  getStyles: "get_styles",
  getVariables: "get_variables",
  getComponents: "get_components",
  getComponent: "get_component",
  getLibraryComponent: "get_library_component",
  getDesignSystemKit: "get_design_system_kit",
  generateDesignMd: "generate_design_md",
  designFingerprint: "design_fingerprint",
  screenshot: "screenshot",
  exportNode: "export_node",
  getFonts: "get_fonts",
  layoutAudit: "layout_audit",
  currentPage: "get_document_info", // convenience; returns doc/page info
  // Server-answered (never hits the plugin): connected Figma windows.
  listChannels: "list_channels",
};

/**
 * Race a promise against a wall-clock deadline. The vm's synchronous timeout
 * cannot catch an awaited promise that never settles (e.g. `new Promise(()=>{})`),
 * so we enforce the same budget on the async path here and fail with a clean,
 * in-budget PLUGIN_TIMEOUT instead of hanging until the MCP transport drops.
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new OpError(
          ErrorCode.PLUGIN_TIMEOUT,
          `figma_write exceeded the ${ms}ms budget (async operation never completed).`,
          "An awaited promise never resolved (e.g. a bridge op that stalled, or a Promise that never settles). Split the work across calls, or ensure every await eventually resolves.",
        ),
      );
    }, ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Per-session serialization of figma_write calls. The sandbox snapshots
 * session.state on entry and REPLACES it on exit (__syncState), so two writes
 * running concurrently on one session each overwrite the other's mutations —
 * and mid-call host reads (setupTokens' token map) race the same way. MCP
 * tool calls run concurrently, so the chain lives here, keyed by the Session
 * object both call paths resolve through the same registry.
 */
const writeChains = new WeakMap<Session, Promise<unknown>>();

export interface ExecuteWriteOpts {
  /** Override the execution budget (tests use a short budget). */
  timeoutMs?: number;
}

export function executeWrite(
  code: string,
  session: Session,
  deps: ExecutorDeps,
  opts?: ExecuteWriteOpts,
): Promise<WriteResult> {
  const prev = writeChains.get(session) ?? Promise.resolve();
  const next = prev.then(() => executeWriteInner(code, session, deps, opts));
  // Store a rejection-proof tail so one failed write never wedges the chain.
  writeChains.set(session, next.catch(() => undefined));
  return next;
}

async function executeWriteInner(
  code: string,
  session: Session,
  deps: ExecutorDeps,
  opts?: ExecuteWriteOpts,
): Promise<WriteResult> {
  const timeoutMs = opts?.timeoutMs ?? VM_TIMEOUT_MS;
  const logs: string[] = [];
  const warnings: string[] = [];

  const startedAt = Date.now();
  // Host-side writes to session.state made DURING this call (setupTokens'
  // token map, useComponentMap). Each write is numbered; the invoke envelope
  // that follows it carries it into the sandbox's own `state` copy at once, so
  // code later in the same call reads it. On exit the sandbox reports the
  // highest number it merged: those keys are already in its copy (and any
  // in-call edit of them wins); only writes it never saw are re-applied.
  const stateOverlay = new StateOverlay();
  // Every op this call issues carries one abort signal. When the budget runs
  // out the caller is told PLUGIN_TIMEOUT and moves on; an op still sitting in
  // a bridge queue must not run afterwards on whatever window turns up.
  const abort = new AbortController();
  // One listener per op still waiting; a Promise.all over a dozen reads is
  // normal, and the default cap of 10 printed MaxListenersExceededWarning.
  setMaxListeners(0, abort.signal);
  const scopedDeps: ExecutorDeps = {
    ...deps,
    signal: abort.signal,
    runOp: (op, params, ctx) => deps.runOp(op, params, { ...ctx, signal: abort.signal }),
  };
  const figmaProxy = buildFigmaProxy(session, scopedDeps, warnings, stateOverlay);

  // ---- realm-boundary design (why this looks the way it does) ----
  //
  // node:vm gives a separate REALM, not a separate trust domain: any host
  // object reachable from sandbox code hands it the host realm's Function
  // through `value.constructor.constructor`, which then reads the real
  // `process` — a full escape. So the rule, unchanged in the worker:
  //
  //   NOTHING worker-realm may become reachable from user code. Only
  //   primitives (JSON strings) cross the boundary; everything else is
  //   rebuilt inside the context realm by BOOTSTRAP_SRC.
  //
  // - `__invoke` resolves a JSON envelope string (never rejects, never
  //   returns objects) and is removed from the globals by the bootstrap —
  //   user code can never hold its Promise. In the worker it is a postMessage
  //   relay to `invoke` here, which does the real dispatch.
  // - `figma` is rebuilt inside the context as async wrappers that `await`
  //   the relay internally and re-throw a context-realm Error (code/hint).
  // - `state` is a JSON snapshot parsed inside the context; the wrapped IIFE
  //   syncs it back through `__syncState` (a posted message) in `finally`.
  // - banned globals are context stubs — a thrown Error must be context-realm.
  // - `console` and `__syncState` are the only outside values left reachable:
  //   scrubbed by the bootstrap and returning only primitives.
  // Ops the sandbox has asked for that have not answered yet. At the deadline
  // they decide the hint (a Figma op still running is not a sync loop); on a
  // normal finish the un-awaited ones are waited for, not abandoned.
  const inFlight = new Map<number, { method: string; settled: Promise<string> }>();
  let invokeSeq = 0;
  const invokeRaw = async (method: string, argsJson: string): Promise<string> => {
    let envelope: Record<string, unknown>;
    try {
      // Reads go through the proxy's get-trap so unknown methods resolve to
      // the DX stub (mapped suggestion / nearest-method hint), whose thrown
      // OpError lands in the error envelope below.
      const fn = (figmaProxy as Record<string, unknown>)[method];
      if (typeof fn !== "function") {
        envelope = {
          ok: false,
          error: { code: ErrorCode.INVALID_PARAMS, message: `figma.${method} is not a function.` },
        };
      } else {
        const args = decodeArgs(JSON.parse(argsJson));
        const result = await (fn as (...a: unknown[]) => unknown)(...args);
        envelope = { ok: true, result };
      }
    } catch (err) {
      const be = toBridgeError(err);
      envelope = {
        ok: false,
        error: { code: be.code, message: be.message, ...(be.hint ? { hint: be.hint } : {}) },
      };
    }
    // Host-side state writes ride back on whichever envelope comes next.
    const delta = stateOverlay.takeUnsent();
    if (delta) Object.assign(envelope, delta);
    return JSON.stringify(envelope);
  };
  const invoke = (method: string, argsJson: string): Promise<string> => {
    const id = ++invokeSeq;
    const settled = invokeRaw(method, argsJson).finally(() => inFlight.delete(id));
    inFlight.set(id, { method, settled });
    return settled;
  };

  const syncState = (json: string, seenSeq: unknown): void => {
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        session.state = stateOverlay.applyUnseen(
          { ...(parsed as Record<string, unknown>) },
          typeof seenSeq === "number" ? seenSeq : 0,
        );
      }
    } catch {
      /* malformed state JSON — keep the last known-good session.state */
    }
  };

  let stateJson = "{}";
  try {
    stateJson = JSON.stringify(session.state ?? {});
  } catch {
    /* unserializable prior state — this call starts from {} */
  }

  session.writeCount++;

  // The worker rebuilds the figma surface from DATA: method names become
  // context-realm async wrappers around the relay; plain values (the `mixed`
  // sentinel) cross as a JSON copy.
  const figmaMethods: string[] = [];
  const figmaData: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(figmaProxy)) {
    const v = figmaProxy[name];
    if (typeof v === "function") figmaMethods.push(name);
    else figmaData[name] = v;
  }
  let figmaDataJson = "{}";
  try {
    figmaDataJson = JSON.stringify(figmaData);
  } catch {
    /* unserializable data props — the sandbox gets none */
  }

  const worker = new Worker(WRITE_WORKER_SOURCE, {
    eval: true,
    workerData: { code, stateJson, figmaMethods, figmaDataJson, timeoutMs },
    // A sandbox that builds an unbounded array would otherwise grow until the
    // whole MCP server (same process) is killed by the OS. With a heap cap
    // only the worker dies, and the caller gets a SANDBOX_ERROR. It bounds the
    // JS heap only: typed-array backing stores (Uint8Array) live outside it, so
    // this is a guard against runaway objects and arrays, not a memory limit.
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
  });
  // A wedged worker must not pin the process open — terminate() is the cleanup.
  worker.unref();

  interface DoneMsg {
    t: "done";
    ok: boolean;
    result?: unknown;
    error?: { code: ErrorCode; message: string; hint?: string };
    logDropped?: number;
  }
  type WorkerMsg =
    | { t: "invoke"; seq: number; method: string; argsJson: string }
    | { t: "state"; json: string; seq?: number }
    | { t: "log"; line: string }
    | { t: "log-dropped"; n: number }
    | DoneMsg;
  // The parent keeps its own cap too: the worker's is what keeps the flood
  // off the message channel, this one is what bounds the result regardless.
  let logDropped = 0;
  let logChars = 0;

  const done = new Promise<DoneMsg | null>((resolve) => {
    let finished = false;
    const finish = (m: DoneMsg | null) => {
      if (!finished) {
        finished = true;
        resolve(m);
      }
    };
    worker.on("message", (m: WorkerMsg) => {
      if (m.t === "invoke") {
        void invoke(m.method, m.argsJson).then((env) => {
          try {
            worker.postMessage({ t: "r", seq: m.seq, env });
          } catch {
            /* worker already gone */
          }
        });
      } else if (m.t === "state") {
        syncState(m.json, m.seq);
      } else if (m.t === "log") {
        const line = String(m.line);
        if (logs.length >= MAX_LOG_LINES || logChars >= MAX_LOG_CHARS) logDropped++;
        else {
          logs.push(line);
          logChars += line.length;
        }
      } else if (m.t === "log-dropped") {
        if (typeof m.n === "number" && m.n > logDropped) logDropped = m.n;
      } else if (m.t === "done") {
        if (typeof m.logDropped === "number" && m.logDropped > logDropped) logDropped = m.logDropped;
        finish(m);
      }
    });
    worker.on("error", (e) =>
      finish({
        t: "done",
        ok: false,
        error: { code: ErrorCode.SANDBOX_ERROR, message: `figma_write worker failed: ${e.message}` },
      }),
    );
    worker.on("exit", (code) => {
      if (code !== 0) {
        finish({
          t: "done",
          ok: false,
          error: { code: ErrorCode.SANDBOX_ERROR, message: `figma_write worker exited (code ${code}).` },
        });
      } else {
        finish(null);
      }
    });
  });

  // The deadline covers spawn + the whole run. The worker's own vm timeout
  // reports sync-phase loops first (the richer error); terminate() is what
  // makes a post-await CPU loop survivable — it blocks only the worker thread,
  // so this deadline still fires and kills it. Slack gives the in-worker
  // timeout room to report before the parent steps in.
  let msg: DoneMsg | null;
  let terminated = false;
  // What was still running when the budget ran out — read before abort()
  // settles the queued ones.
  let pendingAtDeadline: string[] = [];
  const budgetMs = timeoutMs + WORKER_SLACK_MS;
  try {
    msg = await withDeadline(done, budgetMs);
  } catch {
    terminated = true;
    msg = null;
    pendingAtDeadline = [...inFlight.values()].map((f) => f.method);
    abort.abort();
  }
  try {
    await worker.terminate();
  } catch {
    /* already gone */
  }

  // The code returned while ops it never awaited were still running. They are
  // host-side promises, independent of the worker: wait for them (within what
  // is left of the budget) so their errors and warnings reach the caller and a
  // later call never races them. What is still pending after that is dropped
  // if it has not reached Figma yet. Awaited code has nothing here.
  if (!terminated && inFlight.size > 0) {
    const late: string[] = [];
    for (const [, f] of inFlight) {
      void f.settled.then((env) => {
        const e = parseErrorEnvelope(env);
        if (e) late.push(`Un-awaited figma.${f.method} failed after the code returned: ${e}`);
      });
    }
    const remaining = Math.max(0, startedAt + budgetMs - Date.now());
    const all = Promise.allSettled([...inFlight.values()].map((f) => f.settled));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      all.then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), remaining);
      }),
    ]);
    clearTimeout(timer);
    // Let the .then above record errors for the ones that just settled.
    await Promise.resolve();
    if (timedOut) {
      const still = [...inFlight.values()].map((f) => f.method);
      abort.abort();
      warnings.push(
        `${still.length} figma op${still.length === 1 ? " was" : "s were"} still running when the budget ran out (${[...new Set(still)].map((m) => `figma.${m}`).join(", ")}) — not awaited by the code. Any not yet sent to Figma were dropped; one already sent may still land. Await every figma.* call.`,
      );
    }
    for (const w of late) if (!warnings.includes(w)) warnings.push(w);
  }
  if (logDropped > 0) logs.push(`… ${logDropped} more log line${logDropped === 1 ? "" : "s"} truncated`);

  if (msg === null) {
    const writing = pendingAtDeadline.filter(isMutatingMethod);
    return {
      ok: false,
      logs,
      warnings,
      error: terminated
        ? {
            code: ErrorCode.PLUGIN_TIMEOUT,
            message: `figma_write exceeded the ${timeoutMs}ms budget — the sandbox worker was terminated.`,
            hint: pendingAtDeadline.length
              ? `The budget ran out while waiting on ${[...new Set(pendingAtDeadline)].map((m) => `figma.${m}`).join(", ")} — Figma was slow, not your code.${
                  writing.length
                    ? " An op already sent to Figma was NOT cancelled and may well have landed: do NOT simply retry — check with figma_read (get_page_model / get_design_context) first, then continue from what is there."
                    : ""
                } Split the work across calls; figma_status shows whether the window is throttled.`
              : "A synchronous loop after an await, or an awaited promise that never settles, can block the sandbox — bound every loop, or split the work across calls.",
          }
        : {
            code: ErrorCode.SANDBOX_ERROR,
            message: "figma_write worker exited without a result.",
            hint: "Retry the call; if it persists, the sandbox worker crashed on this code.",
          },
    };
  }
  if (!msg.ok) {
    return {
      ok: false,
      logs,
      warnings,
      error: msg.error ?? { code: ErrorCode.SANDBOX_ERROR, message: "figma_write failed." },
    };
  }
  return { ok: true, result: msg.result, logs, warnings };
}

/** Heap ceiling for one sandbox worker, MB. */
const WORKER_HEAP_MB = 512;

/** Grace on top of VM_TIMEOUT_MS for worker spawn + the in-worker vm timeout. */
const WORKER_SLACK_MS = 3000;

/**
 * Host-side writes to session.state during one call, numbered so the sandbox
 * can say which ones it has merged into its own copy. See executeWriteInner.
 */
class StateOverlay {
  private seq = 0;
  private sentSeq = 0;
  private readonly entries = new Map<string, { value: unknown; seq: number }>();

  set(key: string, value: unknown): void {
    this.entries.set(key, { value, seq: ++this.seq });
  }

  /** Writes not yet put on an envelope, as the envelope fields the bootstrap
   * merges ({state, stateSeq}); undefined when there are none. */
  takeUnsent(): { state: Record<string, unknown>; stateSeq: number } | undefined {
    if (this.seq === this.sentSeq) return undefined;
    const state: Record<string, unknown> = {};
    for (const [k, e] of this.entries) if (e.seq > this.sentSeq) state[k] = e.value;
    this.sentSeq = this.seq;
    return { state, stateSeq: this.seq };
  }

  /** Re-apply the writes the sandbox never merged onto its synced-back copy. */
  applyUnseen(next: Record<string, unknown>, seenSeq: number): Record<string, unknown> {
    for (const [k, e] of this.entries) if (e.seq > seenSeq) next[k] = e.value;
    return next;
  }
}

/**
 * Positional args off the wire. JSON has no `undefined` — inside an array it
 * becomes null — so the bootstrap lists the undefined slots and they are put
 * back here: a11yAudit(undefined, opts) must reach argsToParams as undefined,
 * not as a null nodeId.
 */
function decodeArgs(wire: unknown): unknown[] {
  if (Array.isArray(wire)) return wire;
  if (isObj(wire) && Array.isArray((wire as Record<string, unknown>).args)) {
    const { args, undef } = wire as { args: unknown[]; undef?: unknown };
    const out = args.slice();
    if (Array.isArray(undef)) {
      for (const i of undef) if (typeof i === "number" && i >= 0 && i < out.length) out[i] = undefined;
    }
    return out;
  }
  return [wire];
}

/** The error message in an invoke envelope, or undefined when it succeeded. */
function parseErrorEnvelope(env: string): string | undefined {
  try {
    const e = JSON.parse(env) as { ok?: boolean; error?: { code?: string; message?: string } };
    if (e.ok === true) return undefined;
    return `${e.error?.code ?? "ERROR"}: ${e.error?.message ?? "failed"}`;
  } catch {
    return undefined;
  }
}

/** Sandbox methods that only read — a timeout while one runs left nothing half-drawn. */
const READ_ONLY_METHODS = new Set(["searchIcons", "getChildren", "useComponentMap"]);

/** Whether a sandbox method can change the document (decides the timeout hint). */
function isMutatingMethod(method: string): boolean {
  if (READ_ONLY_METHODS.has(method)) return false;
  const op = Object.hasOwn(METHOD_TO_OP, method) ? METHOD_TO_OP[method] : undefined;
  return op ? !isReadOp(op) : true;
}

/**
 * The sandbox bootstrap, run inside the worker's vm context before user code.
 * See the realm-boundary comment in executeWriteInner for why it is shaped
 * this way; the only worker-specific part is that the figma surface arrives
 * as data (`__figmaMethods`/`__figmaData`) instead of a host object.
 */
const BOOTSTRAP_SRC = `(() => {
  // Capture context intrinsics BEFORE they are shadowed below.
  const CtxObjectProto = Object.prototype;
  const CtxFunctionProto = Function.prototype;
  const __inv = __invoke;
  const methods = __figmaMethods;
  const dataJson = __figmaData;
  const stateJson = __stateData;

  // Outside values that must not stay reachable — an outside function's
  // return value is an outside object, and .constructor.constructor on any
  // outside value is the worker realm's Function (realm escape).
  __invoke = undefined;
  __figmaMethods = undefined;
  __figmaData = undefined;
  __stateData = undefined;

  // Banned globals as context-realm stubs — a thrown Error must be
  // context-realm or it leaks the worker realm.
  const ban = (name) => () => {
    const e = new Error('"' + name + '" is not available in figma_write.');
    e.code = "SANDBOX_ERROR";
    e.hint = "Sandbox bans require/process/fetch/timers/eval. Use figma.* ops and plain JS only.";
    throw e;
  };
  require = ban("require");
  process = ban("process");
  fetch = ban("fetch");
  setTimeout = ban("setTimeout");
  setInterval = ban("setInterval");
  setImmediate = ban("setImmediate");
  eval = ban("eval");
  Function = ban("Function");
  globalThis = undefined;

  // A poison constructor: '.constructor' reached on a scrubbed value lands
  // here — a context-realm function, never the outside one. The scrub
  // recursion poisons Poison itself, so Poison.constructor is Poison and the
  // chain dead-ends.
  const Poison = function Poison() { throw new TypeError("blocked"); };
  const seen = new Set();
  const scrub = (v) => {
    if (v === null || (typeof v !== "object" && typeof v !== "function")) return;
    if (seen.has(v)) return;
    seen.add(v);
    try { Object.setPrototypeOf(v, typeof v === "function" ? CtxFunctionProto : CtxObjectProto); } catch (_) {}
    try {
      Object.defineProperty(v, "constructor", {
        value: Poison, writable: false, enumerable: false, configurable: false,
      });
    } catch (_) {}
    for (const k of Object.getOwnPropertyNames(v)) {
      let d; try { d = Object.getOwnPropertyDescriptor(v, k); } catch (_) { continue; }
      if (!d) continue;
      if (d.value && (typeof d.value === "object" || typeof d.value === "function")) scrub(d.value);
      if (typeof d.get === "function") scrub(d.get);
      if (typeof d.set === "function") scrub(d.set);
    }
  };
  scrub(console);
  scrub(__syncState);
  scrub(__inv);

  // state: a context-realm copy of the session object. The wrapped IIFE
  // syncs it back to the parent in 'finally' via __syncState.
  try { state = JSON.parse(stateJson || "{}"); } catch (_) { state = {}; }
  if (state === null || typeof state !== "object" || Array.isArray(state)) state = {};

  // Host-side state writes (setupTokens -> state.tokens) arrive on invoke
  // envelopes and are merged into 'state' at once; the sync reports the
  // highest one merged so the parent re-applies only writes never seen here.
  let seenSeq = 0;
  const rawSync = __syncState;
  __syncState = (json) => rawSync(json, seenSeq);

  // figma: every method becomes a context-realm async wrapper around the
  // relay. The Promise __inv returns is awaited INSIDE the wrapper and never
  // reaches user code; only the resolved JSON string (a primitive — no
  // prototype chain, nothing to escape through) crosses.
  const callMethod = async (m, args) => {
    // JSON turns an undefined arg into null; name those slots so the host
    // puts undefined back (a11yAudit(undefined, opts) is not a null nodeId).
    const undef = [];
    for (let i = 0; i < args.length; i++) if (args[i] === undefined) undef.push(i);
    const env = JSON.parse(await __inv(m, JSON.stringify({ args, undef })));
    if (env && env.state && typeof env.state === "object" && state !== null && typeof state === "object") {
      for (const k of Object.keys(env.state)) state[k] = env.state[k];
      if (typeof env.stateSeq === "number" && env.stateSeq > seenSeq) seenSeq = env.stateSeq;
    }
    if (env && env.ok === true) return env.result;
    const info = (env && env.error) || {};
    const err = new Error(typeof info.message === "string" ? info.message : ("figma." + m + " failed"));
    if (typeof info.code === "string") err.code = info.code;
    if (typeof info.hint === "string") err.hint = info.hint;
    throw err;
  };
  const rebuilt = {};
  for (const m of methods) {
    rebuilt[m] = ((mm) => (...args) => callMethod(mm, args))(m);
  }
  try {
    const data = JSON.parse(dataJson || "{}");
    for (const k of Object.keys(data)) rebuilt[k] = data[k];
  } catch (_) {}
  try {
    Object.defineProperty(rebuilt, "constructor", {
      value: Poison, writable: false, enumerable: false, configurable: false,
    });
    Object.defineProperty(state, "constructor", {
      value: Poison, writable: false, enumerable: false, configurable: false,
    });
  } catch (_) {}
  // Unknown-method trap, mirroring the host proxy's DX guard: an unknown name
  // resolves to a wrapper so the host-side stub produces the mapped,
  // actionable error. Non-call probes (then/toJSON/symbols) stay undefined so
  // normal JS semantics hold.
  figma = new Proxy(rebuilt, {
    get(t, prop) {
      if (typeof prop === "symbol") return Reflect.get(t, prop);
      const v = t[prop];
      if (v !== undefined) return v;
      if (prop === "then" || prop === "toJSON" || prop === "constructor" || prop === "inspect") {
        return undefined;
      }
      return (...args) => callMethod(String(prop), args);
    },
  });
})();`;

/**
 * The worker program, evaluated via `new Worker(src, { eval: true })` — plain
 * CJS JS, no imports, because eval workers cannot load the repo's ESM/TS.
 * Embedding it keeps ONE source of truth for the sandbox rules (BOOTSTRAP_SRC
 * is shared verbatim) and lets the same path run in tests, where no dist/
 * bundle exists to point a Worker at.
 */
/**
 * What one figma_write may print. Generous for debugging — a few hundred
 * node summaries — and small enough that a runaway loop cannot turn the tool
 * result into megabytes the model has to read.
 */
export const MAX_LOG_LINES = 1000;
export const MAX_LOG_CHARS = 100_000;
export const MAX_LOG_LINE_CHARS = 10_000;

export const WRITE_WORKER_SOURCE = `(function () {
  "use strict";
  const { parentPort, workerData } = require("node:worker_threads");
  const vm = require("node:vm");
  const VM_TIMEOUT_MS = ${VM_TIMEOUT_MS};
  const BOOTSTRAP_SRC = ${JSON.stringify(BOOTSTRAP_SRC)};
  const { code, stateJson, figmaMethods, figmaDataJson } = workerData;
  const TIMEOUT_MS =
    typeof workerData.timeoutMs === "number" && workerData.timeoutMs > 0
      ? workerData.timeoutMs
      : VM_TIMEOUT_MS;

  // ---- invoke relay: the one JSON-RPC channel to the parent ----
  const pending = new Map();
  let seq = 0;
  parentPort.on("message", (m) => {
    if (m && m.t === "r") {
      const p = pending.get(m.seq);
      if (p) {
        pending.delete(m.seq);
        p(m.env);
      }
    }
  });
  const invoke = (method, argsJson) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      parentPort.postMessage({ t: "invoke", seq: id, method, argsJson });
    });
  const syncState = (json, seq) =>
    parentPort.postMessage({ t: "state", json, seq: typeof seq === "number" ? seq : 0 });

  // console lines stream to the parent so partial output survives a wedge —
  // on termination the caller still sees how far the code got.
  const post = (m) => {
    try {
      parentPort.postMessage(m && m.t === "done" ? Object.assign({}, m, { logDropped }) : m);
    } catch (_) {}
  };
  let serToText = (v) => {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  const fmtArgs = (a) => a.map((x) => (typeof x === "string" ? x : serToText(x))).join(" ");
  // Logs are capped HERE, before they cost a message: a loop that logs every
  // node of a big page would otherwise ship megabytes to the parent and into
  // the tool result. Past the cap a line is not even formatted — serializing
  // an object nobody will see is the expensive part. The dropped count rides
  // on the done message (exact) and on a throttled update, so a worker killed
  // mid-flood still leaves the caller a marker, if a low one.
  const MAX_LOG_LINES = ${MAX_LOG_LINES};
  const MAX_LOG_CHARS = ${MAX_LOG_CHARS};
  const MAX_LOG_LINE_CHARS = ${MAX_LOG_LINE_CHARS};
  let logLines = 0;
  let logChars = 0;
  let logDropped = 0;
  const emit = (prefix, a) => {
    if (logLines >= MAX_LOG_LINES || logChars >= MAX_LOG_CHARS) {
      logDropped++;
      if (logDropped === 1 || logDropped % 1000 === 0) post({ t: "log-dropped", n: logDropped });
      return;
    }
    let line = prefix + fmtArgs(a);
    if (line.length > MAX_LOG_LINE_CHARS) {
      line = line.slice(0, MAX_LOG_LINE_CHARS) + "… (" + (line.length - MAX_LOG_LINE_CHARS) + " more chars)";
    }
    logLines++;
    logChars += line.length;
    post({ t: "log", line });
  };
  const console_ = {
    log: (...a) => emit("", a),
    info: (...a) => emit("", a),
    warn: (...a) => emit("WARN: ", a),
    error: (...a) => emit("ERROR: ", a),
    debug: (...a) => emit("", a),
  };

  // Explicit, minimal global surface — the same list the in-process sandbox
  // used; anything not listed is undefined inside the context.
  const sandbox = {
    __invoke: invoke,
    __syncState: syncState,
    __stateData: stateJson,
    __figmaMethods: figmaMethods,
    __figmaData: figmaDataJson,
    console: console_,
    figma: undefined,
    state: undefined,
    require: undefined,
    process: undefined,
    fetch: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    globalThis: undefined,
    // eval/Function intentionally NOT pre-shadowed: the bootstrap needs the
    // real context Function.prototype before installing its stubs.
  };
  const context = vm.createContext(sandbox, { name: "figma_write" });
  new vm.Script(BOOTSTRAP_SRC, { filename: "figma_write.bootstrap.js" }).runInContext(context);

  // Context-bounded stringify of values leaving the sandbox: a hostile
  // toJSON/getter must not run unbounded on the worker loop either (bounded
  // here, and the parent can still terminate the whole worker).
  const serScript = new vm.Script("JSON.stringify(__serArg)", { filename: "figma_write.serialize.js" });
  const serInContext = (v) => {
    sandbox.__serArg = v;
    try {
      const s = serScript.runInContext(context, { timeout: TIMEOUT_MS });
      return typeof s === "string" ? s : undefined;
    } finally {
      sandbox.__serArg = undefined;
    }
  };
  serToText = (v) => {
    try {
      return serInContext(v) ?? "[unserializable value]";
    } catch {
      return "[unserializable value]";
    }
  };
  const serResult = (v) => {
    if (v === undefined) return undefined;
    try {
      const s = serInContext(v);
      return s === undefined ? "[unserializable result]" : JSON.parse(s);
    } catch {
      return "[unserializable result]";
    }
  };

  // Async IIFE: top-level await + returns work; finally syncs state back even
  // when the code throws. Strict mode makes a bare call's this undefined.
  const wrapped =
    '(async function () {\\n"use strict";\\n' +
    'try {\\nreturn await (async function () {\\n' + code + '\\n})();\\n' +
    '} finally {\\ntry { __syncState(JSON.stringify(state)); } catch (_) {}\\n}\\n' +
    '}).call(undefined)';

  let script;
  try {
    script = new vm.Script(wrapped, { filename: "figma_write.js" });
  } catch (e) {
    post({
      t: "done",
      ok: false,
      error: {
        code: "SANDBOX_ERROR",
        message: "Syntax error in figma_write code: " + (e && e.message ? e.message : String(e)),
        hint: "Fix the JavaScript syntax. Modern ES (?., ??, spread, async/await) is supported.",
      },
    });
    return;
  }

  (async function () {
    try {
      const result = await script.runInContext(context, { timeout: TIMEOUT_MS });
      post({ t: "done", ok: true, result: serResult(result) });
    } catch (err) {
      const ce = err || {};
      const message = typeof ce.message === "string" ? ce.message : String(err);
      const ctxCode = typeof ce.code === "string" ? ce.code : undefined;
      const ctxHint = typeof ce.hint === "string" ? ce.hint : undefined;
      const isTimeout = /Script execution timed out/i.test(message) || ctxCode === "ERR_SCRIPT_EXECUTION_TIMEOUT";
      post({
        t: "done",
        ok: false,
        error: {
          // A vm timeout must surface as PLUGIN_TIMEOUT — Node tags the thrown
          // error with code "ERR_SCRIPT_EXECUTION_TIMEOUT", which is a host
          // detail, not a user ErrorCode.
          code: isTimeout ? "PLUGIN_TIMEOUT" : ctxCode !== undefined ? ctxCode : "SANDBOX_ERROR",
          message: isTimeout ? "figma_write exceeded the " + TIMEOUT_MS + "ms budget." : message,
          hint: isTimeout
            ? "Split the work across multiple figma_write calls or use figma.batch() for many similar ops."
            : ctxHint !== undefined
              ? ctxHint
              : "The error is from your code or a figma op — check the message and figma_docs(section=\\"api\\").",
        },
      });
    }
  })();
})();`;

function buildFigmaProxy(
  session: Session,
  deps: ExecutorDeps,
  warnings: string[],
  stateOverlay: StateOverlay,
): Record<string, unknown> {
  // One figma_write call is one placement group: when its screens have to
  // move clear of existing work, they move together and stay a row.
  const placeGroup = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const call = async (op: AnyOperation, params: Record<string, unknown>): Promise<unknown> => {
    maybeNudgePalette(op, params, session, warnings);
    const res = await deps.runOp(op, withPlaceGroup(op, params, placeGroup));
    // Dedupe: the same safe-default warning fires on every node of a large
    // draw, and N identical copies teach the agent nothing the first one did
    // not — they just cost tokens.
    if (res.warnings?.length) {
      for (const w of res.warnings) if (!warnings.includes(w)) warnings.push(w);
    }
    if (!res.ok) {
      const e = res.error ?? { code: ErrorCode.INTERNAL, message: `Operation ${op} failed.` };
      throw new OpError(e.code, e.message, e.hint);
    }
    return res.result;
  };

  const proxy: Record<string, unknown> = {};

  // Sentinel matching the serializer's "mixed" marker, so sandbox code can
  // write `if (node.fontSize === figma.mixed)` like the official plugin API.
  // (Previously undefined, which made `x === figma.mixed` true for every
  // missing property — a lie generator.)
  proxy["mixed"] = "mixed";

  for (const [method, op] of Object.entries(METHOD_TO_OP)) {
    if (method === "batch") continue; // custom below
    if (method === "getChildren") {
      // No dedicated op; derive from get_node's children in the plugin. We
      // forward a get_node with { includeChildren: true } convention and
      // return the children ARRAY (not the {node, children} wrapper) so
      // `for (const kid of await figma.getChildren(id))` just works.
      proxy[method] = async (nodeId: string) => {
        const res = (await call("get_node", { nodeId, includeChildren: true })) as
          | { children?: unknown[] }
          | undefined;
        return flattenNodes(res?.children ?? []);
      };
      continue;
    }
    if (method === "getNode" || method === "getNodeById") {
      // get_node returns { node, children? }; unwrap to the flat node object
      // (with width/height aliases and children merged in) so sandbox code
      // can read `n.name` / `n.width` like the official plugin API instead
      // of unwrapping a transport envelope.
      proxy[method] = async (...args: unknown[]) => {
        const res = (await call("get_node", argsToParams("get_node", args))) as
          | { node?: Record<string, unknown>; children?: unknown[] }
          | undefined;
        if (!res?.node) return res;
        const flat = flattenNode(res.node);
        if (res.children) flat.children = flattenNodes(res.children);
        return flat;
      };
      continue;
    }
    if (method === "currentPage") {
      proxy[method] = async () => call("get_document_info", { scope: "page" });
      continue;
    }
    proxy[method] = async (...args: unknown[]) => call(op, argsToParams(op, args));
  }

  // batch: chunked streaming with partial commit + exact per-index errors.
  // Optional opts.resultDetail:"ids" trims each successful item's result to
  // just its node id — for large create batches where the agent only needs the
  // ids back, this avoids echoing a full serialized node per item.
  proxy["batch"] = async (
    ops: Array<{ op: string; params: Record<string, unknown> }>,
    opts?: { resultDetail?: "full" | "ids" },
  ) =>
    runBatch(
      Array.isArray(ops) ? ops.map((o) => (o && isObj(o.params) ? { ...o, params: withPlaceGroup(o.op as AnyOperation, o.params, placeGroup) } : o)) : ops,
      deps,
      warnings,
      isObj(opts) && opts.resultDetail === "ids" ? "ids" : "full",
    );

  // setupTokens: run the plugin op, then cache the resulting token map into
  // session.state.tokens so later figma_write calls can look tokens up by name
  // without re-declaring them — the behaviour the docs promise. The plugin
  // owns the Figma Variables; state.tokens is the in-session convenience map.
  proxy["setupTokens"] = async (tokensJson: Record<string, unknown>) => {
    const result = (await call("setup_tokens", { tokens: tokensJson })) as
      | Record<string, unknown>
      | undefined;
    const existing =
      (session.state.tokens as Record<string, unknown> | undefined) ?? {};
    const map = mergeTokenMap(existing, tokensJson, result);
    session.state.tokens = map;
    // The sandbox works on a context-realm copy of state: the overlay carries
    // this write into it on the next envelope and keeps the exit sync from
    // dropping it.
    stateOverlay.set("tokens", map);
    return result;
  };

  // Icons: searchIcons is server-side (no fetch); loadIcon fetches the SVG
  // server-side, then forwards the load_icon op to the plugin with `svg`.
  proxy["searchIcons"] = (query: string) => searchIconsSvc(query);
  proxy["loadIcon"] = async (name: string, opts?: Record<string, unknown>) =>
    call("load_icon", await resolveIconParams({ ...(isObj(opts) ? opts : {}), name }, deps));


  // userflow: the graph is the AGENT's analysis of the spec (screens, happy
  // path, error and edge cases). The layout runs server-side and the plugin
  // only draws; graph findings come back as warnings so the next pass can fill
  // the holes the arrows just made visible.
  proxy["userflow"] = async (spec: unknown) => {
    // `call` unwraps the bridge response, so plugin warnings land in the
    // sandbox-wide sink rather than in the value returned here. Fold whatever
    // this call added back into the result, so `figma.userflow(...)` and the
    // figma_diagram tool report the same findings in the same place.
    const before = warnings.length;
    const res = await runUserflow(spec, call, warnings);
    const merged = res.warnings.slice();
    for (const w of warnings.slice(before)) if (!merged.includes(w)) merged.push(w);
    return { ...res, warnings: merged };
  };


  // loadImage: accept a URL (fetched server-side, like icons), a data: URI, or
  // raw base64. Previously only base64 worked and a URL crashed the plugin with
  // a cryptic atob() error; now the server resolves the URL to base64 before
  // forwarding, matching the documented loadImage(url|base64) contract.
  proxy["loadImage"] = async (source: unknown, opts?: Record<string, unknown>) =>
    call("load_image", { base64: await resolveImageSource(source, deps), ...(isObj(opts) ? opts : {}) });

  // Code ↔ Figma component map. The map lives in the CODEBASE (the agent reads
  // it and hands it over once per session); render() translates code props to
  // the Figma variant/properties and instantiates — same component, same
  // variant, same property keys as the code says.
  proxy["useComponentMap"] = (map: unknown) => {
    if (!isObj(map) || !isObj((map as Record<string, unknown>).components)) {
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        "useComponentMap expects { components: { CodeName: { figma, props?, children? } } }.",
        "Start one with figma.exportComponentMap(), save it in the codebase, then pass it here.",
      );
    }
    session.state.componentMap = map;
    stateOverlay.set("componentMap", map);
    return { components: Object.keys((map as ComponentMap).components).length };
  };
  proxy["render"] = async (codeName: string, props?: Record<string, unknown>, opts?: Record<string, unknown>) => {
    const { map: inline, ...rest } = isObj(opts) ? (opts as Record<string, unknown>) : {};
    const map = (inline ?? session.state.componentMap) as ComponentMap | undefined;
    if (!map || !isObj(map.components)) {
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        "No component map in this session.",
        "Call figma.useComponentMap(map) first (or pass { map } as the third argument).",
      );
    }
    let t: Translated;
    try {
      t = translateProps(map, codeName, isObj(props) ? props : {});
    } catch (e) {
      throw new OpError(ErrorCode.INVALID_PARAMS, (e as Error).message, "Add it to the map, or render a name the map has.");
    }
    if (t.unmapped.length) {
      const w = `render(${codeName}): props not in the map, ignored — ${t.unmapped.join(", ")}.`;
      if (!warnings.includes(w)) warnings.push(w);
    }
    return call("instantiate", {
      component: t.component,
      ...(Object.keys(t.variant).length ? { variant: t.variant } : {}),
      ...(Object.keys(t.properties).length ? { properties: t.properties } : {}),
      ...rest,
    });
  };

  // Official-plugin-API muscle memory → the sandbox equivalent. Each entry is
  // a method agents reach for reflexively; calling it explains the mapping
  // instead of dying with a bare "not a function".
  const API_MAPPINGS: Record<string, string> = {
    getNodeByIdAsync: "await figma.getNode(id)",
    createFrame: 'await figma.create({ type: "FRAME", ... })',
    createText: 'await figma.create({ type: "TEXT", characters: "...", ... })',
    createRectangle: 'await figma.create({ type: "RECTANGLE", ... })',
    createEllipse: 'await figma.create({ type: "ELLIPSE", ... })',
    createComponent: 'await figma.create({ type: "COMPONENT", ... }), or figma.findOrCreateComponent(name, spec) to reuse one by name',
    createComponentFromNode: "await figma.componentize(nodeId, { replaceCopies? })",
    combineAsVariants: "await figma.createVariants({ name, variants: [{ props, spec }] | componentIds })",
    detachInstanceAsync: "await figma.detachInstance(instanceId)",
    appendChild: "pass parentId in the create() spec, or figma.move(nodeId, { parentId })",
    insertChild: "pass parentId + insertAt in the create() spec, or figma.move(nodeId, { parentId, insertAt })",
    loadFontAsync: "not needed — create/modify load fonts automatically (fontName: { family, style })",
    getLocalPaintStylesAsync: "await figma.getStyles()",
    getLocalTextStylesAsync: "await figma.getStyles()",
    notify: "console.log(...) — logs are returned to the caller",
    closePlugin: "not applicable in this sandbox",
  };

  // Unknown-method guard: `figma.somethingElse(...)` returns a function that
  // throws a descriptive, actionable error instead of the engine's bare
  // TypeError. Non-call property probes (await's `then`, JSON.stringify's
  // `toJSON`, symbols) must stay undefined so normal JS semantics hold.
  const knownMethods = Object.keys(proxy).filter((k) => typeof proxy[k] === "function");
  return new Proxy(proxy, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (prop === "then" || prop === "toJSON" || prop === "constructor" || prop === "inspect") {
        return undefined;
      }
      const name = String(prop);
      const mapped = API_MAPPINGS[name];
      const close = nearestMethods(name, knownMethods);
      return () => {
        throw new OpError(
          ErrorCode.SANDBOX_ERROR,
          `figma.${name} is not a sandbox method.`,
          mapped
            ? `In this sandbox use: ${mapped}.`
            : `${close.length ? `Did you mean: ${close.join(", ")}? ` : ""}See figma_docs(section="api") for the full method list.`,
        );
      };
    },
  }) as unknown as Record<string, unknown>;
}

/** Cheap fuzzy match: known methods sharing a prefix or substring with `name`. */
function nearestMethods(name: string, known: string[]): string[] {
  const lower = name.toLowerCase();
  const scored = known
    .map((k) => {
      const kl = k.toLowerCase();
      let score = 0;
      if (kl === lower) score = 100;
      else if (kl.includes(lower) || lower.includes(kl)) score = 50;
      else {
        // shared prefix length
        let i = 0;
        while (i < Math.min(kl.length, lower.length) && kl[i] === lower[i]) i++;
        score = i >= 4 ? i : 0;
      }
      return { k, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((s) => s.k);
}

/**
 * Build the in-session token map (name → { value, variableId? }) the docs
 * promise at state.tokens. Values come from the input tokensJson; variable ids
 * come from the plugin result when present. Merges with any existing map so
 * repeated setupTokens calls accumulate.
 */
function mergeTokenMap(
  existing: Record<string, unknown>,
  tokensJson: Record<string, unknown>,
  _result: unknown,
): Record<string, unknown> {
  const map: Record<string, unknown> = { ...existing };
  for (const group of ["colors", "numbers", "strings"]) {
    const entries = (tokensJson as Record<string, unknown>)[group];
    if (entries && typeof entries === "object") {
      for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
        map[name] = value;
      }
    }
  }
  return map;
}

const MAX_IMAGE_REDIRECTS = 3;

/** One HTTP hop: never follows a redirect itself. */
export type ImageFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Fetch with redirects handled by hand. assertSafeImageUrl only vets the URL
 * it is given; letting fetch follow a 302 on its own would let any public
 * https host bounce the request to 169.254.169.254 or an intranet name. So
 * every Location is resolved against the hop that sent it and vetted again,
 * and a chain longer than a few hops is refused rather than chased.
 *
 * Every hop's HOST is resolved and vetted too, not just its spelling — a
 * public name with an A record of 127.0.0.1 is the same request as the
 * literal. That check runs whatever the transport; the default transport
 * then pins the socket to addresses vetted at connect time, which is what
 * actually defeats a rebinding answer between the two lookups.
 */
export async function fetchImageFollowingSafeRedirects(
  url: string,
  fetchImpl?: ImageFetch,
  resolveHost: HostResolver = defaultHostResolver,
  /** The calling figma_write's signal: the download stops when it stops waiting. */
  signal?: AbortSignal,
): Promise<Response> {
  const transport: ImageFetch = fetchImpl ?? ((u, init) => pinnedHttpsFetch(u, init, resolveHost));
  let current = assertSafeImageUrl(url);
  for (let hop = 0; ; hop++) {
    if (signal?.aborted) throw new Error("Image download cancelled — the call that asked for it stopped waiting.");
    await assertHostResolvesPublic(current.hostname, resolveHost);
    const res = await transport(current.href, { redirect: "manual", ...(signal ? { signal } : {}) });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    // The redirect's own body is never read; release its socket.
    await res.body?.cancel().catch(() => {});
    if (hop >= MAX_IMAGE_REDIRECTS) {
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        `Image URL redirected more than ${MAX_IMAGE_REDIRECTS} times.`,
        "Pass the final image URL directly, or base64 bytes.",
      );
    }
    current = assertSafeImageUrl(new URL(location, current.href).href);
  }
}

/** Statuses a Response may not carry a body with. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * One https GET whose socket can only reach a vetted address.
 *
 * Global fetch resolves the host itself, AFTER our check, and a rebinding
 * name answers public to the first lookup and 127.0.0.1 to the second. Node's
 * bundled fetch does not expose a connect-time lookup hook without adding the
 * undici package, but node:https does: `lookup` here is the only resolver the
 * socket consults, so the address it connects to is one this function just
 * refused to hand over unless it was public. A 3xx is returned unread (the
 * caller follows it by hand), never followed.
 */
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const IMAGE_FETCH_TOTAL_MS = 60_000;
/** Figma rejects images past 20MB; nothing bigger is worth buffering. */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export function pinnedHttpsFetch(
  url: string,
  init: RequestInit,
  resolveHost: HostResolver = defaultHostResolver,
): Promise<Response> {
  const lookup: LookupFunction = (hostname, options, callback) => {
    assertHostResolvesPublic(hostname, resolveHost).then(
      (addresses) => {
        const family = typeof options.family === "number" ? options.family : 0;
        const usable = family ? addresses.filter((a) => a.family === family) : addresses;
        if (!usable.length) {
          const err = Object.assign(new Error(`No IPv${family} address for ${hostname}`), { code: "ENOTFOUND" });
          callback(err, "", 0);
          return;
        }
        if (options.all) (callback as unknown as (e: null, a: typeof usable) => void)(null, usable);
        else callback(null, usable[0]!.address, usable[0]!.family);
      },
      (err: Error) => callback(err as NodeJS.ErrnoException, "", 0),
    );
  };
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(total);
      init.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (err: unknown) => done(() => reject(err));
    // Headers a browser-less client needs to be served at all: some image
    // hosts (Wikimedia) answer 403 to a request with no User-Agent, which the
    // bundled fetch used to send for us.
    const req = httpsRequest(
      url,
      {
        method: "GET",
        lookup,
        headers: { "user-agent": `figma-plugin/${VERSION}`, accept: "image/*,*/*;q=0.8" },
      },
      (res) => {
        // Everything in here runs outside the promise: a throw would be an
        // uncaught exception that kills the server. `new Response` throws on a
        // status outside 200–599, which any host can send.
        try {
          const status = res.statusCode ?? 502;
          if (status < 200 || status > 599) {
            res.destroy();
            fail(new Error(`Image host answered with an invalid HTTP status ${status}.`));
            return;
          }
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
          }
          if ((status >= 300 && status < 400) || NULL_BODY_STATUS.has(status)) {
            res.destroy();
            done(() => resolve(new Response(null, { status, headers })));
            return;
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) {
            res.destroy();
            fail(tooLarge());
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > IMAGE_MAX_BYTES) {
              res.destroy();
              fail(tooLarge());
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => done(() => resolve(new Response(Buffer.concat(chunks), { status, headers }))));
          res.on("error", fail);
        } catch (err) {
          res.destroy();
          fail(err);
        }
      },
    );
    // A refusal from the lookup hook arrives here as the OpError it threw,
    // so fetchImageAsBase64 reports it as-is instead of "Could not fetch".
    req.on("error", fail);
    // The socket timeout only notices silence; a host trickling one byte at a
    // time never trips it. The total deadline bounds the whole download.
    req.setTimeout(IMAGE_FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`Image host did not answer within ${IMAGE_FETCH_TIMEOUT_MS / 1000}s.`));
    });
    const total = setTimeout(() => {
      req.destroy();
      fail(new Error(`Image download took longer than ${IMAGE_FETCH_TOTAL_MS / 1000}s.`));
    }, IMAGE_FETCH_TOTAL_MS);
    total.unref?.();
    // The figma_write that asked stopped waiting: stop downloading too.
    const onAbort = () => {
      req.destroy();
      fail(new Error("Image download cancelled — the call that asked for it stopped waiting."));
    };
    if (init.signal?.aborted) onAbort();
    else init.signal?.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

function tooLarge(): OpError {
  return new OpError(
    ErrorCode.INVALID_PARAMS,
    `Image is larger than ${IMAGE_MAX_BYTES / 1024 / 1024}MB.`,
    "Pass a smaller image (Figma downscales past 4096px anyway), or base64 bytes of a resized copy.",
  );
}

/** Fetch an image URL and return its base64 body. An optional imageFetcher on
 * deps lets tests supply bytes without hitting the network. */
async function fetchImageAsBase64(url: string, deps: ExecutorDeps): Promise<string> {
  const safe = assertSafeImageUrl(url);
  try {
    if (deps.imageFetcher) return await deps.imageFetcher(safe.href, deps.signal ? { signal: deps.signal } : undefined);
    const res = await fetchImageFollowingSafeRedirects(safe.href, deps.imageFetch, deps.resolveHost, deps.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString("base64");
  } catch (e) {
    // A blocked redirect hop is already a precise INVALID_PARAMS — keep its
    // message instead of burying it under "Could not fetch".
    if (e instanceof OpError) throw e;
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Could not fetch image from URL: ${(e as Error).message}`,
      "Check the URL is reachable and points at an image, or pass base64 bytes directly.",
    );
  }
}

/**
 * loadImage's source → the base64 the plugin decodes: an http(s) URL is
 * fetched here (public hosts only), a data: URI is stripped to its payload,
 * anything else is taken as base64 already. Shared by figma.loadImage and
 * load_image items inside figma.batch.
 */
async function resolveImageSource(source: unknown, deps: ExecutorDeps): Promise<string> {
  if (typeof source !== "string" || source.length === 0) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      "loadImage requires a URL, a data: URI, or a base64 string.",
      "Pass an https URL (public hosts only), a data:image/...;base64,... URI, or raw base64 bytes.",
    );
  }
  if (/^https?:\/\//i.test(source)) return fetchImageAsBase64(source, deps);
  if (source.startsWith("data:")) {
    const comma = source.indexOf(",");
    return comma >= 0 ? source.slice(comma + 1) : source;
  }
  return source;
}

/**
 * load_icon params with the SVG fetched server-side: { name, library?, ...rest }
 * → { ...rest, name, canonical, library, svg }. Everything else the plugin op
 * honours (size, color, parentId, x, y, inset, align, insertAt) passes through.
 */
async function resolveIconParams(
  params: Record<string, unknown>,
  deps: ExecutorDeps,
): Promise<Record<string, unknown>> {
  const { library, name, ...rest } = params;
  if (typeof name !== "string" || name.trim() === "") {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      "loadIcon requires an icon name.",
      'e.g. figma.loadIcon("check", { size: 20, parentId }). searchIcons("…") lists candidate names.',
    );
  }
  const loaded = await loadIconSvg(name, {
    ...(typeof library === "string" && library ? { library: library as IconLibrary } : {}),
    ...(deps.iconFetcher ? { fetcher: deps.iconFetcher } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  return { ...rest, name, canonical: loaded.canonical, library: loaded.library, svg: loaded.svg };
}

/**
 * Batch items whose op is answered partly on the server: the plugin cannot
 * fetch, so a load_image URL / data: URI and a load_icon by name are resolved
 * here, exactly as figma.loadImage / figma.loadIcon do, before validation.
 */
async function resolveBatchItemParams(
  op: unknown,
  params: Record<string, unknown>,
  deps: ExecutorDeps,
): Promise<Record<string, unknown>> {
  if (op === "load_image") {
    const { source, url, base64, ...rest } = params;
    const src = base64 ?? source ?? url;
    if (typeof src !== "string") return params;
    // Raw base64 needs nothing; a URL or data: URI goes through loadImage's path.
    if (src === base64 && !/^https?:\/\//i.test(src) && !src.startsWith("data:")) return params;
    return { ...rest, base64: await resolveImageSource(src, deps) };
  }
  if (op === "load_icon" && (typeof params.svg !== "string" || params.svg.length === 0)) {
    if (typeof params.name !== "string" || params.name.trim() === "") {
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        "load_icon in a batch needs an icon name (or raw svg).",
        'Pass { op: "load_icon", params: { name: "check", size?, parentId? } }, or call figma.loadIcon(name, opts) outside the batch.',
      );
    }
    return resolveIconParams(params, deps);
  }
  return params;
}

/**
 * Map positional call args to the op's params object. Most write ops take a
 * single object spec; the mutation ops take (nodeId, props-ish). Validation in
 * validateOperation is the authority — this only shapes ergonomics.
 */
function argsToParams(op: AnyOperation, args: unknown[]): Record<string, unknown> {
  const first = args[0];
  const second = args[1];
  switch (op) {
    case "modify":
      return { nodeId: first, props: second };
    case "delete":
      return isObj(first) ? (first as Record<string, unknown>) : { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "clone":
    case "move":
    case "resize":
    case "ungroup":
    case "flatten":
    case "zoom_to_fit":
    case "layout_audit":
    case "export_node":
      // (nodeId, opts) or the documented single bag: exportNode({nodeId, format}).
      return isObj(first)
        ? { ...(first as Record<string, unknown>), ...optsOf(second) }
        : { nodeId: first, ...optsOf(second) };
    case "get_node":
      return { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "get_nodes":
      return { nodeIds: first };
    case "get_component":
      return isObj(first) ? (first as Record<string, unknown>) : { componentId: first };
    case "get_library_component":
      return isObj(first) ? (first as Record<string, unknown>) : { key: first };
    // Components: the first positional arg is what agents reach for — a
    // query, a component name/id, or the node being edited.
    case "find_component":
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first == null
          ? optsOf(second)
          : { query: first, ...optsOf(second) };
    case "find_or_create_component":
      // findOrCreateComponent(name, spec) or ({name, spec})
      return isObj(first)
        ? (first as Record<string, unknown>)
        : { name: first, ...(isObj(second) ? { spec: second } : {}) };
    case "instantiate": {
      // instantiate("Button", {variant, properties, parentId}) / ({component, ...});
      // instantiate("Button", parentId) mirrors create(spec, parentId).
      // instantiate({key}, {parentId, variant}) — a library ref plus opts.
      const opts = isObj(second) ? { ...(second as Record<string, unknown>) } : {};
      if (typeof second === "string" && second.length > 0) opts.parentId = second;
      if (isObj(first)) return { ...(first as Record<string, unknown>), ...opts };
      return { component: first, ...opts };
    }
    case "swap_component":
      // swapComponent(instanceId, "Icon/Check", {variant?}); the component
      // may also be a library ref: swapComponent(id, {key}, {variant?}).
      return isObj(first)
        ? (first as Record<string, unknown>)
        : isObj(second)
          ? { nodeId: first, ...componentRefOf(second as Record<string, unknown>), ...optsOf(args[2]) }
          : { nodeId: first, component: second, ...optsOf(args[2]) };
    case "set_component_description":
      // setComponentDescription(nodeId, "text", {link}) or (nodeId, {description, link})
      return isObj(first)
        ? (first as Record<string, unknown>)
        : isObj(second)
          ? { nodeId: first, ...(second as object) }
          : { nodeId: first, description: second, ...(isObj(args[2]) ? (args[2] as object) : {}) };
    case "edit_component_property":
    case "delete_component_property":
      // (nodeId, property, changes?) or ({nodeId, property, ...})
      return isObj(first)
        ? (first as Record<string, unknown>)
        : { nodeId: first, property: second, ...(isObj(args[2]) ? (args[2] as object) : {}) };
    case "set_instance_properties":
      // setInstanceProperties(nodeId, {Label: "Save"})
      return isObj(first) ? (first as Record<string, unknown>) : { nodeId: first, properties: second };
    case "set_instance_overrides":
      // (nodeId, [{target, props}]) / (nodeId, {from|overrides|properties})
      return isObj(first)
        ? (first as Record<string, unknown>)
        : Array.isArray(second)
          ? { nodeId: first, overrides: second }
          : { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "a11y_audit":
    case "audit_design_system":
    case "apply_design_system":
    case "responsive_audit":
      // auditX(nodeId?, opts?) or auditX({nodeId, ...}); auditX(undefined,
      // opts) audits the selection with those opts.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first == null
          ? optsOf(second)
          : { nodeId: first, ...optsOf(second) };
    case "export_component_map":
      // exportComponentMap("button") / (["Button", "Card"]) / ({query|names})
      return isObj(first)
        ? (first as Record<string, unknown>)
        : Array.isArray(first)
          ? { names: first, ...optsOf(second) }
          : first == null
            ? optsOf(second)
            : { query: first, ...optsOf(second) };
    case "check_component_map":
      // checkComponentMap(map) — the map itself, or {map}
      return isObj(first) && "map" in (first as object) ? (first as Record<string, unknown>) : { map: first };
    case "add_component_property":
    case "componentize":
    case "create_variants":
    case "arrange_component_set":
    case "get_instance_overrides":
    case "expose_nested_instance":
    case "detach_instance":
    case "reset_instance_overrides":
      return isObj(first)
        ? (first as Record<string, unknown>)
        : { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "set_text":
      return { nodeId: first, content: second };
    case "apply_variable":
      return { nodeId: first, field: second, tokenName: args[2] };
    case "setup_tokens":
      return isObj(first) ? (first as Record<string, unknown>) : { tokens: first };
    case "setup_text_styles":
      // setupTextStyles(stylesArray) → {styles}; ({styles: [...]}) passes through.
      return Array.isArray(first)
        ? { styles: first }
        : isObj(first)
          ? (first as Record<string, unknown>)
          : { styles: first };
    case "set_text_style":
      // setTextStyle(nodeId, styleNameOrId) → {nodeId, style}.
      return { nodeId: first, style: second };
    case "setup_effect_styles":
      // setupEffectStyles(stylesArray) → {styles}; ({styles:[...]}) passes through.
      return Array.isArray(first)
        ? { styles: first }
        : isObj(first)
          ? (first as Record<string, unknown>)
          : { styles: first };
    case "create_variable":
      // createVariable(name, valueOrOpts) or createVariable({name, ...})
      return isObj(first)
        ? { ...(first as Record<string, unknown>), ...(isObj(second) ? (second as object) : {}) }
        : { name: first, ...(isObj(second) ? (second as object) : { value: second }) };
    case "update_variable":
    case "delete_variable":
      // (nameOrId, opts) or ({variable, ...})
      return isObj(first)
        ? (first as Record<string, unknown>)
        : { variable: first, ...(isObj(second) ? (second as object) : {}) };
    case "rename_variable":
      return isObj(first)
        ? (first as Record<string, unknown>)
        : { variable: first, newName: second };
    case "export_tokens":
      // exportTokens("css") or exportTokens({format, collection, mode, ...})
      return isObj(first) ? (first as Record<string, unknown>) : first !== undefined ? { format: first } : {};
    case "import_tokens":
      // importTokens(tree, opts) or importTokens({tokens|modes, ...})
      return isObj(first) && ("tokens" in (first as object) || "modes" in (first as object) || "dtcg" in (first as object))
        ? { ...(first as Record<string, unknown>), ...(isObj(second) ? (second as object) : {}) }
        : { tokens: first, ...(isObj(second) ? (second as object) : {}) };
    case "create_page":
      return isObj(first) ? (first as Record<string, unknown>) : { name: first };
    case "delete_page":
      // deletePage(idOrName, {force}) or ({page, force})
      return isObj(first)
        ? (first as Record<string, unknown>)
        : { page: first, ...(isObj(second) ? (second as object) : {}) };
    case "delete_style":
      // deleteStyle(nameOrId, {type, replaceWith, force}) or ({style, ...})
      return isObj(first)
        ? (first as Record<string, unknown>)
        : { style: first, ...(isObj(second) ? (second as object) : {}) };
    case "delete_unused_styles":
      // deleteUnusedStyles() previews; ({confirm, types, keep}) deletes.
      return isObj(first) ? (first as Record<string, unknown>) : {};
    // Demo reels: deleteDemo("id") / getDemoSpec("id"), or the opts bag.
    case "set_current_page":
      return isObj(first) ? (first as Record<string, unknown>) : { pageId: first };
    case "load_image":
      return isObj(first) ? (first as Record<string, unknown>) : { source: first };
    case "group":
      return isObj(first) ? (first as Record<string, unknown>) : { nodeIds: first };
    case "search_nodes":
      return isObj(first) ? (first as Record<string, unknown>) : { query: first };
    case "get_fonts":
      // getFonts(["Inter"]) — documented positional family list; also a bare
      // family name or the {families} bag.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first === undefined
          ? {}
          : { families: Array.isArray(first) ? first : [first] };
    case "screenshot":
      // screenshot({nodeId, scale}) documented; tolerate screenshot("1:2").
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first == null
          ? optsOf(second)
          : { nodeId: first, ...optsOf(second) };
    case "reflow_diagram":
      // reflowDiagram({frameId?}) — tolerate a bare frame id.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first == null
          ? optsOf(second)
          : { frameId: first, ...optsOf(second) };
    case "get_design_context":
      // getDesignContext({nodeId?, detail?, depth?}) — tolerate a bare nodeId.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first == null
          ? optsOf(second)
          : { nodeId: first, ...optsOf(second) };
    case "scan_text_nodes":
      // scanTextNodes({nodeId?, limit?}) — tolerate a bare nodeId.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first == null
          ? optsOf(second)
          : { nodeId: first, ...optsOf(second) };
    case "scan_nodes_by_types":
      // scanNodesByTypes({types?, nodeId?}) — an array arg is the type list,
      // a string arg a scope nodeId.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : Array.isArray(first)
          ? { types: first, ...optsOf(second) }
          : first == null
            ? optsOf(second)
            : { nodeId: first, ...optsOf(second) };
    case "read_selection":
      // readSelection({detail?, depth?}) — tolerate a bare detail string.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : first === undefined
          ? {}
          : { detail: first };
    case "set_selection":
      // setSelection(["1:2", "3:4"]) or setSelection({nodeIds}).
      return isObj(first)
        ? (first as Record<string, unknown>)
        : Array.isArray(first)
          ? { nodeIds: first }
          : first === undefined
            ? {}
            : { nodeIds: [first] };
    // Edit-in-place composite ops — keep the (targetish, opts) ergonomics.
    case "set_selection_colors":
      // setSelectionColors(nodeId, opts) → {nodeId, ...opts}. nodeId is
      // optional (defaults to current selection), so a single object arg is
      // treated as the opts bag directly.
      return isObj(first)
        ? (first as Record<string, unknown>)
        : { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "set_gradient":
      // setGradient(nodeId, opts) → {nodeId, ...opts}.
      return { nodeId: first, ...(isObj(second) ? (second as object) : {}) };
    case "set_effects":
      // setEffects(nodeId, effects) → {nodeId, effects}.
      return { nodeId: first, effects: second };
    case "set_reactions":
      // setReactions(nodeId, reactions) → {nodeId, reactions}.
      return { nodeId: first, reactions: second };
    case "create":
    case "create_overlay": {
      // create(spec) — but also tolerate the natural two-arg shape
      // create(spec, parentId) that agents write reflexively (mirrors
      // parent.appendChild(node) muscle memory). Silently dropping args[1]
      // was how an entire screen's children landed flat on the page.
      const spec = isObj(first) ? { ...(first as Record<string, unknown>) } : {};
      if (spec.parentId === undefined) {
        if (typeof second === "string" && second.length > 0) {
          spec.parentId = second;
        } else if (isObj(second) && typeof (second as Record<string, unknown>).id === "string") {
          // create(spec, nodeObject) — the result of a prior create().
          spec.parentId = (second as Record<string, unknown>).id;
        }
      }
      return spec;
    }
    default:
      // get_document_info / get_selection / get_styles / get_variables /
      // get_components / get_design_system_kit / generate_design_md /
      // design_fingerprint / list_channels → single object spec (or {}).
      // A stray scalar used to be wrapped into {value} — a param NO op reads,
      // so the arg was silently dropped (figma.screenshot("1:2") screenshotted
      // the whole page). Fail loud instead.
      if (isObj(first)) return first as Record<string, unknown>;
      if (first == null) return {};
      throw new OpError(
        ErrorCode.INVALID_PARAMS,
        `"${op}" takes an options object, not a bare ${Array.isArray(first) ? "array" : typeof first}.`,
        "Pass the options as one object — see figma_docs(section=\"api\") for the call shape.",
      );
  }
}

/**
 * Split ops into chunks of BATCH_CHUNK_SIZE and stream each chunk as its own
 * bridge dispatch. Results are collected per original index; a failing item
 * does NOT abort the batch (partial commit) — its error is recorded at its
 * exact index.
 */
async function runBatch(
  ops: Array<{ op: string; params: Record<string, unknown> }>,
  deps: ExecutorDeps,
  warnings: string[],
  resultDetail: "full" | "ids" = "full",
): Promise<{ total: number; ok: number; failed: number; results: Array<{ index: number; ok: boolean; result?: unknown; error?: { code: ErrorCode; message: string; hint?: string } }> }> {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new OpError(ErrorCode.INVALID_PARAMS, "batch() requires a non-empty array of { op, params }.", "Pass e.g. [{ op: \"create\", params: {...} }, ...].");
  }

  const results: Array<{ index: number; ok: boolean; result?: unknown; error?: { code: ErrorCode; message: string; hint?: string } }> = [];
  const total = ops.length;
  const chunkTotal = Math.ceil(total / BATCH_CHUNK_SIZE);

  for (let start = 0; start < total; start += BATCH_CHUNK_SIZE) {
    const chunkIndex = Math.floor(start / BATCH_CHUNK_SIZE);

    // Each item goes through the choke point (after any server-side resolve —
    // an image URL fetched, an icon's SVG loaded) just before its chunk is
    // sent, so resolved image bytes are held for one chunk at a time. A bad
    // item fails just that index, without a round-trip; the rest still run.
    const runnable: Array<{ index: number; op: Operation; params: Record<string, unknown> }> = [];
    for (let index = start; index < Math.min(start + BATCH_CHUNK_SIZE, total); index++) {
      const item: unknown = ops[index];
      try {
        if (!isObj(item)) {
          throw new OpError(
            ErrorCode.INVALID_PARAMS,
            `Batch item ${index} is not an { op, params } object.`,
            'Each item is { op: "create", params: {...} }.',
          );
        }
        const { op, params } = item as { op?: unknown; params?: unknown };
        const resolved = isObj(params) ? await resolveBatchItemParams(op, params as Record<string, unknown>, deps) : params;
        const v = validateOperation(op as string, resolved);
        runnable.push({ index, op: v.op as Operation, params: v.params });
      } catch (err) {
        results.push({ index, ok: false, error: toBridgeError(err) });
      }
    }

    if (runnable.length === 0) continue;

    // The bridge gives a batch dispatch 30s; a chunk of slow ops (instantiate,
    // audits, screenshots) needs what its items would each get on their own.
    // The plugin pings progress after every item, which resets the timer too.
    const chunkTimeoutMs = runnable.reduce((sum, it) => sum + (OP_TIMEOUTS[it.op] ?? DEFAULT_OP_TIMEOUT_MS), 0);
    const res = await deps.runOp(
      "batch",
      {
        ops: runnable.map((it) => ({ op: it.op, params: it.params })),
        chunk: { index: chunkIndex, total: chunkTotal },
      },
      { timeoutMs: chunkTimeoutMs },
    );
    // Dedupe: the same safe-default warning fires on every node of a large
    // draw, and N identical copies teach the agent nothing the first one did
    // not — they just cost tokens.
    if (res.warnings?.length) {
      for (const w of res.warnings) if (!warnings.includes(w)) warnings.push(w);
    }

    if (!res.ok) {
      // Whole-chunk transport failure → mark every runnable item in this chunk
      // failed at its exact original index (partial commit of prior chunks
      // stands).
      const e = res.error ?? { code: ErrorCode.INTERNAL, message: "batch chunk failed" };
      for (const it of runnable) {
        results.push({ index: it.index, ok: false, error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } });
      }
      continue;
    }

    // Plugin returns per-item outcomes in chunk order; map back to original idx.
    const items = (res.result as { items?: Array<{ ok: boolean; result?: unknown; error?: { code: ErrorCode; message: string; hint?: string }; warnings?: string[] }> } | undefined)?.items ?? [];
    runnable.forEach((it, i) => {
      const out = items[i];
      // The plugin files each item's warnings on the item, not the chunk.
      if (Array.isArray(out?.warnings)) {
        for (const w of out.warnings) if (typeof w === "string" && !warnings.includes(w)) warnings.push(w);
      }
      if (out && out.ok) {
        results.push({ index: it.index, ok: true, result: resultDetail === "ids" ? trimToId(out.result) : out.result });
      } else if (out) {
        results.push({ index: it.index, ok: false, error: out.error ?? { code: ErrorCode.INTERNAL, message: "batch item failed" } });
      } else {
        results.push({ index: it.index, ok: false, error: { code: ErrorCode.INTERNAL, message: "no result for batch item", hint: "Plugin returned fewer items than sent." } });
      }
    });
  }

  results.sort((a, b) => a.index - b.index);
  const okCount = results.filter((r) => r.ok).length;
  return { total, ok: okCount, failed: total - okCount, results };
}

/** Ops that can put a node straight onto the page, where it must keep clear. */
const PLACED_OPS = new Set<string>(["create", "instantiate", "clone"]);

function withPlaceGroup(op: AnyOperation, params: Record<string, unknown>, group: string): Record<string, unknown> {
  if (!PLACED_OPS.has(op) || !isObj(params) || params.placeGroup !== undefined) return params;
  return { ...params, placeGroup: group };
}

/**
 * Reduce a batch item's result to just its id (resultDetail:"ids"). Most write
 * ops return { id, node: {...} }; keep only the id, falling back to the raw
 * value when there is no id to extract.
 */
function trimToId(result: unknown): unknown {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.id === "string") return { id: r.id };
    const node = r.node as Record<string, unknown> | undefined;
    if (node && typeof node.id === "string") return { id: node.id };
  }
  return result;
}

function isObj(v: unknown): v is object {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A trailing options arg as a spreadable bag ({} for undefined/null/scalars). */
function optsOf(v: unknown): Record<string, unknown> {
  return isObj(v) ? (v as Record<string, unknown>) : {};
}

/**
 * A component passed as an object: a node read back from Figma ({id, …} —
 * its id, since every local component has a key that only imports once
 * published), or a ref bag ({key} / {component} / {componentId}).
 */
function componentRefOf(ref: Record<string, unknown>): Record<string, unknown> {
  if (typeof ref.id === "string" && ref.id) return { componentId: ref.id };
  const out: Record<string, unknown> = {};
  for (const k of ["key", "component", "componentId"] as const) if (ref[k] !== undefined) out[k] = ref[k];
  return out;
}

/**
 * One-shot per session: the first create that paints with LITERAL colors while
 * the session has no design tokens gets a warning telling the agent to reuse
 * the file's variables (figma_rules) or propose a palette to the user and
 * setupTokens it. Observed live: without this, agents hardcode a guessed
 * palette and every screen drifts. Fires once — it is a nudge, not nagging.
 */
function maybeNudgePalette(
  op: AnyOperation,
  params: Record<string, unknown>,
  session: Session,
  warnings: string[],
): void {
  if (session.paletteNudged) return;
  if (op !== "create" && op !== "create_overlay") return;
  const paintsLiteral =
    params["fills"] !== undefined || params["fill"] !== undefined || params["strokes"] !== undefined;
  if (!paintsLiteral) return;
  const tokens = session.state["tokens"];
  const hasTokens = isObj(tokens) && Object.keys(tokens as object).length > 0;
  if (hasTokens) return;
  session.paletteNudged = true;
  warnings.push(
    "First draw with literal colors and no session tokens. If this file has variables/styles, read figma_rules and reuse them (applyVariable). If it has none and there is no design.md, read figma_docs(section=\"style\") for a ready default scale/palette/elevation instead of inventing values (inventing is what makes output look generic), then figma.setupTokens/setupTextStyles from it so all screens share one system. A design.md in the codebase, if present, is the source of truth. (Shown once per session.)",
  );
}

/**
 * Make a serialized node ergonomic for sandbox code: keep the wire keys
 * (w/h) AND provide the official-API aliases (width/height) so both
 * `n.w` and `n.width` read the same number.
 */
function flattenNode(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...node };
  if (typeof out.w === "number" && out.width === undefined) out.width = out.w;
  if (typeof out.h === "number" && out.height === undefined) out.height = out.h;
  return out;
}

function flattenNodes(nodes: unknown[]): Record<string, unknown>[] {
  return nodes.filter(isObj).map((n) => flattenNode(n as Record<string, unknown>));
}

export { isReadOp };
