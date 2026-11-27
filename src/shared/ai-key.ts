/**
 * Bring-your-own AI keys typed into the plugin panel: the providers, how a
 * pasted key is cleaned, and how it is masked. Shared by the plugin (which
 * stores the keys in clientStorage) and the server (which holds them in RAM).
 * Pure: no figma globals, no fs, no network.
 */
import { cleanRestToken } from "./rest-token.js";

/** Image providers (openai, gemini, flux) and the SVG provider (anthropic). */
export const AI_PROVIDERS = ["openai", "gemini", "flux", "anthropic"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export const IMAGE_PROVIDERS = ["openai", "gemini", "flux"] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  flux: "Flux",
  anthropic: "Anthropic",
};

export function isAiProvider(v: unknown): v is AiProvider {
  return typeof v === "string" && (AI_PROVIDERS as readonly string[]).includes(v);
}

export function isImageProvider(v: unknown): v is ImageProvider {
  return typeof v === "string" && (IMAGE_PROVIDERS as readonly string[]).includes(v);
}

/** A key as pasted: trimmed, printable ASCII, 8–512 chars; else null. Same rule as the Figma PAT. */
export function cleanAiKey(raw: unknown): string | null {
  return cleanRestToken(raw);
}

/** `sk…a1b2` — enough to tell two keys apart, never enough to use one. */
export function maskAiKey(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length < 12) return "••••";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** The keys a panel sends: one entry per provider, null = not set there. */
export type AiKeySet = Partial<Record<AiProvider, string | null>>;

/** Keep only known providers with clean keys. */
export function cleanAiKeySet(raw: unknown): Partial<Record<AiProvider, string>> {
  const out: Partial<Record<AiProvider, string>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const p of AI_PROVIDERS) {
    const k = cleanAiKey((raw as Record<string, unknown>)[p]);
    if (k) out[p] = k;
  }
  return out;
}

/** What the panel shows: never a key, only which providers have one and from where. */
export interface AiStatusWire {
  providers: Array<{ provider: AiProvider; source: "plugin" | "env"; masked: string }>;
}
