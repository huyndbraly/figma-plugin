/**
 * Shared protocol between the MCP server and the Figma plugin.
 * This file is the single source of truth for operation names, message
 * shapes, error codes and timeouts. Both sides import it; the executor
 * proxy, the server-side validator and the plugin handler registry are
 * all derived from OPERATIONS so the layers cannot drift.
 */

// v5: component and instance operations (find_component … swap_component).
// v6: quality audits, component map, create_board (usecase/journey/persona).
// v7: FigJam/Slides (create_figjam_diagram, get_slides, create_slide), the
//     REST token messages (set_rest_token, rest_status, rest_event).
// v8: the REST token is no longer read from the hello — only set_rest_token
//     (with savedAt) after `assigned`; FigJam sections store their model.
export const PROTOCOL_VERSION = 8;

/** Default bridge port; server falls back to +1..+9 when busy. */
export const DEFAULT_PORT = 38470;
export const PORT_RANGE = 10;

/** Read operations executed by the plugin. */
export const READ_OPERATIONS = [
  "get_document_info",
  "get_selection",
  "get_design_context",
  "get_node",
  "get_nodes",
  "search_nodes",
  "scan_text_nodes",
  "scan_nodes_by_types",
  "get_styles",
  "get_variables",
  "get_components",
  "get_component",
  "get_library_component",
  "get_design_system_kit",
  "generate_design_md",
  "design_fingerprint",
  "screenshot",
  "export_node",
  "get_fonts",
  // Token export reads variables and serializes (DTCG/CSS/Tailwind).
  "export_tokens",
  "layout_audit",
  // Selection-first editing: deep read of the current selection in one call.
  "read_selection",
  // The MODEL a drawn diagram was made from, read back off its frame — so a
  // finding can be fixed with a patch instead of re-sending the whole spec.
  "get_diagram_spec",
  // Every model the page holds, so the tools can ask whether the diagrams on
  // it agree with each other — a question no single-diagram checker can put.
  "get_page_model",
  // Components: search by name, and what an instance changed.
  "find_component",
  "get_instance_overrides",
  // Quality audits and the code ↔ Figma component map.
  "a11y_audit",
  "audit_design_system",
  "export_component_map",
  "check_component_map",
  // Figma Slides: the deck's slide grid.
  "get_slides",
] as const;

/** Write operations executed by the plugin. */
export const WRITE_OPERATIONS = [
  "create",
  "modify",
  "delete",
  "clone",
  "move",
  "resize",
  "group",
  "ungroup",
  "flatten",
  "batch",
  "setup_tokens",
  "setup_text_styles",
  "setup_effect_styles",
  "set_text_style",
  "apply_variable",
  "create_variable",
  "update_variable",
  "rename_variable",
  "delete_variable",
  "import_tokens",
  "set_text",
  "load_icon",
  "load_image",
  "create_page",
  "delete_page",
  "delete_style",
  "delete_unused_styles",
  "set_current_page",
  "create_overlay",
  "set_selection",
  "zoom_to_fit",
  "set_selection_colors",
  "set_gradient",
  "set_effects",
  "set_reactions",
  // Diagrams: the server lays them out, the plugin only draws.
  "create_userflow",
  "create_activity",
  "create_erd",
  "create_sequence",
  "create_state",
  "create_sitemap",
  // Re-route a drawn diagram's arrows from where its boxes are now.
  "reflow_diagram",
  // Components and instances.
  "find_or_create_component",
  "componentize",
  "create_variants",
  "arrange_component_set",
  "set_component_description",
  "add_component_property",
  "edit_component_property",
  "delete_component_property",
  "instantiate",
  "set_instance_properties",
  "set_instance_overrides",
  "swap_component",
  "expose_nested_instance",
  "detach_instance",
  "reset_instance_overrides",
  // Bind literal values to the tokens they equal.
  "apply_design_system",
  // Clones a screen to other viewports, audits each, removes the clones.
  "responsive_audit",
  // Static diagram kinds drawn from server-side layout (use case, journey, persona).
  "create_board",
  // FigJam-native diagram: shapes-with-text + connectors in a section.
  "create_figjam_diagram",
  // Figma Slides: append a slide to the grid.
  "create_slide",
] as const;

export type ReadOperation = (typeof READ_OPERATIONS)[number];
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];
export type Operation = ReadOperation | WriteOperation;

export const OPERATIONS: readonly Operation[] = [
  ...READ_OPERATIONS,
  ...WRITE_OPERATIONS,
];

/**
 * Operations answered by the SERVER (bridge state), never dispatched to the
 * plugin. Kept out of OPERATIONS so the plugin handler registry — which must
 * cover every plugin-executed op — does not expect handlers for them.
 * Followers still forward these over /rpc like any other op.
 */
