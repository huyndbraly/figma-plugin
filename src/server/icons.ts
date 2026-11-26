/**
 * Server-side icon support for searchIcons() and load_icon.
 *
 * - Cross-library alias map: a semantic name ("visibility", "delete", "done")
 *   resolves to the canonical icon name each library actually ships
 *   (material↔ionicons↔lucide↔tabler synonyms).
 * - searchIcons(query) returns *candidate canonical names* WITHOUT fetching
 *   any SVG — cheap, token-frugal.
 * - load_icon fetches the SVG server-side (unpkg CDN), caches it on disk under
 *   $TMPDIR/figma-plugin/cache/, then the caller forwards the `load_icon`
 *   op to the plugin with the resolved `svg` string param.
 *
 * The network fetch is behind an injectable `fetcher` so tests never hit the
 * network. "localhost-only" applies to the Figma bridge, not icon CDNs.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "./paths.js";
import { ErrorCode, OpError } from "./errors.js";
import { assertSafeIconName } from "./security.js";

export type IconLibrary = "ionicons" | "lucide" | "tabler" | "bootstrap-icons";
export const DEFAULT_LIBRARY: IconLibrary = "lucide";

export type Fetcher = (
  url: string,
  /** Aborted when the figma_write that asked stops waiting. */
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** A CDN that accepts the socket and then says nothing must not hold the call. */
export const ICON_FETCH_TIMEOUT_MS = 15_000;

/**
 * Cross-library semantic aliases → canonical name in the *lucide/ionicons*
 * naming world. Keys are the words an AI is likely to ask for; the value is a
 * name that exists in the target libraries (we normalize per-library below).
 * ~40 common UI synonyms.
 */
export const ALIASES: Record<string, string> = {
  visibility: "eye",
  "visibility-off": "eye-off",
  hide: "eye-off",
  show: "eye",
  delete: "trash",
  remove: "trash",
  bin: "trash",
  done: "check",
  checkmark: "check",
  success: "check",
  tick: "check",
  close: "x",
  cancel: "x",
  dismiss: "x",
  clear: "x",
  add: "plus",
  create: "plus",
  new: "plus",
  minus: "minus",
  subtract: "minus",
  edit: "pencil",
  modify: "pencil",
  write: "pencil",
  settings: "settings",
  gear: "settings",
  cog: "settings",
  preferences: "settings",
  search: "search",
  find: "search",
  magnify: "search",
  home: "home",
  house: "home",
  user: "user",
  person: "user",
  account: "user",
  profile: "user",
  people: "users",
  group: "users",
  menu: "menu",
  hamburger: "menu",
  more: "more-horizontal",
  overflow: "more-vertical",
  back: "arrow-left",
  forward: "arrow-right",
  next: "arrow-right",
  previous: "arrow-left",
  up: "chevron-up",
  down: "chevron-down",
  expand: "chevron-down",
  collapse: "chevron-up",
  notification: "bell",
  alert: "bell",
  warning: "alert-triangle",
  error: "alert-circle",
  info: "info",
  help: "help-circle",
  question: "help-circle",
  favorite: "heart",
  like: "heart",
  star: "star",
  bookmark: "bookmark",
  save: "save",
  download: "download",
  upload: "upload",
  share: "share",
  link: "link",
  copy: "copy",
  calendar: "calendar",
  date: "calendar",
  clock: "clock",
  time: "clock",
  mail: "mail",
  email: "mail",
  message: "message-square",
  chat: "message-circle",
  phone: "phone",
  call: "phone",
  camera: "camera",
  image: "image",
  photo: "image",
  file: "file",
  document: "file-text",
  folder: "folder",
  lock: "lock",
  secure: "lock",
  unlock: "unlock",
  logout: "log-out",
  login: "log-in",
  refresh: "refresh-cw",
  reload: "refresh-cw",
  sync: "refresh-cw",
  filter: "filter",
  sort: "arrow-up-down",
  cart: "shopping-cart",
  bag: "shopping-bag",
  location: "map-pin",
  pin: "map-pin",
  map: "map",
  play: "play",
  pause: "pause",
  stop: "square",
  volume: "volume-2",
  mute: "volume-x",
};

/** Resolve a semantic query to a canonical icon slug (or itself if none). */
export function resolveAlias(query: string): string {
  const key = query.trim().toLowerCase().replace(/\s+/g, "-");
  return ALIASES[key] ?? key;
}

/**
 * searchIcons: return candidate canonical names, ranked. No network — this is
 * a name-resolution helper so the AI can pick before paying for a fetch.
 */
export function searchIcons(query: string, limit = 8): Array<{ name: string; alias?: string; libraries: IconLibrary[] }> {
  const norm = query.trim().toLowerCase().replace(/\s+/g, "-");
  const canonical = resolveAlias(norm);
  const results: Array<{ name: string; alias?: string; libraries: IconLibrary[] }> = [];
  const seen = new Set<string>();

  const push = (name: string, alias?: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    results.push({ name, ...(alias ? { alias } : {}), libraries: librariesFor(name) });
  };

  push(canonical, canonical !== norm ? norm : undefined);

  // Also surface other aliases whose value or key matches the query substring.
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (results.length >= limit) break;
    if (alias.includes(norm) || target.includes(norm) || norm.includes(target)) {
      push(target, alias);
    }
  }
  return results.slice(0, limit);
}

