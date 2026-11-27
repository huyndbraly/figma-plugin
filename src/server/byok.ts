/**
 * Bring-your-own-key generation: an image (OpenAI Images, Google Gemini or
 * Black Forest Labs Flux) or an SVG (Anthropic Messages) from a prompt,
 * placed on the canvas by figma_write.
 *
 * Keys come, per provider, from the plugin panel's "AI Image Key" field
 * (held in RAM — ai-keys.ts), else the environment (OPENAI_API_KEY,
 * GEMINI_API_KEY / GOOGLE_API_KEY, BFL_API_KEY, ANTHROPIC_API_KEY, or the
 * FIGMA_MCP_-prefixed variants), else an optional JSON file named by
 * FIGMA_MCP_BYOK_CONFIG. Like the Figma token, a key is only ever a request
 * header: it is not logged, not echoed (provider error text is scrubbed of
 * it), and every error says where to set it, never what it was set to.
 */
import { readFileSync } from "node:fs";
import { ErrorCode, OpError } from "./errors.js";
import { withTimeout } from "./rest-hub.js";
import { aiKeys, type AiKeyStore } from "./ai-keys.js";
import { sniffImage } from "./image-file.js";
import { AI_PROVIDER_LABELS, IMAGE_PROVIDERS, isImageProvider, type ImageProvider } from "../shared/ai-key.js";

export type AiFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ByokConfig {
  openaiApiKey?: string;
  geminiApiKey?: string;
  fluxApiKey?: string;
  anthropicApiKey?: string;
  /** Which image provider to use when the call names none (and it has a key). */
  imageProvider?: ImageProvider;
  /** OpenAI image model (FIGMA_MCP_IMAGE_MODEL). */
  imageModel?: string;
  geminiModel?: string;
  fluxModel?: string;
  svgModel?: string;
}

export const DEFAULT_IMAGE_MODEL = "gpt-image-1";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-image";
export const DEFAULT_FLUX_MODEL = "flux-pro-1.1";
export const DEFAULT_SVG_MODEL = "claude-sonnet-5-5";

const pick = (...v: Array<unknown>): string | undefined => {
  const hit = v.find((x) => typeof x === "string" && x.trim());
  return typeof hit === "string" ? hit.trim() : undefined;
};

/** The environment's (and config file's) keys alone — what figma_status shows as source "env". */
export function envAiKeys(env: NodeJS.ProcessEnv = process.env, file: ByokConfig = {}): { openai?: string; gemini?: string; flux?: string; anthropic?: string } {
  return {
    openai: pick(env.FIGMA_MCP_OPENAI_API_KEY, env.OPENAI_API_KEY, file.openaiApiKey),
    gemini: pick(env.FIGMA_MCP_GEMINI_API_KEY, env.GEMINI_API_KEY, env.GOOGLE_API_KEY, file.geminiApiKey),
    flux: pick(env.FIGMA_MCP_FLUX_API_KEY, env.BFL_API_KEY, file.fluxApiKey),
    anthropic: pick(env.FIGMA_MCP_ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY, file.anthropicApiKey),
  };
}

export function readByokFile(env: NodeJS.ProcessEnv = process.env): ByokConfig {
  const path = env.FIGMA_MCP_BYOK_CONFIG;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ByokConfig;
  } catch {
    throw new OpError(ErrorCode.INVALID_PARAMS, "FIGMA_MCP_BYOK_CONFIG points at a file that is not readable JSON.", "It should hold { openaiApiKey?, geminiApiKey?, fluxApiKey?, anthropicApiKey?, imageProvider?, imageModel?, geminiModel?, fluxModel?, svgModel? }.");
  }
}