export const SERVER_OPERATIONS = ["list_channels"] as const;
export type ServerOperation = (typeof SERVER_OPERATIONS)[number];
export type AnyOperation = Operation | ServerOperation;

export enum ErrorCode {
  NOT_CONNECTED = "NOT_CONNECTED",
  NODE_NOT_FOUND = "NODE_NOT_FOUND",
  FONT_UNAVAILABLE = "FONT_UNAVAILABLE",
  INVALID_PARAMS = "INVALID_PARAMS",
  PLUGIN_TIMEOUT = "PLUGIN_TIMEOUT",
  QUEUE_FULL = "QUEUE_FULL",
  /**
   * Figma's REST quota for the token is used up. Retry-After can be DAYS on
   * a Starter plan, so this is not a "retry soon" — read through the plugin.
   */
  RATE_LIMITED = "RATE_LIMITED",
  PAGE_LIMIT = "PAGE_LIMIT",
  /** A Figma API refused because the file's pricing tier caps it. */
  PLAN_LIMIT = "PLAN_LIMIT",
  COMPONENT_IN_USE = "COMPONENT_IN_USE",
  /** A destructive op needs an explicit second step (force or a confirm token). */
  CONFIRM_REQUIRED = "CONFIRM_REQUIRED",
  UNAUTHORIZED = "UNAUTHORIZED",
  SANDBOX_ERROR = "SANDBOX_ERROR",
  UNSUPPORTED_OPERATION = "UNSUPPORTED_OPERATION",
  /** Multiple Figma windows are connected and no channel was specified. */
  AMBIGUOUS_CHANNEL = "AMBIGUOUS_CHANNEL",
  /** A channel was specified but no plugin connection is joined to it. */
  CHANNEL_NOT_FOUND = "CHANNEL_NOT_FOUND",
  INTERNAL = "INTERNAL",
}

export interface BridgeError {
  code: ErrorCode;
  message: string;
  /** Concrete next step the calling agent can take to fix the problem. */
  hint?: string;
}

/** Server → plugin. */
export interface BridgeRequest {
  id: string;
  op: Operation;
  params: Record<string, unknown>;
  /** Set when this request is one chunk of a larger batch. */
  chunk?: { index: number; total: number };
}

/** Plugin → server. */
export interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeError;
  /** Non-fatal issues (e.g. "node will be clipped by parent"). */
  warnings?: string[];
  /** Progress ping for long ops; resets the server-side timeout. */
  progress?: { done: number; total: number; note?: string };
}

/** Plugin → server on WS connect, before any request is dispatched. */
export interface PluginHello {
  type: "hello";
  protocolVersion: number;
  pluginVersion: string;
  /** Build stamp of the plugin bundle Figma is actually running. */
  pluginBuild?: string;
  fileKey: string | null;
  fileName: string;
  pageName: string;
  editorType: "figma" | "figjam" | "slides" | string;
  /**
   * Channel this Figma window wants to join. Empty/absent (also every
   * protocol-v1 plugin) → the server assigns one and answers with
   * ChannelAssigned. Commands route per-channel, so multiple Figma windows
   * can stay connected simultaneously.
   */
  channel?: string | null;
  /**
   * Secret issued in ChannelAssigned on first join. Required to *replace*
   * an existing live channel — without it the server assigns a fresh
   * channel instead of stealing the incumbent (stops local WS hijacks that
   * only knew the channel name from GET /health).
   */
  resumeToken?: string | null;
}

/**
 * Plugin → server: the REST token saved in this plugin's clientStorage
 * (string) or its Clear (null). Sent on a connection that has received
 * `assigned` (not in the hello), and again after every reconnect, so a Clear
 * made while offline still arrives.
 */
export interface SetRestToken {
  type: "set_rest_token";
  token: string | null;
  /** Epoch ms the user said the token expires (1/7/30/90 days); null = not stated. */
  expiresAt?: number | null;
  /**
   * When this token (or this Clear) was saved, by the panel's clock. Every
   * window shares one clientStorage but caches it; the server keeps the
   * newest, so a window that missed a later Save/Clear cannot bring back
   * what it cached.
   */
  savedAt?: number | null;
}

/** Token state as the plugin panel shows it. Never carries the token itself. */
export interface RestStatusWire {
  state: "not_set" | "unverified" | "checking" | "valid" | "invalid" | "rate_limited" | "error";
  source: "plugin" | "env" | null;
  masked?: string;
  handle?: string;
  httpStatus?: number;
  message?: string;
  checkedAt?: number;
  scopes?: string[];
  missingScopes?: string[];
  expiresAt?: number;
  retryAt?: number;
  planTier?: string;
  rateLimitType?: string;
}

