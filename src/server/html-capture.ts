/**
 * Capture a rendered web page — boxes + computed CSS — with Playwright, for
 * src/shared/html-to-figma.ts to turn into a create() tree.
 *
 * Playwright is OPTIONAL: it is not a dependency of this package, and the
 * import is resolved at call time. Without it the call fails with the two
 * commands that install it. Only http(s) URLs are opened (localhost is the
 * point: "draw my running app", but any http(s) host is opened — public and
 * LAN alike — so pages that load CDN fonts or CSS capture as they look);
 * file:, data:, javascript: are refused (they are not pages to capture).
 */
import { ErrorCode, OpError } from "./errors.js";
import type { CapturedNode } from "../shared/html-to-figma.js";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";


export interface CaptureOptions {
  width?: number;
  height?: number;
  /** CSS selector of the element to capture (default: body). */
  selector?: string;
  /** Extra wait after load, ms (SPAs that render after network idle). */
  waitMs?: number;
  timeoutMs?: number;
}

/** Injectable loader (tests). Returns the playwright module or throws. */
export type PlaywrightLoader = () => Promise<{ chromium: { launch: (o?: unknown) => Promise<unknown> } }>;

const defaultLoader: PlaywrightLoader = async () => {
  // Resolve from the folder the server was STARTED in first (the user's
  // project), then from this package's own node_modules. A bare import()
  // only looks next to the bundled file. Non-literal specifiers: the bundler
  // leaves them alone.
  const names = ["playwright", "playwright-core"];
  const fromCwd = createRequire(join(process.cwd(), "noop.js"));
  let last: unknown;
  for (const name of names) {
    try {
      return (await import(pathToFileURL(fromCwd.resolve(name)).href)) as never;
    } catch (e) {
      last = e;
    }
    try {
      return (await import(name)) as never;
    } catch (e) {
      last = e;
    }
  }
  throw last;
};


export function checkCaptureUrl(raw: unknown): string {
  let url: URL;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    throw new OpError(ErrorCode.INVALID_PARAMS, "htmlToFigma needs an http(s) URL.", 'e.g. figma.htmlToFigma("http://localhost:3000/settings").');
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpError(ErrorCode.INVALID_PARAMS, `Only http(s) pages can be captured (got ${url.protocol}).`, "Serve the page (npm run dev) and pass its http://localhost URL.");
  }
  return url.toString();
}

/**
 * Runs in the page. Kept as a string-free function so it can be passed to
 * page.evaluate; it must not reference anything outside itself.
 */
