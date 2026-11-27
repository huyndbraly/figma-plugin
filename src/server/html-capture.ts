/**
 * Capture a rendered web page — boxes + computed CSS — with Playwright, for
 * src/shared/html-to-figma.ts to turn into a create() tree.
 *
 * Playwright is OPTIONAL: it is not a dependency of this package, and the
 * import is resolved at call time. Without it the call fails with the two
 * commands that install it. Only http(s) URLs are opened (localhost is the
 * point: "draw my running app"); file:, data:, javascript: are refused.
 */
import { ErrorCode, OpError } from "./errors.js";
import type { CapturedNode } from "../shared/html-to-figma.js";

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
  // A non-literal specifier: the bundler leaves it alone, and the package is
  // resolved from the user's project only when this runs.
  const names = ["playwright", "playwright-core"];
  let last: unknown;
  for (const name of names) {
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
    "borderTopWidth", "borderTopColor", "borderTopStyle", "opacity", "boxShadow", "overflow",
  ];
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD"]);
  const doc = (globalThis as unknown as { document: any }).document;
  const win = globalThis as unknown as { getComputedStyle: (e: unknown) => any; scrollX: number; scrollY: number };
  const root = arg.selector ? doc.querySelector(arg.selector) : doc.body;
  if (!root) return null;
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

export async function capturePage(rawUrl: unknown, opts: CaptureOptions = {}, loader: PlaywrightLoader = defaultLoader): Promise<CapturedNode> {
  const url = checkCaptureUrl(rawUrl);
  let pw: Awaited<ReturnType<PlaywrightLoader>>;
  try {
    pw = await loader();
  } catch {
    throw new OpError(
      ErrorCode.UNSUPPORTED_OPERATION,
      "htmlToFigma needs Playwright, which is not installed next to this MCP server.",
      "Install it once: `npm i -D playwright && npx playwright install chromium` (in the folder the MCP server runs from, or globally), then restart the MCP server.",
    );
  }
  const browser = (await pw.chromium.launch({ headless: true })) as {
    newPage: (o: unknown) => Promise<{
      goto: (u: string, o: unknown) => Promise<unknown>;
      waitForTimeout: (ms: number) => Promise<void>;
      evaluate: <T>(fn: (a: T) => unknown, a: T) => Promise<unknown>;
    }>;
    close: () => Promise<void>;
  };
  try {
    const page = await browser.newPage({ viewport: { width: Math.max(320, Math.min(3840, opts.width ?? 1280)), height: Math.max(320, Math.min(4000, opts.height ?? 800)) } });
    await page.goto(url, { waitUntil: "networkidle", timeout: Math.min(60_000, opts.timeoutMs ?? 30_000) });
    if (opts.waitMs && opts.waitMs > 0) await page.waitForTimeout(Math.min(10_000, opts.waitMs));
    const tree = (await page.evaluate(extractInPage, { ...(opts.selector ? { selector: opts.selector } : {}), maxDepth: 40 })) as CapturedNode | null;
    if (!tree) {
      throw new OpError(ErrorCode.NODE_NOT_FOUND, `Nothing matched ${opts.selector ? `"${opts.selector}"` : "<body>"} on ${url}.`, "Check the selector in the browser devtools.");
    }
    return tree;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
