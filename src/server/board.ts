/**
 * Server-side half of the board kinds (use case, journey, persona): check the
 * model, lay it out, hand the plugin ready create() specs.
 */
import { buildUsecase, type UsecaseSpec, type BoardBuild } from "../shared/usecase/index.js";
import { buildJourney, type JourneySpec } from "../shared/journey/index.js";
import { buildPersona, type PersonaSpec } from "../shared/persona/index.js";
import type { AnyOperation } from "../shared/protocol.js";
import { ErrorCode, OpError } from "./errors.js";

export type OpCall = (op: AnyOperation, params: Record<string, unknown>) => Promise<unknown>;
export type BoardKind = "usecase" | "journey" | "persona";
export const BOARD_KINDS: readonly BoardKind[] = ["usecase", "journey", "persona"];

const ARRAYS: Record<BoardKind, string[]> = {
  usecase: ["actors", "useCases", "links"],
  journey: ["phases"],
  persona: ["personas"],
};

function validate(kind: BoardKind, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OpError(ErrorCode.INVALID_PARAMS, `type:"${kind}" needs a spec object.`, `See figma_docs(section="${kind}").`);
  }
  const spec = raw as Record<string, unknown>;
  for (const k of ARRAYS[kind]) {
    if (spec[k] !== undefined && !Array.isArray(spec[k])) {
      throw new OpError(ErrorCode.INVALID_PARAMS, `type:"${kind}": \`${k}\` must be an array.`, `See figma_docs(section="${kind}").`);
    }
  }
  if (spec.text !== undefined && typeof spec.text !== "string") {
    throw new OpError(ErrorCode.INVALID_PARAMS, `type:"${kind}": \`text\` must be a string.`, `See figma_docs({ section: "${kind}", level: "cheat" }).`);
  }
  const hasContent = typeof spec.text === "string" && spec.text.trim() !== "" || ARRAYS[kind].some((k) => Array.isArray(spec[k]) && (spec[k] as unknown[]).length > 0);
  if (!hasContent) {
    throw new OpError(
      ErrorCode.INVALID_PARAMS,
      `type:"${kind}" got no content.`,
      `Pass \`text\` (compact form) or ${ARRAYS[kind].map((k) => `\`${k}\``).join(" / ")}. See figma_docs({ section: "${kind}", level: "cheat" }).`,
    );
  }
  return spec;
}

export function buildBoard(kind: BoardKind, raw: unknown): BoardBuild<unknown> {
  const spec = validate(kind, raw);
  if (kind === "usecase") return buildUsecase(spec as UsecaseSpec);
  if (kind === "journey") return buildJourney(spec as JourneySpec);
  return buildPersona(spec as PersonaSpec);
}

export async function runBoard(
  kind: BoardKind,
  rawSpec: unknown,
  call: OpCall,
  sink?: string[],
  into?: string,
): Promise<Record<string, unknown>> {
  const built = buildBoard(kind, rawSpec);
  if (sink) for (const w of built.warnings) if (!sink.includes(w)) sink.push(w);
  const options = (rawSpec as { options?: { dryRun?: boolean } }).options;
  if (options?.dryRun) return { dryRun: true, warnings: built.warnings, stats: built.stats };
  const raw = await call("create_board", {
    ...built.draw,
    source: built.model,
    ...(into ? { intoFrameId: into } : {}),
  } as unknown as Record<string, unknown>);
  let value: unknown = raw;
  const warnings = built.warnings.slice();
  if (raw && typeof raw === "object" && "result" in (raw as object) && Array.isArray((raw as { warnings?: unknown }).warnings)) {
    value = (raw as { result: unknown }).result;
    for (const w of (raw as { warnings: unknown[] }).warnings.map(String)) {
      if (!warnings.includes(w)) warnings.push(w);
      if (sink && !sink.includes(w)) sink.push(w);
    }
  }
  return { ...((value ?? {}) as Record<string, unknown>), warnings, stats: built.stats };
}
