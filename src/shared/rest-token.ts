/**
 * Figma REST personal access token helpers shared by the plugin (which stores
 * the token in clientStorage) and the server (which holds it in RAM). Pure:
 * no figma globals, no fs, no network.
 */

/** A PAT as pasted: trimmed, no inner whitespace, sane length; else null. */
export function cleanRestToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length < 8 || t.length > 512 || /\s/.test(t)) return null;
  return t;
}

/** `figd_…a1b2` — enough to tell two tokens apart, never enough to use one. */
export function maskRestToken(token: string | null | undefined): string | undefined {
  if (!token) return undefined;
  if (token.length < 12) return "••••";
  const head = token.startsWith("figd_") ? "figd_" : token.slice(0, 2);
  return `${head}…${token.slice(-4)}`;
}