/** Server → plugin: the REST token's state changed (or a window just joined). */
export interface RestStatusUpdate {
  type: "rest_status";
  status: RestStatusWire;
}

/** Server → plugin: one Figma REST request finished (counters + activity log). */
export interface RestEventWire {
  type: "rest_event";
  at: number;
  op: string;
  method: string;
  fileKey?: string;
  status: number;
  ms: number;
  ok: boolean;
  kind: "read" | "write";
  message?: string;
}

/** Server → plugin after hello: the channel this connection is joined to. */
export interface ChannelAssigned {
  type: "assigned";
  channel: string;
  /** Persist and send back on the next hello to reclaim this channel. */
  resumeToken: string;
}

/** One agent session as shown in the plugin UI picker. */
export interface SessionSummaryWire {
  id: string;
  writeCount: number;
  lastUsedMs: number;
  /** Channel this session is bound to (via the plugin UI), if any. */
  boundChannel?: string | null;
}

/**
 * Server → plugin: live snapshot of connected windows + agent sessions.
 * Pushed on every join/leave/bind and piggybacked on the heartbeat so the
 * plugin UI can render a picker ("which agent drives this window?").
 */
export interface ChannelsUpdate {
  type: "channels";
  /** The receiving connection's own channel. */
  self: string;
  channels: Array<{ channel: string; fileName: string; pageName: string }>;
  sessions: SessionSummaryWire[];
}

/**
 * Plugin → server: the user picked an agent session in the plugin UI. Binds
 * that session to this connection's channel — the session's subsequent ops
 * route to this window without the agent passing a channel.
 */
export interface BindRequest {
  type: "bind";
  sessionId: string;
}

/**
 * Plugin → server: this window is the one the user is working in (selection
 * or page change, not plugin-driven). The bridge uses it as the default
 * target for a new agent session that has not passed file/page yet.
 */
export interface PluginContext {
  type: "context";
  fileName: string;
  pageName: string;
  reason: "selection" | "page";
  at: number;
}

export interface Heartbeat {
  type: "ping" | "pong";
  at: number;
}

/** WS envelope: everything on the wire is one of these. */
export type WireMessage =
  | { type: "request"; payload: BridgeRequest }
  | { type: "response"; payload: BridgeResponse }
  | PluginHello
  | ChannelAssigned
  | ChannelsUpdate
  | BindRequest
  | PluginContext
  | SetRestToken
  | RestStatusUpdate
  | RestEventWire
  | Heartbeat;

/** Heartbeat cadence (ms). Plugin sends ping; server answers pong. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** No heartbeat for this long → connection considered dead. */
export const HEARTBEAT_DEAD_MS = 30_000;

/** Per-operation timeout budget (ms). Missing key → DEFAULT_OP_TIMEOUT_MS. */
export const DEFAULT_OP_TIMEOUT_MS = 30_000;
export const OP_TIMEOUTS: Partial<Record<Operation, number>> = {
  screenshot: 90_000,
  export_node: 90_000,
  get_design_context: 60_000,
  get_components: 60_000,
  get_component: 60_000,
  // Library import is a network round-trip to the published library.
  get_library_component: 60_000,
  get_design_system_kit: 60_000,
  generate_design_md: 60_000,
  design_fingerprint: 30_000,
  // batch: 30s per chunk — progress messages reset the timer.
  batch: 30_000,
  // Whole-document usage scan before the replace-gate.
  delete_variable: 60_000,
  delete_style: 60_000,
  delete_unused_styles: 60_000,
  // Loading a page's layers before counting them.
  delete_page: 60_000,
  export_tokens: 60_000,
  import_tokens: 60_000,
  // Name lookups may load every page; componentize may sweep a page for copies.
  find_component: 60_000,
  find_or_create_component: 60_000,
  instantiate: 60_000,
  componentize: 60_000,
  create_variants: 60_000,
  a11y_audit: 60_000,
  audit_design_system: 90_000,
  apply_design_system: 120_000,
  responsive_audit: 120_000,
  export_component_map: 60_000,
  check_component_map: 60_000,
  create_board: 60_000,
  create_figjam_diagram: 60_000,
};

/** Batch requests are split into chunks of this size and streamed. */
export const BATCH_CHUNK_SIZE = 20;

/** Max vm execution budget for one figma_write call (ms). */
export const VM_TIMEOUT_MS = 120_000;

/** Leader/follower discovery file inside $TMPDIR/figma-plugin/. */
export const LEADER_FILE = "leader.json";
export interface LeaderInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
  version: string;
}