/** Panel keys first (the user typed them for this), then env, then the config file. */
export function loadByokConfig(env: NodeJS.ProcessEnv = process.env, panel: AiKeyStore = aiKeys): ByokConfig {
  const file = readByokFile(env);
  const fromEnv = envAiKeys(env, file);
  const key = (p: "openai" | "gemini" | "flux" | "anthropic") => panel.get(p) ?? fromEnv[p];
  const provider = pick(env.FIGMA_MCP_IMAGE_PROVIDER, file.imageProvider);
  const out: ByokConfig = {
    imageModel: pick(env.FIGMA_MCP_IMAGE_MODEL, file.imageModel) ?? DEFAULT_IMAGE_MODEL,
    geminiModel: pick(env.FIGMA_MCP_GEMINI_MODEL, file.geminiModel) ?? DEFAULT_GEMINI_MODEL,
    fluxModel: pick(env.FIGMA_MCP_FLUX_MODEL, file.fluxModel) ?? DEFAULT_FLUX_MODEL,
    svgModel: pick(env.FIGMA_MCP_SVG_MODEL, file.svgModel) ?? DEFAULT_SVG_MODEL,
    ...(isImageProvider(provider) ? { imageProvider: provider } : {}),
  };
  const o = key("openai"), g = key("gemini"), f = key("flux"), a = key("anthropic");
  if (o) out.openaiApiKey = o;
  if (g) out.geminiApiKey = g;
  if (f) out.fluxApiKey = f;
  if (a) out.anthropicApiKey = a;
  return out;
}

function prompted(prompt: unknown): string {
  const p = typeof prompt === "string" ? prompt.trim() : "";
  if (!p) throw new OpError(ErrorCode.INVALID_PARAMS, "A generation needs a non-empty prompt.", 'e.g. figma.generateImage("flat illustration of a parcel on a doorstep", { parentId }).');
  if (p.length > 4000) throw new OpError(ErrorCode.INVALID_PARAMS, "The prompt is over 4,000 characters.", "Shorten it.");
  return p;
}

const SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"];

const KEY_HINT = "Ask the user to paste a key into the plugin panel's AI Image Key field (pick the provider), or to set OPENAI_API_KEY / GEMINI_API_KEY / BFL_API_KEY in the MCP server's environment. Never ask for a key in chat.";

function keyOf(cfg: ByokConfig, p: ImageProvider): string | undefined {
  return p === "openai" ? cfg.openaiApiKey : p === "gemini" ? cfg.geminiApiKey : cfg.fluxApiKey;
}

/** The provider a call uses: the one asked for, else the preferred one, else the first with a key. */
export function chooseImageProvider(cfg: ByokConfig, asked?: unknown): ImageProvider {
  if (asked !== undefined) {
    if (!isImageProvider(asked)) throw new OpError(ErrorCode.INVALID_PARAMS, `Unknown image provider ${JSON.stringify(asked)}.`, `Use one of: ${IMAGE_PROVIDERS.join(", ")}.`);
    if (!keyOf(cfg, asked)) throw new OpError(ErrorCode.UNAUTHORIZED, `No ${AI_PROVIDER_LABELS[asked]} key is configured.`, KEY_HINT);
    return asked;
  }
  if (cfg.imageProvider && keyOf(cfg, cfg.imageProvider)) return cfg.imageProvider;
  const any = IMAGE_PROVIDERS.find((p) => keyOf(cfg, p));
  if (!any) throw new OpError(ErrorCode.UNAUTHORIZED, "No image-generation key is configured (OpenAI, Gemini or Flux).", KEY_HINT);
  return any;
}

/** Provider error text with the key scrubbed out, short. */
function scrub(text: string, key: string): string {
  return (key ? text.split(key).join("…") : text).replace(/\s+/g, " ").slice(0, 200);
}

function refused(provider: ImageProvider, status: number): OpError {
  return new OpError(ErrorCode.UNAUTHORIZED, `${AI_PROVIDER_LABELS[provider]} refused the key (${status}).`, `Check the ${AI_PROVIDER_LABELS[provider]} key is valid and has image access; replace it in the plugin panel's AI Image Key field.`);
}

function rateLimited(provider: ImageProvider): OpError {
  return new OpError(ErrorCode.RATE_LIMITED, `${AI_PROVIDER_LABELS[provider]} is rate-limiting this key (429).`, "Wait and retry, use another provider ({ provider }), or a key with a higher limit.");
}

