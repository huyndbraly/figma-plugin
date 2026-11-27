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
    ...(signal ? { signal } : {}),
  });
  if (res.status === 401 || res.status === 403) throw new OpError(ErrorCode.UNAUTHORIZED, `The image provider refused the key (${res.status}).`, "Check OPENAI_API_KEY is valid and has image access.");
  if (res.status === 429) throw new OpError(ErrorCode.INTERNAL, "The image provider is rate-limiting this key (429).", "Wait and retry, or use a key with a higher limit.");
  if (!res.ok) throw new OpError(ErrorCode.INTERNAL, `Image generation failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new OpError(ErrorCode.INTERNAL, "The image provider returned no image data.", "Retry; if it persists, try another model with FIGMA_MCP_IMAGE_MODEL.");
  return { base64: b64, model, size };
}

/**
 * Keep only a self-contained, inert SVG: the first <svg>…</svg>, no scripts,
 * no event handlers, no external references, no foreignObject.
 */
export function sanitizeSvg(raw: string): string {
  const m = /<svg[\s\S]*?<\/svg>/i.exec(raw);
  if (!m) throw new OpError(ErrorCode.INTERNAL, "The model did not return an <svg> element.", "Retry with a more concrete prompt (shape, colours, size).");
  let svg = m[0];
  svg = svg.replace(/<script[\s\S]*?<\/script>/gi, "");
  svg = svg.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  svg = svg.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  svg = svg.replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, "");
  svg = svg.replace(/url\(\s*["']?(?!#)[^)]*\)/gi, "none");
  return svg;
}

export async function generateSvg(prompt: unknown, opts: { width?: number; height?: number; style?: string } = {}, cfg: ByokConfig = loadByokConfig(), fetchImpl: AiFetch = (u, i) => fetch(u, i), signal?: AbortSignal): Promise<{ svg: string; model: string }> {
  const text = prompted(prompt);
  if (!cfg.anthropicApiKey) {
    throw new OpError(ErrorCode.UNAUTHORIZED, "No SVG-generation key is configured.", "Set ANTHROPIC_API_KEY (or FIGMA_MCP_ANTHROPIC_API_KEY) in the MCP server's environment, or put anthropicApiKey in the JSON file FIGMA_MCP_BYOK_CONFIG names, then restart the server.");
  }
  const w = Math.max(16, Math.min(2048, Math.round(opts.width ?? 512)));
  const h = Math.max(16, Math.min(2048, Math.round(opts.height ?? 512)));
  const model = cfg.svgModel ?? DEFAULT_SVG_MODEL;
  const instruction = `Draw this as a single self-contained SVG, viewBox="0 0 ${w} ${h}", width="${w}" height="${h}". Plain shapes and paths only: no <script>, no <foreignObject>, no external images or fonts, no CSS classes (inline fill/stroke attributes).${opts.style ? ` Style: ${opts.style}.` : ""} Reply with the SVG markup only.\n\nSubject: ${text}`;
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.anthropicApiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 8000, messages: [{ role: "user", content: instruction }] }),
    ...(signal ? { signal } : {}),
  });
  if (res.status === 401 || res.status === 403) throw new OpError(ErrorCode.UNAUTHORIZED, `The SVG provider refused the key (${res.status}).`, "Check ANTHROPIC_API_KEY is valid.");
  if (res.status === 429) throw new OpError(ErrorCode.INTERNAL, "The SVG provider is rate-limiting this key (429).", "Wait and retry.");
  if (!res.ok) throw new OpError(ErrorCode.INTERNAL, `SVG generation failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, "Check FIGMA_MCP_SVG_MODEL names a model your key can use.");
  const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const out = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  return { svg: sanitizeSvg(out), model };
}
