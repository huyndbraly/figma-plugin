/**
 * figma.exportAssets — render many nodes and write them straight into a
 * folder of the codebase.
 *
 * export_node hands base64 back to the agent, which is right for one icon and
 * ruinous for fifty: every PNG crosses the context window as text. Here the
 * plugin renders (exportAsync, local, no rate limit), the SERVER writes the
 * bytes to disk, and the agent gets back only paths and sizes.
 *
 * When no Figma window is connected and the caller gave a fileKey and the
 * server has FIGMA_TOKEN, the same export runs through the REST API instead
 * (/v1/images, many ids per request, 429 Retry-After honoured).
 */
import { restError, retryDelayMs } from "./rest-hub.js";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { ErrorCode, OpError } from "./errors.js";

export type AssetFormat = "PNG" | "JPG" | "SVG" | "PDF";

export interface ExportAssetsOptions {
  /** ABSOLUTE folder to write into (created if missing). */
  dir: string;
  /** One format or several. Default PNG. */
  formats?: AssetFormat[] | AssetFormat;
  /** Raster scales (PNG/JPG only). Default [1]. */
  scales?: number[];
  /** How a scale is named: "ios" → name@2x.png (default), "android" → drawable-xhdpi/name.png, "web" → name-2x.png. */
  scaleNaming?: "ios" | "android" | "web";
  /** Lowercase-dashed file names ("Icon/Arrow Left" → icon-arrow-left). Default true. */
  kebab?: boolean;
  /** Keep a "Group/Name" path as sub-folders instead of flattening it. Default false. */
  folders?: boolean;
  /** Replace files that already exist. Default false: they are skipped and listed. */
  overwrite?: boolean;
  /** "auto" (plugin if a window is connected, else REST), "plugin" or "rest". */
  source?: "auto" | "plugin" | "rest";
  /** REST only: the file key (from the file URL). */
  fileKey?: string;
}

export interface ExportTarget {
  nodeId: string;
  name: string;
}

export interface WrittenFile {
  nodeId: string;
  name: string;
  path: string;
  format: AssetFormat;
  scale?: number;
  bytes: number;
}

export interface ExportAssetsResult {
  dir: string;
  source: "plugin" | "rest";
  files: WrittenFile[];
  skipped: Array<{ path: string; reason: string }>;
  failed: Array<{ nodeId: string; name: string; format: AssetFormat; scale?: number; error: string }>;
  totalBytes: number;
}

/** Hard limits: a runaway call must not fill the disk. */
export const MAX_ASSET_FILES = 1000;
export const MAX_ASSET_TOTAL_BYTES = 500 * 1024 * 1024;

const ANDROID_DENSITY: Record<string, string> = { "1": "mdpi", "1.5": "hdpi", "2": "xhdpi", "3": "xxhdpi", "4": "xxxhdpi" };

/** "Icon/Arrow Left" → "icon-arrow-left" (accents stripped; never a path). */
export function safeSegment(name: string, kebab = true): string {
  let s = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .trim();
  s = kebab
    ? s
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
    : s.replace(/[^A-Za-z0-9._-]+/g, "_");
  s = s.replace(/^[-_.]+|[-_.]+$/g, "");
  return s || "asset";
}

export function normalizeFormats(f: unknown): AssetFormat[] {
  const list = Array.isArray(f) ? f : f === undefined || f === null ? ["PNG"] : [f];
  const out: AssetFormat[] = [];
  for (const raw of list) {
    const v = String(raw).toUpperCase();
    const fmt = v === "JPEG" ? "JPG" : v;
    if (fmt !== "PNG" && fmt !== "JPG" && fmt !== "SVG" && fmt !== "PDF") {
      throw new OpError(ErrorCode.INVALID_PARAMS, `Unsupported asset format "${String(raw)}".`, "Use PNG, JPG, SVG or PDF.");
    }
    if (!out.includes(fmt)) out.push(fmt);
  }
  return out;
}

