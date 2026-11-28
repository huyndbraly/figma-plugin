/**
 * The panel's AI keys as the plugin keeps them in figma.clientStorage — one
 * record for all providers, with when each provider was last saved or
 * cleared. Apart from main.ts so it can be tested without a Figma runtime.
 *
 * Stored shape: `{ keys: { openai?, gemini?, flux?, anthropic? }, savedAt,
 * savedAtBy: { <provider>: ms } }`. The server merges per provider by
 * `savedAtBy` (ai-keys.ts), so a Clear is recorded as a time too.
 * clientStorage is per user and per machine, never in the document: a key
 * never travels with a file someone else opens.
 */
import { cleanAiKey, cleanAiKeySet, cleanSavedAtBy, isAiProvider, type AiProvider, type AiSavedAtBy } from "../shared/ai-key.js";
import type { TokenStorage } from "./rest-token-store.js";

export const AI_KEYS_KEY = "figma-plugin:ai-keys";

export interface StoredAiKeys {
  keys: Partial<Record<AiProvider, string>>;
  /** Latest of savedAtBy; null = never saved. */
  savedAt: number | null;
  savedAtBy: AiSavedAtBy;
}

export function parseStoredAiKeys(v: unknown): StoredAiKeys {
  if (!v || typeof v !== "object") return { keys: {}, savedAt: null, savedAtBy: {} };
  const o = v as { keys?: unknown; savedAt?: unknown; savedAtBy?: unknown };
  const savedAt = typeof o.savedAt === "number" && Number.isFinite(o.savedAt) && o.savedAt > 0 ? o.savedAt : null;
  const keys = cleanAiKeySet(o.keys);
  let savedAtBy = cleanSavedAtBy(o.savedAtBy);
  // Written before per-provider times existed: each stored key dates from savedAt.
  if (o.savedAtBy === undefined && savedAt) {
    savedAtBy = {};
    for (const p of Object.keys(keys) as AiProvider[]) savedAtBy[p] = savedAt;
  }
  return { keys, savedAt, savedAtBy };
}

/** For display and sending: a failed read is "nothing saved". */
export async function readStoredAiKeys(storage: TokenStorage): Promise<StoredAiKeys> {
  try {
    return parseStoredAiKeys(await storage.getAsync(AI_KEYS_KEY));
  } catch {
    return { keys: {}, savedAt: null, savedAtBy: {} };
  }
}

export type AiSaveResult = { ok: true; stored: StoredAiKeys } | { ok: false; error: string };

/**
 * Save one provider's key (`raw` a string) or clear it (`raw` null). Read
 * fresh first — another window may have saved a different provider since —
 * and if that read FAILS, change nothing: writing what little is known would
 * erase every other provider's key. Callers run saves one at a time.
 */
export async function saveAiKey(storage: TokenStorage, provider: unknown, raw: string | null, now: number): Promise<AiSaveResult> {
  if (!isAiProvider(provider)) return { ok: false, error: "Pick a provider (OpenAI, Gemini, Flux or Anthropic)." };
  const key = raw === null ? null : cleanAiKey(raw);
  if (raw !== null && !key) return { ok: false, error: "That does not look like an API key: printable characters only, no spaces, 8–512 long." };
  let current: StoredAiKeys;
  try {
    current = parseStoredAiKeys(await storage.getAsync(AI_KEYS_KEY));
  } catch {
    return { ok: false, error: "Could not read the saved keys, so nothing was changed. Try again." };
  }
  const keys = { ...current.keys };
  if (key) keys[provider] = key;
  else delete keys[provider];
  // Strictly later than anything stored, even if the clock went back.
  const at = Math.max(now, (current.savedAt ?? 0) + 1);
  const stored: StoredAiKeys = { keys, savedAt: at, savedAtBy: { ...current.savedAtBy, [provider]: at } };
  try {
    await storage.setAsync(AI_KEYS_KEY, stored);
  } catch {
    /* non-fatal: works for this session, will not survive a restart */
  }
  return { ok: true, stored };
}
