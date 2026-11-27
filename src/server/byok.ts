/**
 * Bring-your-own-key generation: an image (OpenAI Images) or an SVG (Anthropic
 * Messages) from a prompt, placed on the canvas by figma_write.
 *
 * Keys come from the environment — OPENAI_API_KEY / ANTHROPIC_API_KEY, or the
 * FIGMA_MCP_-prefixed variants — or from an optional JSON file named by
 * FIGMA_MCP_BYOK_CONFIG ({ openaiApiKey, anthropicApiKey, imageModel,
 * svgModel }). Like the Figma token, a key is only ever a request header: it
 * is not logged, not echoed, and every error says which variable to set,
 * never what it was set to.
 */
import { readFileSync } from "node:fs";
import { ErrorCode, OpError } from "./errors.js";
import { withTimeout } from "./rest-hub.js";

export type AiFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ByokConfig {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  imageModel?: string;
  svgModel?: string;
}

export const DEFAULT_IMAGE_MODEL = "gpt-image-1";
export const DEFAULT_SVG_MODEL = "claude-sonnet-5-5";

export function loadByokConfig(env: NodeJS.ProcessEnv = process.env): ByokConfig {
  let file: ByokConfig = {};
  const path = env.FIGMA_MCP_BYOK_CONFIG;
  if (path) {
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as ByokConfig;
    } catch {
      throw new OpError(ErrorCode.INVALID_PARAMS, "FIGMA_MCP_BYOK_CONFIG points at a file that is not readable JSON.", "It should hold { openaiApiKey?, anthropicApiKey?, imageModel?, svgModel? }.");
    }
  }
  const pick = (...v: Array<string | undefined>) => v.find((x) => typeof x === "string" && x.trim())?.trim();
  return {
    ...(pick(env.FIGMA_MCP_OPENAI_API_KEY, env.OPENAI_API_KEY, file.openaiApiKey) ? { openaiApiKey: pick(env.FIGMA_MCP_OPENAI_API_KEY, env.OPENAI_API_KEY, file.openaiApiKey) } : {}),
    ...(pick(env.FIGMA_MCP_ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY, file.anthropicApiKey) ? { anthropicApiKey: pick(env.FIGMA_MCP_ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY, file.anthropicApiKey) } : {}),
    imageModel: pick(env.FIGMA_MCP_IMAGE_MODEL, file.imageModel) ?? DEFAULT_IMAGE_MODEL,
    svgModel: pick(env.FIGMA_MCP_SVG_MODEL, file.svgModel) ?? DEFAULT_SVG_MODEL,
  };
}

function prompted(prompt: unknown): string {
  const p = typeof prompt === "string" ? prompt.trim() : "";
  if (!p) throw new OpError(ErrorCode.INVALID_PARAMS, "A generation needs a non-empty prompt.", 'e.g. figma.generateImage("flat illustration of a parcel on a doorstep", { parentId }).');
  if (p.length > 4000) throw new OpError(ErrorCode.INVALID_PARAMS, "The prompt is over 4,000 characters.", "Shorten it.");
  return p;
}

const SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"];

