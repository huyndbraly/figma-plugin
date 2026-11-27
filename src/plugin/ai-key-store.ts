/**
 * The panel's AI keys as the plugin keeps them in figma.clientStorage — one
 * record for all providers, with the time of the last Save/Clear. Apart from
 * main.ts so it can be tested without a Figma runtime.
 *
 * Stored shape: `{ keys: { openai?, gemini?, flux?, anthropic? }, savedAt }`.
 * clientStorage is per user and per machine, never in the document: a key
 * never travels with a file someone else opens.
 */
import { cleanAiKey, cleanAiKeySet, isAiProvider, type AiProvider } from "../shared/ai-key.js";
import type { TokenStorage } from "./rest-token-store.js";

export const AI_KEYS_KEY = "figma-plugin:ai-keys";

export interface StoredAiKeys {
  keys: Partial<Record<AiProvider, string>>;
  /** null = never saved. */
  savedAt: number | null;
}

export function parseStoredAiKeys(v: unknown): StoredAiKeys {
  if (!v || typeof v !== "object") return { keys: {}, savedAt: null };
  const o = v as { keys?: unknown; savedAt?: unknown };
  const savedAt = typeof o.savedAt === "number" && Number.isFinite(o.savedAt) && o.savedAt > 0 ? o.savedAt : null;
  return { keys: cleanAiKeySet(o.keys), savedAt };
}

export async function readStoredAiKeys(storage: TokenStorage): Promise<StoredAiKeys> {
  try {
    return parseStoredAiKeys(await storage.getAsync(AI_KEYS_KEY));
  } catch {
    return { keys: {}, savedAt: null };
  }
}

export type AiSaveResult = { ok: true; stored: StoredAiKeys } | { ok: false; error: string };

/**
 * Save one provider's key (`raw` a string) or clear it (`raw` null). Read
 * fresh first: another window may have saved a different provider since.
 */
export async function saveAiKey(storage: TokenStorage, provider: unknown, raw: string | null, now: number): Promise<AiSaveResult> {
  if (!isAiProvider(provider)) return { ok: false, error: "Pick a provider (OpenAI, Gemini, Flux or Anthropic)." };
  const key = raw === null ? null : cleanAiKey(raw);
  if (raw !== null && !key) return { ok: false, error: "That does not look like an API key: printable characters only, no spaces, 8–512 long." };
  const current = await readStoredAiKeys(storage);
  const keys = { ...current.keys };
  if (key) keys[provider] = key;
  else delete keys[provider];
  const stored: StoredAiKeys = { keys, savedAt: Math.max(now, (current.savedAt ?? 0) + 1) };
  try {
    await storage.setAsync(AI_KEYS_KEY, stored);
  } catch {
    /* non-fatal: works for this session, will not survive a restart */
  }
  return { ok: true, stored };
}
