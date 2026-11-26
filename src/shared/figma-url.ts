/**
 * Figma links — what "Copy link to selection" puts on the clipboard.
 *
 *   https://www.figma.com/design/<fileKey>/<File-Name>?node-id=12-345&t=…
 *   https://www.figma.com/file/<fileKey>/<File-Name>?node-id=12%3A345
 *   https://www.figma.com/design/<fileKey>/branch/<branchKey>/<File-Name>
 *   https://www.figma.com/proto/<fileKey>/…  ·  /board/<fileKey>/… (FigJam)
 *
 * Teams already hand these to agents; parsing them here means the agent never
 * has to translate "12-345" to "12:345" or guess which window the link means.
 * Pure: no fs, no network.
 */

export interface FigmaLink {
  /** The key the REST API takes (the branch key for a branch link). */
  fileKey: string;
  /** "12:345", when the link points at a node. */
  nodeId?: string;
  /** The file-name slug from the path ("Glass-Liquid---ArtMate-IOS-Copy"), when present. */
  slug?: string;
}

const KINDS = new Set(["file", "design", "proto", "board", "slides", "make"]);

/** Parse a Figma link; null when the string is not one. */
export function parseFigmaLink(input: unknown): FigmaLink | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const kind = parts[0]?.toLowerCase();
  if (!kind || !KINDS.has(kind) || !parts[1]) return null;
  let fileKey = parts[1];
  let rest = parts.slice(2);
  if (rest[0] === "branch" && rest[1]) {
    fileKey = rest[1];
    rest = rest.slice(2);
  }
  if (!/^[A-Za-z0-9]+$/.test(fileKey)) return null;
  const out: FigmaLink = { fileKey };
  if (rest[0]) out.slug = decodeURIComponent(rest[0]);
  const node = url.searchParams.get("node-id");
  if (node) {
    // Links write "12-345"; older ones "12:345" (URL-encoded or not). Nested
    // instance ids ("I12-345;6-7") keep their structure.
    const id = node.replace(/(\d)-(\d)/g, "$1:$2");
    if (/^I?\d+:\d+(;\d+:\d+)*$/.test(id)) out.nodeId = id;
  }
  return out;
}

/**
 * A comparable form of a file name: accents and punctuation gone, lowercase.
 * "Glass Liquid - ArtMate IOS (Copy)" and the slug "Glass-Liquid---ArtMate-IOS-Copy"
 * both become "glassliquidartmateioscopy".
 */
export function fileNameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
