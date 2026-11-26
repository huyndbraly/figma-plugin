import { describe, expect, it } from "vitest";
import { executeWrite } from "../../src/server/executor.js";
import { SessionRegistry } from "../../src/server/session.js";
import type { AnyOperation, BridgeResponse } from "../../src/shared/protocol.js";

describe("figma_write cancellation", () => {
  it("an aborted caller signal reaches the ops still waiting", async () => {
    const seen: AbortSignal[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runOp = async (_op: AnyOperation, _p: Record<string, unknown>, ctx?: { signal?: AbortSignal }): Promise<BridgeResponse> => {
      if (ctx?.signal) seen.push(ctx.signal);
      await gate;
      return { id: "x", ok: true, result: null };
    };
    const caller = new AbortController();
    const done = executeWrite(`await figma.getDocumentInfo(); return 1;`, new SessionRegistry().get(), { runOp }, { signal: caller.signal, timeoutMs: 5000 });
    for (let i = 0; i < 50 && !seen.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.aborted).toBe(false);
    caller.abort();
    expect(seen[0]!.aborted).toBe(true);
    release();
    await done;
  });

  it("an already-aborted signal aborts from the start", async () => {
    const seen: AbortSignal[] = [];
    const runOp = async (_op: AnyOperation, _p: Record<string, unknown>, ctx?: { signal?: AbortSignal }): Promise<BridgeResponse> => {
      if (ctx?.signal) seen.push(ctx.signal);
      return { id: "x", ok: true, result: null };
    };
    const caller = new AbortController();
    caller.abort();
    await executeWrite(`await figma.getDocumentInfo(); return 1;`, new SessionRegistry().get(), { runOp }, { signal: caller.signal, timeoutMs: 5000 });
    expect(seen.every((s) => s.aborted)).toBe(true);
  });
});