export function normalizeScales(s: unknown): number[] {
  const list = Array.isArray(s) ? s : s === undefined || s === null ? [1] : [s];
  const out: number[] = [];
  for (const v of list) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 4) {
      throw new OpError(ErrorCode.INVALID_PARAMS, `Scale ${String(v)} is out of range.`, "Scales are 0.01 … 4 (Figma's export limit), e.g. [1, 2, 3].");
    }
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** The folder, checked: absolute, resolved, and not the filesystem root. */
export function resolveDir(dir: unknown, who = "exportAssets"): string {
  if (typeof dir !== "string" || !dir.trim()) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `${who} needs a \`dir\`.`,
      "Pass an ABSOLUTE folder in your codebase, e.g. { dir: \"/Users/me/app/src/assets/icons\" }.",
    );
  }
  if (!isAbsolute(dir)) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `\`dir\` must be an absolute path (got "${dir}").`,
      "The MCP server's working directory is not your project — a relative path would land somewhere else. Pass the full path.",
    );
  }
  const abs = resolve(dir);
  if (abs === sep || /^[A-Za-z]:\\?$/.test(abs)) {
    throw new OpError(ErrorCode.INVALID_PARAMS, "Refusing to write assets into the filesystem root.", "Pass a folder inside your project.");
  }
  return abs;
}

/**
 * Every file one target produces, with its path. Names that collide (two
 * layers called "Icon") get -2, -3 … in the order the targets came in.
 */
export function planFiles(
  targets: ExportTarget[],
  dir: string,
  formats: AssetFormat[],
  scales: number[],
  opts: Pick<ExportAssetsOptions, "scaleNaming" | "kebab" | "folders">,
): Array<{ target: ExportTarget; format: AssetFormat; scale?: number; path: string }> {
  const kebab = opts.kebab !== false;
  const naming = opts.scaleNaming ?? "ios";
  const used = new Map<string, number>();
  const plan: Array<{ target: ExportTarget; format: AssetFormat; scale?: number; path: string }> = [];
  for (const t of targets) {
    const parts = opts.folders ? t.name.split("/").map((p) => safeSegment(p, kebab)) : [safeSegment(t.name.replace(/\//g, " "), kebab)];
    let base = parts.join("/");
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    if (n > 1) base = `${base}-${n}`;
    for (const format of formats) {
      const ext = format.toLowerCase();
      const raster = format === "PNG" || format === "JPG";
      for (const scale of raster ? scales : [undefined]) {
        let rel: string;
        if (!raster || scale === undefined) rel = `${base}.${ext}`;
        else if (naming === "android") rel = `drawable-${ANDROID_DENSITY[String(scale)] ?? `${scale}x`}/${base}.${ext}`;
        else if (naming === "web") rel = scale === 1 ? `${base}.${ext}` : `${base}-${scale}x.${ext}`;
        else rel = scale === 1 ? `${base}.${ext}` : `${base}@${scale}x.${ext}`;
        const path = resolve(dir, rel);
        // safeSegment never emits "..", but the check is what makes that a guarantee.
        if (path !== dir && !path.startsWith(dir + sep)) throw new OpError(ErrorCode.INTERNAL, `Asset path escaped the folder: ${rel}`);
        plan.push({ target: t, format, ...(raster && scale !== undefined ? { scale } : {}), path });
      }
    }
  }
  return plan;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Renders one (node, format, scale) to bytes — the plugin or the REST API. */
export type Renderer = (target: ExportTarget, format: AssetFormat, scale: number | undefined) => Promise<Uint8Array>;

export async function writeAssets(
  targets: ExportTarget[],
  options: ExportAssetsOptions,
  render: Renderer,
  source: "plugin" | "rest",
  progress?: (done: number, total: number) => void,
): Promise<ExportAssetsResult> {
  const dir = resolveDir(options.dir);
  const formats = normalizeFormats(options.formats);
  const scales = normalizeScales(options.scales);
  const plan = planFiles(targets, dir, formats, scales, options);
  if (plan.length > MAX_ASSET_FILES) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `This export would write ${plan.length} files (limit ${MAX_ASSET_FILES}).`,
      "Export fewer nodes, formats or scales per call.",
    );
  }
  const result: ExportAssetsResult = { dir, source, files: [], skipped: [], failed: [], totalBytes: 0 };
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i]!;
    if (!options.overwrite && (await exists(item.path))) {
      result.skipped.push({ path: item.path, reason: "exists (pass overwrite: true to replace)" });
      continue;
    }
    try {
      const bytes = await render(item.target, item.format, item.scale);
      if (result.totalBytes + bytes.length > MAX_ASSET_TOTAL_BYTES) {
        result.failed.push({ nodeId: item.target.nodeId, name: item.target.name, format: item.format, ...(item.scale !== undefined ? { scale: item.scale } : {}), error: `stopped: over the ${MAX_ASSET_TOTAL_BYTES / 1024 / 1024}MB total limit` });
        break;
      }
      await mkdir(join(item.path, ".."), { recursive: true });
      await writeFile(item.path, bytes);
      result.totalBytes += bytes.length;
      result.files.push({ nodeId: item.target.nodeId, name: item.target.name, path: item.path, format: item.format, ...(item.scale !== undefined ? { scale: item.scale } : {}), bytes: bytes.length });
    } catch (e) {
      result.failed.push({
        nodeId: item.target.nodeId,
        name: item.target.name,
        format: item.format,
        ...(item.scale !== undefined ? { scale: item.scale } : {}),
        error: e instanceof Error ? e.message : String(e),
      });
    }
    progress?.(i + 1, plan.length);
  }
  return result;
}

