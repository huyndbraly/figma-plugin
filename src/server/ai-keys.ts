/**
 * AI keys a plugin panel saved (the "AI Image Key" field), held in this
 * process's RAM — never written to disk, never logged, never returned to an
 * agent (figma_status shows provider + masked preview only).
 *
 * Every Figma window shares one clientStorage but caches it, so the newest
 * `savedAt` wins: a window that missed a later Save/Clear cannot bring an old
 * key back. figma_write always runs on the leader, so only the leader's copy
 * is ever used; a takeover leader learns the keys from the next panel that
 * joins it (the panel sends them after every `assigned`).
 */
import { AI_PROVIDERS, cleanAiKeySet, maskAiKey, type AiProvider, type AiStatusWire } from "../shared/ai-key.js";

export class AiKeyStore {
  private keys: Partial<Record<AiProvider, string>> = {};
  private savedAt = -Infinity;
  private listeners = new Set<() => void>();

  /** Apply a panel's keys. False (and nothing changes) when older than what is held. */
  set(raw: unknown, savedAt: number | null | undefined): boolean {
    const at = typeof savedAt === "number" && Number.isFinite(savedAt) ? savedAt : 0;
    if (at < this.savedAt) return false;
    const next = cleanAiKeySet(raw);
    const changed = AI_PROVIDERS.some((p) => next[p] !== this.keys[p]);
    this.keys = next;
    this.savedAt = at;
    if (changed) for (const l of this.listeners) l();
    return true;
  }

  get(provider: AiProvider): string | undefined {
    return this.keys[provider];
  }

  /** Providers with a key from the panel or (else) the environment. */
  status(envKeys: Partial<Record<AiProvider, string | undefined>> = {}): AiStatusWire {
    const providers: AiStatusWire["providers"] = [];
    for (const p of AI_PROVIDERS) {
      const own = this.keys[p];
      const env = envKeys[p];
      if (own) providers.push({ provider: p, source: "plugin", masked: maskAiKey(own)! });
      else if (env) providers.push({ provider: p, source: "env", masked: maskAiKey(env)! });
    }
    return { providers };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Test seam. */
  reset(): void {
    this.keys = {};
    this.savedAt = -Infinity;
  }
}

/** The process-wide store the bridge feeds and generateImage/generateSvg read. */
export const aiKeys = new AiKeyStore();