interface LibrarySpec {
  /** Build the unpkg URL for an icon name. */
  url: (name: string) => string;
}

const LIBRARIES: Record<IconLibrary, LibrarySpec> = {
  lucide: { url: (n) => `https://unpkg.com/lucide-static@latest/icons/${n}.svg` },
  ionicons: { url: (n) => `https://unpkg.com/ionicons@latest/dist/svg/${toIonicon(n)}.svg` },
  tabler: { url: (n) => `https://unpkg.com/@tabler/icons@latest/icons/outline/${n}.svg` },
  "bootstrap-icons": { url: (n) => `https://unpkg.com/bootstrap-icons@latest/icons/${n}.svg` },
};

/** Ionicons drop the -outline/-sharp suffix conventions; map a few basics. */
const IONICON_MAP: Record<string, string> = {
  trash: "trash-outline",
  eye: "eye-outline",
  "eye-off": "eye-off-outline",
  check: "checkmark-outline",
  x: "close-outline",
  plus: "add-outline",
  settings: "settings-outline",
  search: "search-outline",
  home: "home-outline",
  user: "person-outline",
};

function toIonicon(name: string): string {
  return IONICON_MAP[name] ?? `${name}-outline`;
}

/**
 * Which libraries a canonical name is KNOWN to resolve in without a fetch:
 * lucide (the namespace the aliases target), plus ionicons when the name has
 * an explicit mapping. Tabler and bootstrap-icons take the name verbatim and
 * may well ship it — but claiming all four made a "not found" look like a
 * tool bug rather than a catalogue gap.
 */
function librariesFor(name: string): IconLibrary[] {
  return name in IONICON_MAP ? ["lucide", "ionicons"] : ["lucide"];
}

export const defaultFetcher: Fetcher = async (url, init) => {
  // Node 18+ has global fetch. Wrapped so tests can inject a fake. One
  // controller carries both the caller's signal and our own deadline
  // (AbortSignal.any is Node 20+), and the deadline spans the body read too —
  // prompt headers say nothing about a body that trickles.
  const ctl = new AbortController();
  const timer = setTimeout(
    () => ctl.abort(new Error(`Icon CDN did not answer within ${ICON_FETCH_TIMEOUT_MS / 1000}s.`)),
    ICON_FETCH_TIMEOUT_MS,
  );
  timer.unref?.();
  const outer = init?.signal;
  const onAbort = () => ctl.abort(new Error("Icon download cancelled — the call that asked for it stopped waiting."));
  if (outer?.aborted) onAbort();
  else outer?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await globalThis.fetch(url, { signal: ctl.signal });
    const body = await res.text();
    return { ok: res.ok, status: res.status, text: async () => body };
  } catch (e) {
    // Report why it stopped (deadline / caller gone), not a bare AbortError.
    const reason: unknown = ctl.signal.aborted ? ctl.signal.reason : e;
    throw reason instanceof Error ? reason : new Error(String(reason));
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
};

export interface LoadIconOptions {
  library?: IconLibrary;
  fetcher?: Fetcher;
  /** Aborted when the call that asked stops waiting; the fetch stops too. */
  signal?: AbortSignal;
}

/**
 * Fetch the SVG for an icon name, resolving aliases + disk cache. Returns the
 * raw SVG string. The caller then dispatches the `load_icon` op to the plugin
 * with this `svg` in params (the plugin turns SVG into Figma nodes).
 */
export async function loadIconSvg(name: string, opts: LoadIconOptions = {}): Promise<{ svg: string; canonical: string; library: IconLibrary; cached: boolean }> {
  const library = opts.library ?? DEFAULT_LIBRARY;
  const fetcher = opts.fetcher ?? defaultFetcher;
  const canonical = assertSafeIconName(resolveAlias(name));

  const spec = Object.hasOwn(LIBRARIES, library) ? LIBRARIES[library] : undefined;
  if (!spec) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Unknown icon library "${String(library)}".`,
      `Use one of: ${Object.keys(LIBRARIES).join(", ")}.`,
    );
  }
  const url = spec.url(canonical);
  const cacheFile = join(cacheDir(), `${library}__${hashName(canonical)}.svg`);

  try {
    const cached = await readFile(cacheFile, "utf8");
    if (cached.length > 0) {
      return { svg: cached, canonical, library, cached: true };
    }
  } catch {
    /* cache miss */
  }

  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await fetcher(url, opts.signal ? { signal: opts.signal } : undefined);
  } catch (e) {
    if (e instanceof OpError) throw e;
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `Could not fetch icon "${canonical}" from ${library}: ${e instanceof Error ? e.message : String(e)}`,
      "Retry once the icon CDN is reachable, or try another { library }.",
    );
  }
  if (!res.ok) {
    throw new OpError(
      ErrorCode.NODE_NOT_FOUND,
      `Icon "${name}" (resolved "${canonical}") not found in ${library} (HTTP ${res.status}).`,
      `Try searchIcons("${name}") for candidate names, or pass a different { library }.`,
    );
  }
  const svg = await res.text();
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(cacheFile, svg, { mode: 0o600 });
  } catch {
    /* cache write best-effort */
  }
  return { svg, canonical, library, cached: false };
}

function hashName(name: string): string {
  return createHash("sha1").update(name).digest("hex").slice(0, 16);
}