/** The aspect ratio Gemini takes for one of the OpenAI-style sizes. */
function aspectOf(size: string): string {
  return size === "1536x1024" ? "3:2" : size === "1024x1536" ? "2:3" : "1:1";
}

function dims(size: string): { w: number; h: number } {
  const m = /^(\d+)x(\d+)$/.exec(size);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1024, h: 1024 };
}

export interface GenerateImageOptions {
  size?: string;
  quality?: string;
  provider?: unknown;
  /** Test seam: Flux's polling delay. */
  sleep?: (ms: number) => Promise<void>;
}

/** → base64 image bytes (PNG or JPEG) from the chosen provider. */
export async function generateImage(prompt: unknown, opts: GenerateImageOptions = {}, cfg: ByokConfig = loadByokConfig(), fetchImpl: AiFetch = (u, i) => fetch(u, i), signal?: AbortSignal): Promise<{ base64: string; model: string; size: string; provider: ImageProvider }> {
  const text = prompted(prompt);
  const provider = chooseImageProvider(cfg, opts.provider);
  const size = opts.size && SIZES.includes(opts.size) ? opts.size : "1024x1024";
  const key = keyOf(cfg, provider)!;
  let out: { base64: string; model: string };
  if (provider === "openai") out = await openaiImage(text, size, opts.quality, key, cfg, fetchImpl, signal);
  else if (provider === "gemini") out = await geminiImage(text, size, key, cfg, fetchImpl, signal);
  else out = await fluxImage(text, size, key, cfg, fetchImpl, signal, opts.sleep);
  const kind = sniffImage(Buffer.from(out.base64.slice(0, 64), "base64"));
  if (kind !== "png" && kind !== "jpeg") {
    throw new OpError(ErrorCode.INTERNAL, `${AI_PROVIDER_LABELS[provider]} returned an image Figma cannot decode (${kind ?? "unknown format"}).`, "Retry, or use another provider ({ provider }).");
  }
  return { ...out, size, provider };
}

async function openaiImage(text: string, size: string, quality: string | undefined, key: string, cfg: ByokConfig, fetchImpl: AiFetch, signal?: AbortSignal): Promise<{ base64: string; model: string }> {
  const model = cfg.imageModel ?? DEFAULT_IMAGE_MODEL;
  const res = await fetchImpl("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, prompt: text, size, n: 1, ...(quality ? { quality } : {}) }),
    signal: byokSignal(signal),
  });
  if (res.status === 401 || res.status === 403) throw refused("openai", res.status);
  if (res.status === 429) throw rateLimited("openai");
  if (!res.ok) throw new OpError(ErrorCode.INTERNAL, `Image generation failed: HTTP ${res.status} ${scrub(await res.text(), key)}`, "Check FIGMA_MCP_IMAGE_MODEL names a model the key can use.");
  const body = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new OpError(ErrorCode.INTERNAL, "The image provider returned no image data.", "Retry; if it persists, try another model with FIGMA_MCP_IMAGE_MODEL.");
  return { base64: b64, model };
}

async function geminiImage(text: string, size: string, key: string, cfg: ByokConfig, fetchImpl: AiFetch, signal?: AbortSignal): Promise<{ base64: string; model: string }> {
  const model = cfg.geminiModel ?? DEFAULT_GEMINI_MODEL;
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspectOf(size) } },
    }),
    signal: byokSignal(signal),
  });
  if (res.status === 401 || res.status === 403) throw refused("gemini", res.status);
  if (res.status === 429) throw rateLimited("gemini");
  if (!res.ok) {
    const body = await res.text();
    // Google answers a bad key with 400 API_KEY_INVALID, not 401.
    if (/API_KEY_INVALID|API key not valid/i.test(body)) throw refused("gemini", res.status);
    throw new OpError(ErrorCode.INTERNAL, `Image generation failed: HTTP ${res.status} ${scrub(body, key)}`, "Check FIGMA_MCP_GEMINI_MODEL names an image model the key can use.");
  }
  type Part = { inlineData?: { data?: string }; inline_data?: { data?: string }; text?: string };
  const body = (await res.json()) as { candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>; promptFeedback?: { blockReason?: string } };
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const b64 = parts.map((p) => p.inlineData?.data ?? p.inline_data?.data).find((d) => typeof d === "string" && d);
  if (!b64) {
    const why = body.promptFeedback?.blockReason ?? body.candidates?.[0]?.finishReason;
    throw new OpError(ErrorCode.INTERNAL, `Gemini returned no image${why ? ` (${why})` : ""}.`, "Rephrase the prompt (Gemini may have declined it), or use another provider.");
  }
  return { base64: b64, model };
}