// ---------------------------------------------------------------------------
// REST fallback
// ---------------------------------------------------------------------------

export type RestFetch = (url: string, init: RequestInit) => Promise<Response>;

const REST_BASE = "https://api.figma.com/v1";
/** Ids per /v1/images request — Figma accepts long lists; this keeps URLs sane. */
const REST_BATCH = 50;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        rej(new Error("cancelled"));
      },
      { once: true },
    );
  });
}

/** GET with the token; a 429 is retried only for a short Retry-After (retryDelayMs). */
async function restGet(url: string, token: string, fetchImpl: RestFetch, signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers: { "X-Figma-Token": token }, ...(signal ? { signal } : {}) });
    if (res.status === 429) {
      const ms = retryDelayMs(res.headers, attempt);
      if (ms !== null) {
        await wait(ms, signal);
        continue;
      }
    }
    if (!res.ok) throw restError(res.status, await res.text().catch(() => ""), "export from this file", res.headers);
    return res.json();
  }
}

/**
 * A Renderer backed by /v1/images. URLs are fetched lazily, one request per
 * (format, scale) for up to REST_BATCH ids, then each image downloaded.
 */
export function restRenderer(
  fileKey: string,
  token: string,
  allIds: string[],
  download: (url: string) => Promise<Uint8Array>,
  fetchImpl: RestFetch,
  signal?: AbortSignal,
): Renderer {
  const urls = new Map<string, Promise<Record<string, string | null>>>();
  const urlFor = (format: AssetFormat, scale: number | undefined, id: string): Promise<string | null> => {
    const idx = allIds.indexOf(id);
    const batch = Math.floor(Math.max(0, idx) / REST_BATCH);
    const key = `${format}|${scale ?? ""}|${batch}`;
    let p = urls.get(key);
    if (!p) {
      const ids = allIds.slice(batch * REST_BATCH, batch * REST_BATCH + REST_BATCH);
      const q = new URLSearchParams({ ids: ids.join(","), format: format.toLowerCase(), ...(scale !== undefined ? { scale: String(scale) } : {}) });
      p = restGet(`${REST_BASE}/images/${encodeURIComponent(fileKey)}?${q}`, token, fetchImpl, signal).then((body) => {
        const b = body as { err?: string | null; images?: Record<string, string | null> };
        if (b.err) throw new OpError(ErrorCode.INTERNAL, `Figma could not render: ${b.err}`);
        return b.images ?? {};
      });
      urls.set(key, p);
    }
    return p.then((m) => m[id] ?? null);
  };
  return async (target, format, scale) => {
    const url = await urlFor(format, scale, target.nodeId);
    if (!url) throw new Error("Figma returned no image for this node (hidden, empty, or not renderable).");
    return download(url);
  };
}

/** Node names for REST targets (one /nodes call), so files are named like the layers. */
export async function restTargets(fileKey: string, ids: string[], token: string, fetchImpl: RestFetch, signal?: AbortSignal): Promise<ExportTarget[]> {
  const out: ExportTarget[] = [];
  for (let i = 0; i < ids.length; i += REST_BATCH) {
    const slice = ids.slice(i, i + REST_BATCH);
    const body = (await restGet(`${REST_BASE}/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(slice.join(","))}&depth=1`, token, fetchImpl, signal)) as {
      nodes?: Record<string, { document?: { name?: string } } | null>;
    };
    for (const id of slice) {
      const n = body.nodes?.[id];
      if (!n) throw new OpError(ErrorCode.NODE_NOT_FOUND, `Node "${id}" is not in file ${fileKey}.`, "Ids come from the file URL (?node-id=1-2 → 1:2) or a read.");
      out.push({ nodeId: id, name: n.document?.name ?? id });
    }
  }
  return out;
}
