/**
 * Local, free background removal for figma.removeBackground().
 *
 * The plugin renders the node (exportAsync, PNG), this process cuts the
 * subject out on the CPU with @imgly/background-removal-node (an ONNX model
 * that ships inside that package — no API key, no upload), and the plugin
 * places the transparent PNG. The bytes stay between this process and the
 * plugin: the agent makes one call and gets ids back.
 *
 * The package is OPTIONAL — it pulls in onnxruntime (~100 MB), which most
 * users never need — so it is loaded on first use and its absence is a clear
 * UNSUPPORTED_OPERATION with the one install line, not a crash.
 */
import { ErrorCode, OpError } from "./errors.js";
import { sniffImage } from "./image-file.js";

export const BG_REMOVAL_PACKAGE = "@imgly/background-removal-node";

/** PNG bytes in, PNG bytes (transparent background) out. */
export type BackgroundRemover = (png: Uint8Array, opts: { model?: "small" | "medium"; signal?: AbortSignal }) => Promise<Uint8Array>;

type ImglyModule = {
  removeBackground: (input: unknown, config?: Record<string, unknown>) => Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
};

/** Test seam: how the package is imported. */
export type ModuleLoader = () => Promise<unknown>;

// A variable specifier: TypeScript and esbuild must not try to resolve an
// optional package at build time.
const defaultModuleLoader: ModuleLoader = () => import(/* @vite-ignore */ BG_REMOVAL_PACKAGE as string);

let cached: Promise<BackgroundRemover> | null = null;

/** Test seam: forget the loaded remover. */
export function resetBackgroundRemover(): void {
  cached = null;
}

export function notInstalledError(): OpError {
  return new OpError(
    ErrorCode.UNSUPPORTED_OPERATION,
    `removeBackground needs the optional package ${BG_REMOVAL_PACKAGE}, which is not installed where this MCP server can find it.`,
    `Tell the user to install it once in the figma-plugin folder: \`npm i ${BG_REMOVAL_PACKAGE}\`, then restart the MCP server. It runs fully offline (no key, no upload). Do not retry until then.`,
  );
}

export function loadBackgroundRemover(loader: ModuleLoader = defaultModuleLoader): Promise<BackgroundRemover> {
  if (cached) return cached;
  const p = (async (): Promise<BackgroundRemover> => {
    let mod: ImglyModule;
    try {
      const m = (await loader()) as ImglyModule & { default?: ImglyModule };
      mod = typeof m.removeBackground === "function" ? m : (m.default as ImglyModule);
      if (!mod || typeof mod.removeBackground !== "function") throw new Error("no removeBackground export");
    } catch {
      throw notInstalledError();
    }
    return async (png, opts) => {
      const blob = new Blob([png], { type: "image/png" });
      const out = await mod.removeBackground(blob, {
        model: opts.model ?? "medium",
        output: { format: "image/png" },
      });
      return new Uint8Array(await out.arrayBuffer());
    };
  })();
  cached = p;
  // A failed load is not kept, so a transient failure is not pinned for the
  // life of the process (a package installed later still needs a restart:
  // Node caches the failed import — which is why the hint says restart).
  p.catch(() => {
    if (cached === p) cached = null;
  });
  return p;
}

/** Run the remover and check what comes back is a PNG. */
export async function removeBackgroundPng(png: Uint8Array, remover: BackgroundRemover, opts: { model?: "small" | "medium"; signal?: AbortSignal } = {}): Promise<Uint8Array> {
  if (sniffImage(png) !== "png") {
    throw new OpError(ErrorCode.INTERNAL, "The plugin's render of the node was not a PNG.", "Retry; if it persists, export the node with exportNode to check it renders.");
  }
  let out: Uint8Array;
  try {
    out = await remover(png, opts);
  } catch (e) {
    if (e instanceof OpError) throw e;
    throw new OpError(ErrorCode.INTERNAL, `Background removal failed: ${(e as Error).message.split("\n")[0]}`, "Retry with model: \"small\", or on a smaller node (scale: 1).");
  }
  if (opts.signal?.aborted) throw new OpError(ErrorCode.INTERNAL, "removeBackground was cancelled.", "Call again if it is still needed.");
  if (sniffImage(out) !== "png") {
    throw new OpError(ErrorCode.INTERNAL, "Background removal returned something that is not a PNG.", `Reinstall ${BG_REMOVAL_PACKAGE} and restart the MCP server.`);
  }
  return out;
}