/* c8 ignore start */
export function extractInPage(arg: { selector?: string; maxDepth: number }): unknown {
  const KEYS = [
    "display", "flexDirection", "flexWrap", "gap", "rowGap", "columnGap", "justifyContent", "alignItems",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "backgroundColor", "color", "fontFamily",
    "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "textAlign", "borderTopLeftRadius",
    "borderTopWidth", "borderTopColor", "borderTopStyle", "opacity", "boxShadow", "overflow", "position",
  ];
  const COLOR_KEYS = ["color", "backgroundColor", "borderTopColor"];
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD"]);
  const doc = (globalThis as unknown as { document: any }).document;
  const win = globalThis as unknown as { getComputedStyle: (e: unknown) => any; scrollX: number; scrollY: number };
  let root: any;
  try {
    root = arg.selector ? doc.querySelector(arg.selector) : doc.body;
  } catch {
    return { selectorError: true };
  }
  if (!root) return null;
  // Modern CSS colours (oklch(), lab(), color(display-p3 …) — Tailwind v4's
  // default palette) come back as-is from getComputedStyle. Let the browser
  // turn each into sRGB by painting one pixel, once per distinct value.
  const canvas = doc.createElement("canvas");
  canvas.width = canvas.height = 1;
  const g2 = canvas.getContext("2d", { willReadFrequently: true });
  const colorCache: Record<string, string> = {};
  const toRgb = (v: string): string => {
    if (!v || /^(rgba?\(|#|transparent)/i.test(v) || !g2) return v;
    if (colorCache[v] !== undefined) return colorCache[v]!;
    g2.clearRect(0, 0, 1, 1);
    g2.fillStyle = "#000";
    g2.fillStyle = v;
    g2.fillRect(0, 0, 1, 1);
    const d = g2.getImageData(0, 0, 1, 1).data;
    colorCache[v] = `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${Math.round((d[3] / 255) * 1000) / 1000})`;
    return colorCache[v]!;
  };
  const rb = root.getBoundingClientRect();
  const ox = rb.left + win.scrollX;
  const oy = rb.top + win.scrollY;
  const walk = (el: any, depth: number): any => {
    if (SKIP.has(el.tagName)) return null;
    const cs = win.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return null;
    const r = el.getBoundingClientRect();
    const style: Record<string, string> = {};
    for (const k of KEYS) style[k] = cs[k];
    for (const k of COLOR_KEYS) style[k] = toRgb(style[k]!);
    const node: any = {
      tag: el.tagName.toLowerCase(),
      rect: { x: r.left + win.scrollX - ox, y: r.top + win.scrollY - oy, w: r.width, h: r.height },
      style,
      ...(el.id ? { id: el.id } : {}),
      ...(typeof el.className === "string" && el.className ? { className: el.className } : {}),
      ...(el.getAttribute && el.getAttribute("src") ? { src: el.getAttribute("src") } : {}),
      ...(el.getAttribute && el.getAttribute("alt") ? { alt: el.getAttribute("alt") } : {}),
      children: [] as any[],
    };
    if (depth >= arg.maxDepth || ["IMG", "SVG", "VIDEO", "CANVAS", "IFRAME"].includes(el.tagName.toUpperCase())) return node;
    for (const child of Array.from(el.childNodes) as any[]) {
      if (child.nodeType === 3) {
        const text = String(child.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const range = doc.createRange();
        range.selectNodeContents(child);
        const tr = range.getBoundingClientRect();
        if (tr.width < 0.5 || tr.height < 0.5) continue;
        node.children.push({ tag: "#text", text, rect: { x: tr.left + win.scrollX - ox, y: tr.top + win.scrollY - oy, w: tr.width, h: tr.height }, style });
      } else if (child.nodeType === 1) {
        const c = walk(child, depth + 1);
        if (c) node.children.push(c);
      }
    }
    return node;
  };
  return walk(root, 0);
}
/* c8 ignore stop */

const finite = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export async function capturePage(rawUrl: unknown, opts: CaptureOptions = {}, loader: PlaywrightLoader = defaultLoader): Promise<CapturedNode> {
  // Any http(s) host — localhost, LAN, public: the user's decision (2026-11-27),
  // so app pages with CDN fonts/CSS and real APIs capture as they look.
  const url = checkCaptureUrl(rawUrl);
  let pw: Awaited<ReturnType<PlaywrightLoader>>;
  try {
    pw = await loader();
  } catch {
    throw new OpError(
      ErrorCode.UNSUPPORTED_OPERATION,
      "htmlToFigma needs Playwright, which is not installed where this MCP server can find it.",
      "Install it in the folder the MCP server is started from (your project) or in the figma-plugin folder: `npm i -D playwright && npx playwright install chromium`, then restart the MCP server.",
    );
  }
  type Page = {
    goto: (u: string, o: unknown) => Promise<unknown>;
    url?: () => string;
    route?: (pattern: string, handler: (route: { request: () => { url: () => string }; continue: () => Promise<void>; abort: () => Promise<void> }) => Promise<void> | void) => Promise<void>;
    waitForLoadState?: (state: string, o: unknown) => Promise<void>;
    waitForTimeout: (ms: number) => Promise<void>;
    evaluate: <T>(fn: (a: T) => unknown, a: T) => Promise<unknown>;
  };
  let browser: { newPage: (o: unknown) => Promise<Page>; close: () => Promise<void> };
  try {
    browser = (await pw.chromium.launch({ headless: true })) as typeof browser;
  } catch (e) {
    throw new OpError(
      ErrorCode.UNSUPPORTED_OPERATION,
      `Playwright is installed but could not start Chromium: ${(e as Error).message.split("\n")[0]}`,
      "Download the browser once: `npx playwright install chromium` (in the same folder Playwright is installed in), then call again.",
    );
  }
  try {
    const page = await browser.newPage({ viewport: { width: Math.max(320, Math.min(3840, finite(opts.width, 1280))), height: Math.max(320, Math.min(4000, finite(opts.height, 800))) } });
    const timeout = Math.min(60_000, finite(opts.timeoutMs, 30_000));
    // "load", then a SHORT wait for the network to settle: a page with
    // long-polling or SSE never reaches networkidle.
    await page.goto(url, { waitUntil: "load", timeout });
    await page.waitForLoadState?.("networkidle", { timeout: 5_000 }).catch(() => undefined);
    const wait = finite(opts.waitMs, 0);
    if (wait > 0) await page.waitForTimeout(Math.min(10_000, wait));
    const tree = (await page.evaluate(extractInPage, { ...(opts.selector ? { selector: opts.selector } : {}), maxDepth: 40 })) as (CapturedNode & { selectorError?: boolean }) | null;
    if (tree && tree.selectorError) {
      throw new OpError(ErrorCode.INVALID_PARAMS, `"${opts.selector}" is not a valid CSS selector.`, 'e.g. "main", "#app", ".settings-panel".');
    }
    if (!tree) {
      throw new OpError(ErrorCode.NODE_NOT_FOUND, `Nothing matched ${opts.selector ? `"${opts.selector}"` : "<body>"} on ${url}.`, "Check the selector in the browser devtools.");
    }
    return tree;
  } catch (e) {
    if (e instanceof OpError) throw e;
    const msg = (e as Error).message ?? String(e);
    throw new OpError(
      ErrorCode.INTERNAL,
      `Capturing ${url} failed: ${msg.split("\n")[0]}`,
      /Timeout/i.test(msg) ? "The page did not load in time — is the dev server running? Raise { timeoutMs } for slow pages." : "Open the URL in a browser to check it loads.",
    );
  } finally {
    await browser.close().catch(() => undefined);
  }
}