const FLUX_DEADLINE_MS = 110_000;

/** Only Black Forest Labs' own hosts get the key. */
function isBflHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "bfl.ai" || u.hostname.endsWith(".bfl.ai") || u.hostname.endsWith(".bfl.ml"));
  } catch {
    return false;
  }
}

async function fluxImage(text: string, size: string, key: string, cfg: ByokConfig, fetchImpl: AiFetch, signal?: AbortSignal, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<{ base64: string; model: string }> {
  const model = cfg.fluxModel ?? DEFAULT_FLUX_MODEL;
  const { w, h } = dims(size === "auto" ? "1024x1024" : size);
  const res = await fetchImpl(`https://api.bfl.ai/v1/${encodeURIComponent(model)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-key": key },
    body: JSON.stringify({ prompt: text, width: w, height: h, output_format: "png" }),
    signal: byokSignal(signal),
  });
  if (res.status === 401 || res.status === 403) throw refused("flux", res.status);
  if (res.status === 429) throw rateLimited("flux");
  if (!res.ok) throw new OpError(ErrorCode.INTERNAL, `Image generation failed: HTTP ${res.status} ${scrub(await res.text(), key)}`, "Check FIGMA_MCP_FLUX_MODEL names a model the key can use (e.g. flux-pro-1.1, flux-dev).");
  const job = (await res.json()) as { id?: string; polling_url?: string };
  if (!job.id && !job.polling_url) throw new OpError(ErrorCode.INTERNAL, "Flux returned no job id.", "Retry.");
  const pollUrl = job.polling_url ?? `https://api.bfl.ai/v1/get_result?id=${encodeURIComponent(job.id!)}`;
  if (!isBflHost(pollUrl)) throw new OpError(ErrorCode.INTERNAL, "Flux sent a polling URL outside bfl.ai; it was not followed.", "Retry; report it if it persists.");
  const deadline = Date.now() + FLUX_DEADLINE_MS;
  for (;;) {
    if (signal?.aborted) throw new OpError(ErrorCode.INTERNAL, "generateImage was cancelled.", "Call again if it is still needed.");
    const poll = await fetchImpl(pollUrl, { method: "GET", headers: { accept: "application/json", "x-key": key }, signal: byokSignal(signal) });
    if (poll.status === 401 || poll.status === 403) throw refused("flux", poll.status);
    if (poll.status === 429) throw rateLimited("flux");
    if (!poll.ok) throw new OpError(ErrorCode.INTERNAL, `Flux polling failed: HTTP ${poll.status}`, "Retry.");
    const st = (await poll.json()) as { status?: string; result?: { sample?: string } };
    if (st.status === "Ready") {
      const sample = st.result?.sample;
      if (typeof sample !== "string" || !/^https:\/\//i.test(sample)) throw new OpError(ErrorCode.INTERNAL, "Flux finished without an image URL.", "Retry.");
      // The signed delivery URL needs no key — and never gets one.
      const img = await fetchImpl(sample, { method: "GET", signal: byokSignal(signal) });
      if (!img.ok) throw new OpError(ErrorCode.INTERNAL, `Downloading the Flux image failed: HTTP ${img.status}`, "Retry (the link expires after a few minutes).");
      return { base64: Buffer.from(await img.arrayBuffer()).toString("base64"), model };
    }
    if (st.status && st.status !== "Pending" && st.status !== "Queued" && st.status !== "Processing") {
      throw new OpError(ErrorCode.INTERNAL, `Flux did not make the image: ${st.status}.`, /moderat/i.test(st.status) ? "The prompt or result was moderated; rephrase it." : "Retry, or use another provider.");
    }
    if (Date.now() > deadline) throw new OpError(ErrorCode.INTERNAL, "Flux did not finish within 110 s.", "Retry, or use a faster model (FIGMA_MCP_FLUX_MODEL=flux-dev).");
    await sleep(1000);
  }
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
    // Out of Unicode's range (`&#x110000;`) is a replacement character, never a RangeError.
    const cp = (n: number) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\ufffd");
    if (k.startsWith("#x")) return cp(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return cp(parseInt(k.slice(1), 10));
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

/** A code point XML 1.0 allows in a character reference. */
function xmlCharOk(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
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
          // Depth moves only on a close that matched an open we kept.
          if (n === "svg" && --svgDepth === 0) closed = true;
        }
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
      } else if (n === "svg" && svgDepth === 0) closed = true; // `<svg/>` is the whole document
      continue;
    }
    if (dropDepth || whole.startsWith("<")) continue; // comments, CDATA, doctype, PIs, stray "<"
    // Text: a bare `&` (AT&T) or an HTML-only entity (&nbsp;) is not XML.
    out += whole
      // Case-sensitive, as XML is: `&AMP;` and `&#X41;` are not references.
      .replace(/&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));|&/g, (m, named, dec, hex) => {
        if (named) return m;
        if (dec === undefined && hex === undefined) return "&amp;";
        // A numeric reference must name a character XML allows, or the whole SVG fails to parse.
        const cp = dec !== undefined ? Number(dec) : parseInt(hex, 16);
        return xmlCharOk(cp) ? m : "&amp;" + m.slice(1);
      })
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
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

const scrubText = (text: string, key: string | undefined): string => (key ? text.split(key).join("…") : text).replace(/\s+/g, " ").slice(0, 200);

const finiteOr = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export async function generateSvg(prompt: unknown, opts: { width?: number; height?: number; style?: string } = {}, cfg: ByokConfig = loadByokConfig(), fetchImpl: AiFetch = (u, i) => fetch(u, i), signal?: AbortSignal): Promise<{ svg: string; model: string }> {
  const text = prompted(prompt);
  if (!cfg.anthropicApiKey) {
    throw new OpError(ErrorCode.UNAUTHORIZED, "No SVG-generation key is configured.", "Ask the user to paste an Anthropic key into the plugin panel's AI Image Key field (provider Anthropic), or set ANTHROPIC_API_KEY in the MCP server's environment. Never ask for a key in chat.");
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
  if (res.status === 401 || res.status === 403) throw new OpError(ErrorCode.UNAUTHORIZED, `The SVG provider refused the key (${res.status}).`, "Check the Anthropic key is valid; replace it in the plugin panel's AI Image Key field.");
  if (res.status === 429) throw new OpError(ErrorCode.RATE_LIMITED, "The SVG provider is rate-limiting this key (429).", "Wait and retry.");
  if (!res.ok) throw new OpError(ErrorCode.INTERNAL, `SVG generation failed: HTTP ${res.status} ${scrubText(await res.text(), cfg.anthropicApiKey)}`, "Check FIGMA_MCP_SVG_MODEL names a model your key can use.");
  const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }>; stop_reason?: string };
  const out = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  if (body.stop_reason === "max_tokens" && !/<\/svg>/i.test(out)) {
    throw new OpError(ErrorCode.INTERNAL, "The SVG was cut off: the model hit its output limit before closing </svg>.", "Ask for a simpler drawing (fewer shapes, no fine detail) or a smaller size.");
  }
  return { svg: sanitizeSvg(out), model };
}