/** → base64 PNG bytes. */
export async function generateImage(prompt: unknown, opts: { size?: string; quality?: string } = {}, cfg: ByokConfig = loadByokConfig(), fetchImpl: AiFetch = (u, i) => fetch(u, i), signal?: AbortSignal): Promise<{ base64: string; model: string; size: string }> {
  const text = prompted(prompt);
  if (!cfg.openaiApiKey) {
    throw new OpError(ErrorCode.UNAUTHORIZED, "No image-generation key is configured.", "Set OPENAI_API_KEY (or FIGMA_MCP_OPENAI_API_KEY) in the MCP server's environment, or put openaiApiKey in the JSON file FIGMA_MCP_BYOK_CONFIG names, then restart the server.");
  }
  const size = opts.size && SIZES.includes(opts.size) ? opts.size : "1024x1024";
  const model = cfg.imageModel ?? DEFAULT_IMAGE_MODEL;
  const res = await fetchImpl("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.openaiApiKey}` },
    body: JSON.stringify({ model, prompt: text, size, n: 1, ...(opts.quality ? { quality: opts.quality } : {}) }),
    signal: byokSignal(signal),
  });
  if (res.status === 401 || res.status === 403) throw new OpError(ErrorCode.UNAUTHORIZED, `The image provider refused the key (${res.status}).`, "Check OPENAI_API_KEY is valid and has image access.");
  if (res.status === 429) throw new OpError(ErrorCode.INTERNAL, "The image provider is rate-limiting this key (429).", "Wait and retry, or use a key with a higher limit.");
  if (!res.ok) throw new OpError(ErrorCode.INTERNAL, `Image generation failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new OpError(ErrorCode.INTERNAL, "The image provider returned no image data.", "Retry; if it persists, try another model with FIGMA_MCP_IMAGE_MODEL.");
  return { base64: b64, model, size };
}

/** Elements an illustration needs. Everything else is dropped. */
const SVG_ELEMENTS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan",
  "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask", "use", "symbol", "pattern", "title", "desc",
]);
/** Elements dropped WITH their content (their content is code or a trigger). */
const SVG_DROP_WITH_CONTENT = new Set(["script", "style", "foreignobject", "set", "animate", "animatemotion", "animatetransform", "iframe", "object", "embed", "audio", "video", "image", "a", "metadata"]);
const SVG_ATTRS = new Set([
  "xmlns", "xmlns:xlink", "version", "viewbox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "d", "points", "transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap",
  "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit", "opacity", "clip-path", "clip-rule", "mask",
  "id", "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "spreadmethod", "fx", "fy", "fr",
  "patternunits", "patterncontentunits", "patterntransform", "preserveaspectratio", "font-size", "font-family", "font-weight",
  "font-style", "text-anchor", "dominant-baseline", "letter-spacing", "href", "xlink:href", "clippathunits", "maskunits", "maskcontentunits",
]);

/** XML character references and the five named entities, decoded — what a parser will see. */
function decodeEntities(v: string): string {
  return v.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);?/gi, (_m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16) || 0xfffd);
    if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10) || 0xfffd);
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[k] ?? "";
  });
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function safeAttrValue(name: string, value: string): boolean {
  const v = value.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
  if (/javascript:|vbscript:|data:|expression\(|@import/.test(v)) return false;
  // References stay inside the document: href="#id", fill="url(#id)".
  if ((name === "href" || name === "xlink:href") && !v.startsWith("#")) return false;
  if (/url\(/.test(v) && !/^url\(["']?#[^)]*\)$/.test(v)) return false;
  return true;
}

/**
 * Keep only an inert, self-contained SVG: the first <svg> element (up to the
 * </svg> that closes IT — not the last one in the reply), rebuilt from an
 * ALLOWLIST of elements and attributes. Attribute values are judged after
 * entity decoding (`&#x75;rl(` is `url(`), and written back escaped.
 */
export function sanitizeSvg(raw: string): string {
  const start = raw.search(/<svg[\s>/]/i);
  if (start < 0) throw new OpError(ErrorCode.INTERNAL, "The model did not return a complete <svg> element.", "Retry with a more concrete prompt (shape, colours, size).");
  const src = raw.slice(start);
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/\s*([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:[\s/]+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)[\s/]*?(\/?)>|[^<]+|</g;
  const attrRe = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let out = "";
  let dropDepth = 0;
  let dropTag = "";
  let svgDepth = 0;
  let closed = false;
  const open: string[] = []; // kept elements still open, to close if the reply was cut
  for (let m: RegExpExecArray | null; !closed && (m = token.exec(src)); ) {
    const [whole, closeName, openName, attrs = "", selfClose] = m;
    if (closeName) {
      const n = closeName.toLowerCase();
      if (dropDepth) {
        if (n === dropTag && --dropDepth === 0) dropTag = "";
        continue;
      }
      if (SVG_ELEMENTS.has(n)) {
        const at = open.lastIndexOf(closeName);
        if (at >= 0) {
          for (let k = open.length - 1; k > at; k--) out += `</${open[k]}>`;
          open.length = at;
          out += `</${closeName}>`;
        }
        if (n === "svg" && --svgDepth === 0) closed = true;
      }
      continue;
    }
    if (openName) {
      const n = openName.toLowerCase();
      if (dropDepth) {
        if (n === dropTag && !selfClose) dropDepth++;
        continue;
      }
      if (!SVG_ELEMENTS.has(n)) {
        if (SVG_DROP_WITH_CONTENT.has(n) && !selfClose) {
          dropDepth = 1;
          dropTag = n;
        }
        continue;
      }
      let kept = "";
      attrRe.lastIndex = 0;
      for (let a: RegExpExecArray | null; (a = attrRe.exec(attrs)); ) {
        const name = a[1]!.toLowerCase();
        if (!SVG_ATTRS.has(name) || a[2] === undefined) continue;
        const value = decodeEntities(a[2].replace(/^["']|["']$/g, ""));
        if (!safeAttrValue(name, value)) continue;
        kept += ` ${a[1]}="${escapeAttr(value)}"`;
      }
      out += `<${openName}${kept}${selfClose ? "/" : ""}>`;
      if (!selfClose) {
        open.push(openName);
        if (n === "svg") svgDepth++;
      }
      continue;
    }
    if (dropDepth || whole.startsWith("<")) continue; // comments, CDATA, doctype, PIs, stray "<"
    out += whole.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  // A reply cut off mid-element (or an unclosed dropped element that ate the
  // rest): close what is open so the result is still one well-formed <svg>.
  for (let k = open.length - 1; k >= 0; k--) out += `</${open[k]}>`;
  if (!/^<svg/i.test(out)) throw new OpError(ErrorCode.INTERNAL, "The model did not return a usable <svg> element.", "Retry with a more concrete prompt (shape, colours, size).");
  return out;
}

const BYOK_TIMEOUT_MS = 120_000;

/** The caller's signal plus a timeout: a provider that never answers must not hang the write. */
function byokSignal(signal?: AbortSignal): AbortSignal | undefined {
  return withTimeout(signal, BYOK_TIMEOUT_MS);
}

const finiteOr = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export async function generateSvg(prompt: unknown, opts: { width?: number; height?: number; style?: string } = {}, cfg: ByokConfig = loadByokConfig(), fetchImpl: AiFetch = (u, i) => fetch(u, i), signal?: AbortSignal): Promise<{ svg: string; model: string }> {
  const text = prompted(prompt);
  if (!cfg.anthropicApiKey) {
    throw new OpError(ErrorCode.UNAUTHORIZED, "No SVG-generation key is configured.", "Set ANTHROPIC_API_KEY (or FIGMA_MCP_ANTHROPIC_API_KEY) in the MCP server's environment, or put anthropicApiKey in the JSON file FIGMA_MCP_BYOK_CONFIG names, then restart the server.");
  }
  const w = Math.max(16, Math.min(2048, Math.round(finiteOr(opts.width, 512))));
  const h = Math.max(16, Math.min(2048, Math.round(finiteOr(opts.height, 512))));
  const model = cfg.svgModel ?? DEFAULT_SVG_MODEL;
  const instruction = `Draw this as a single self-contained SVG, viewBox="0 0 ${w} ${h}", width="${w}" height="${h}". Plain shapes and paths only: no <script>, no <foreignObject>, no external images or fonts, no CSS classes (inline fill/stroke attributes).${opts.style ? ` Style: ${opts.style}.` : ""} Reply with the SVG markup only.\n\nSubject: ${text}`;
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.anthropicApiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 8000, messages: [{ role: "user", content: instruction }] }),
    signal: byokSignal(signal),
  });
  if (res.status === 401 || res.status === 403) throw new OpError(ErrorCode.UNAUTHORIZED, `The SVG provider refused the key (${res.status}).`, "Check ANTHROPIC_API_KEY is valid.");
  if (res.status === 429) throw new OpError(ErrorCode.INTERNAL, "The SVG provider is rate-limiting this key (429).", "Wait and retry.");
  if (!res.ok) throw new OpError(ErrorCode.INTERNAL, `SVG generation failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, "Check FIGMA_MCP_SVG_MODEL names a model your key can use.");
  const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }>; stop_reason?: string };
  const out = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  if (body.stop_reason === "max_tokens" && !/<\/svg>/i.test(out)) {
    throw new OpError(ErrorCode.INTERNAL, "The SVG was cut off: the model hit its output limit before closing </svg>.", "Ask for a simpler drawing (fewer shapes, no fine detail) or a smaller size.");
  }
  return { svg: sanitizeSvg(out), model };
}
