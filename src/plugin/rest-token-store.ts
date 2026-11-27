/**
 * The REST token as the plugin keeps it in figma.clientStorage — the parsing
 * and the save/clear rules, apart from main.ts so they can be tested without
 * a Figma runtime.
 *
 * Stored shape: `{ token, expiresAt, savedAt }`. A Clear is stored too, as a
 * tombstone `{ token: null, savedAt }`: every window shares this storage but
 * caches it, and the server keeps the NEWEST `savedAt` — so a window that
 * missed a Clear cannot re-send the token it remembers. Legacy shape: the
 * bare token string (no savedAt).
 */
import { cleanRestToken } from "../shared/rest-token.js";

export const REST_TOKEN_KEY = "figma-plugin:rest-token";

export interface StoredRestToken {
  token: string | null;
  expiresAt: number | null;
  /** null = never saved from this plugin version (legacy or nothing). */
  savedAt: number | null;
}

/** The slice of figma.clientStorage this needs. */
export interface TokenStorage {
  getAsync(key: string): Promise<unknown>;
  setAsync(key: string, value: unknown): Promise<void>;
}

const EMPTY: StoredRestToken = { token: null, expiresAt: null, savedAt: null };

function positive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export function parseStoredToken(v: unknown): StoredRestToken {
  if (typeof v === "string") return { token: cleanRestToken(v), expiresAt: null, savedAt: null };
  if (!v || typeof v !== "object") return { ...EMPTY };
  const o = v as { token?: unknown; expiresAt?: unknown; savedAt?: unknown };
  const token = cleanRestToken(o.token);
  return { token, expiresAt: token ? positive(o.expiresAt) : null, savedAt: positive(o.savedAt) };
}

export async function readStoredToken(storage: TokenStorage): Promise<StoredRestToken> {
  try {
    return parseStoredToken(await storage.getAsync(REST_TOKEN_KEY));
  } catch {
    return { ...EMPTY };
  }
}

export type SaveResult = { ok: true; stored: StoredRestToken } | { ok: false; error: string };

/** Save a pasted token. A malformed one is refused and changes nothing. */
export async function saveToken(storage: TokenStorage, raw: unknown, expiresAt: unknown, now: number): Promise<SaveResult> {
  const token = cleanRestToken(raw);
  if (!token) {
    return { ok: false, error: "That does not look like a Figma personal access token (figd_…): printable characters only, no spaces." };
  }
  const stored: StoredRestToken = { token, expiresAt: positive(expiresAt), savedAt: now };
  try {
    await storage.setAsync(REST_TOKEN_KEY, stored);
  } catch {
    /* non-fatal: works for this session, will not survive a restart */
  }
  return { ok: true, stored };
}

/** Clear — kept as a dated tombstone, not deleted (see the file comment). */
export async function clearToken(storage: TokenStorage, now: number): Promise<StoredRestToken> {
  const stored: StoredRestToken = { token: null, expiresAt: null, savedAt: now };
  try {
    await storage.setAsync(REST_TOKEN_KEY, stored);
  } catch {
    /* nothing to clear */
  }
  return stored;
}
