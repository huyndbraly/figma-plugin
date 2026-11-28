/**
 * AI keys a plugin panel saved (the "AI Image Key" field), held in this
 * process's RAM — never written to disk, never logged, never returned to an
 * agent (figma_status shows provider + masked preview only).
 *
 * Each provider is merged on its own, newest save wins: windows of one Figma
 * app share a clientStorage but cache it, and Figma in a browser and Figma
 * Desktop have SEPARATE storages — so a panel that never touched a provider
 * must not erase the key another panel saved for it. A time from the future
 * is clamped to now, so no message can pin a key against later saves.
 * figma_write always runs on the leader, so only the leader's copy is used; a
 * takeover leader learns the keys from the next panel that joins it.
 */
import { AI_PROVIDERS, cleanAiKey, cleanSavedAtBy, maskAiKey, type AiProvider, type AiStatusWire } from "../shared/ai-key.js";

export class AiKeyStore {
  private keys: Partial<Record<AiProvider, string>> = {};
  /** When each provider was last set or cleared (a clear is kept as a time). */
  private at: Partial<Record<AiProvider, number>> = {};
  private listeners = new Set<() => void>();

  constructor(private now: () => number = Date.now) {}

  /**
   * Apply a panel's keys: `raw` holds a key or null per provider. Each
   * provider's time is `savedAtBy[p]`; a provider without one only counts in
   * a legacy message (no `savedAtBy` at all), where `savedAt` stands for every
   * provider. True when anything was accepted.
   */
  set(raw: unknown, savedAt: number | null | undefined, savedAtBy?: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const by = cleanSavedAtBy(savedAtBy);
    const legacy = savedAtBy === undefined || savedAtBy === null;
    const overall = typeof savedAt === "number" && Number.isFinite(savedAt) && savedAt > 0 ? savedAt : 0;
    const now = this.now();
    let accepted = false;
    let changed = false;
    for (const p of AI_PROVIDERS) {
      if (!(p in (raw as Record<string, unknown>))) continue;
      const when = Math.min(by[p] ?? (legacy ? overall : 0), now);
      if (when <= 0 || when < (this.at[p] ?? 0)) continue;
      const key = cleanAiKey((raw as Record<string, unknown>)[p]) ?? undefined;
      accepted = true;
      this.at[p] = when;
      if (key !== this.keys[p]) changed = true;
      if (key) this.keys[p] = key;
      else delete this.keys[p];
    }
    if (changed) for (const l of this.listeners) l();
    return accepted;
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
    this.at = {};
  }
}

/** The process-wide store the bridge feeds and generateImage/generateSvg read. */
export const aiKeys = new AiKeyStore();
