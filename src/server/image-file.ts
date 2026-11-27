/**
 * Image bytes from the server's own disk, for figma.loadImage({ filePath }).
 *
 * The agent names a file; the SERVER reads it and hands the plugin the bytes,
 * so no base64 ever passes through the agent's context. Only real images are
 * read: the first bytes must be PNG, JPEG or GIF (what figma.createImage
 * decodes), so a path pointed at a key file or a .env can never be shipped
 * into a Figma document, and the error never quotes what the file held.
 */
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCode, OpError } from "./errors.js";

/** Figma refuses images over 4096 px a side; 32 MB is far beyond any such PNG. */
export const MAX_IMAGE_FILE_BYTES = 32 * 1024 * 1024;

export type ImageKind = "png" | "jpeg" | "gif" | "webp";

/** The image type the leading bytes announce, or null. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null;
}

/**
 * A `filePath` → an absolute path. `~/x` is the user's home; `file://` URLs
 * are accepted. A relative path is refused: the server's working directory is
 * wherever the MCP client launched it, which the agent cannot know.
 */
export function resolveImagePath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new OpError(ErrorCode.INVALID_PARAMS, "filePath must be a non-empty string.", 'e.g. figma.loadImage({ filePath: "/Users/me/Pictures/hero.png", parentId }).');
  }
  let p = raw.trim();
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      throw new OpError(ErrorCode.INVALID_PARAMS, "That file:// URL is not a local path.", "Pass an absolute path instead.");
    }
  } else if (p === "~" || p.startsWith("~/")) {
    p = resolve(homedir(), p.slice(2));
  }
  if (!isAbsolute(p)) {
    throw new OpError(ErrorCode.INVALID_PARAMS, `filePath must be absolute (got a relative path).`, "The MCP server's working directory is not yours: pass the full path, e.g. /Users/me/project/assets/hero.png or ~/Pictures/hero.png.");
  }
  return resolve(p);
}

/** Read an image file → base64, after checking it IS an image Figma can decode. */
export async function readImageFile(raw: unknown): Promise<{ base64: string; kind: ImageKind; bytes: number; path: string }> {
  const path = resolveImagePath(raw);
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) throw new OpError(ErrorCode.INVALID_PARAMS, `${path} is not a file.`, "Pass the path of a .png, .jpg or .gif file.");
    size = st.size;
  } catch (e) {
    if (e instanceof OpError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      code === "ENOENT" ? `No file at ${path}.` : code === "EACCES" || code === "EPERM" ? `The MCP server may not read ${path}.` : `Could not read ${path} (${code ?? "error"}).`,
      "Check the path (absolute, on the machine the MCP server runs on).",
    );
  }
  if (size > MAX_IMAGE_FILE_BYTES) {
    throw new OpError(ErrorCode.INVALID_PARAMS, `${path} is ${(size / 1048576).toFixed(1)} MB — over the ${MAX_IMAGE_FILE_BYTES / 1048576} MB limit.`, "Downscale it first (Figma caps images at 4096 px a side anyway).");
  }
  const fh = await open(path, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const { bytesRead } = await fh.read(buf, off, size - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    buf = buf.subarray(0, off);
  } finally {
    await fh.close();
  }
  const kind = sniffImage(buf);
  if (kind === "webp") {
    throw new OpError(ErrorCode.INVALID_PARAMS, `${path} is a WebP image, which Figma's plugin API cannot decode.`, "Convert it to PNG or JPEG, or pass an https URL of a PNG/JPEG version.");
  }
  if (!kind) {
    // Never echo the content: the path might point at something private.
    throw new OpError(ErrorCode.INVALID_PARAMS, `${path} is not a PNG, JPEG or GIF image.`, "Pass the path of an image file; other files are never read into Figma.");
  }
  return { base64: buf.toString("base64"), kind, bytes: buf.length, path };
}
