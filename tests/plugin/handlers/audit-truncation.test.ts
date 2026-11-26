import { beforeEach, describe, expect, it, vi } from "vitest";
import { layoutAudit, styleWarningsFor, textMightOverflow } from "../../../src/plugin/handlers/audit.js";
import { liveIsPaused } from "../../../src/plugin/diagram-live.js";
import { makeContext } from "../../../src/plugin/context.js";

/**
 * layout_audit's text-truncation check, and what it costs.
 *
 *  - "TRUNCATE" was reported for every text that had it, fitting or not.
 *  - A HEIGHT text clamped by textTruncation "ENDING" + maxLines was never
 *    checked at all.
 *  - Hidden layers (variant states, off overlays) were audited and reported.
 *  - Every fixed-size text was CLONED to be measured — a real create and
 *    delete each, an undo step each, and a change event the live diagram
 *    router answered by re-checking every diagram.
 */

const MIXED = Symbol("mixed");
const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});

/** Lines of `chars` characters at 0.6em per glyph in a box `width` wide. */
function laidOutHeight(chars: string, fontSize: number, lineH: number, width: number): number {
  const perLine = Math.max(1, Math.floor(width / (fontSize * 0.6)));
  const lines = chars.split("\n").reduce((sum, p) => sum + Math.max(1, Math.ceil(p.length / perLine)), 0);
  return lines * lineH;
}

let created: any[];
let pausedDuringProbe: boolean[];

function textNode(over: Record<string, unknown>): any {
  const t: any = {
    id: "2:1",
    name: "Label",
    type: "TEXT",
    x: 0,
    y: 0,
    width: 200,
    height: 20,
    visible: true,
    characters: "Hello",
    fontSize: 16,
    fontName: { family: "Inter", style: "Regular" },
    lineHeight: { unit: "PIXELS", value: 20 },
    letterSpacing: { unit: "PIXELS", value: 0 },
    textCase: "ORIGINAL",
    paragraphSpacing: 0,
    paragraphIndent: 0,
    textAutoResize: "NONE",
    textTruncation: "DISABLED",
    maxLines: null,
    fills: [],
    getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }],
    clone: vi.fn(() => {
      const c = { ...t, remove: vi.fn() };
      Object.defineProperty(c, "height", {
        get: () => laidOutHeight(c.characters, c.fontSize, c.lineHeight.value, c.width),
      });
      created.push(c);
      return c;
    }),
    ...over,
  };
  t.absoluteBoundingBox = { x: t.x, y: t.y, width: t.width, height: t.height };
  return t;
}

function frame(children: any[], over: Record<string, unknown> = {}): any {
  const f: any = {
    id: "1:1",
    name: "Screen",
    type: "FRAME",
    x: 0,
    y: 0,
    width: 400,
    height: 800,
    visible: true,
    fills: [],
    strokes: [],
    clipsContent: false,
    layoutMode: "NONE",
    children,
    absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 800 },
    ...over,
  };
  for (const c of children) c.parent = f;
  return f;
}

function probeText(): any {
  const p: any = {
    id: "99:1",
    type: "TEXT",
    removed: false,
    width: 100,
    textAutoResize: "WIDTH_AND_HEIGHT",
    characters: "",
    fontSize: 12,
    lineHeight: { unit: "PIXELS", value: 14 },
    resize(w: number) {
      this.width = w;
    },
    remove: vi.fn(function (this: any) {
      this.removed = true;
    }),
  };
  Object.defineProperty(p, "height", {
    get: () => {
      pausedDuringProbe.push(liveIsPaused());
      return laidOutHeight(p.characters, p.fontSize, p.lineHeight.value, p.width);
    },
  });
  return p;
}

let root: any;
beforeEach(() => {
  created = [];
  pausedDuringProbe = [];
  (globalThis as any).figma = {
    mixed: MIXED,
    loadFontAsync: vi.fn(async () => {}),
    getNodeByIdAsync: vi.fn(async (id: string) => (id === root?.id ? root : null)),
    createText: vi.fn(() => {
      const p = probeText();
      created.push(p);
      return p;
    }),
    currentPage: { id: "0:1", type: "PAGE", selection: [], children: [] },
  };
});

const audit = async (r: any) => {
  root = r;
  return (await layoutAudit(ctx({ nodeId: r.id, verbose: true }))) as any;
};
const truncated = (out: any, id = "2:1") => out.records.find((rec: any) => rec.id === id)?.textTruncated;

describe("truncation", () => {
  it("the deprecated TRUNCATE mode is not truncated when the text fits", async () => {
    const out = await audit(frame([textNode({ textAutoResize: "TRUNCATE", characters: "OK" })]));
    expect(truncated(out)).toBe(false);
  });

  it("…and is when it does not", async () => {
    const out = await audit(frame([textNode({ textAutoResize: "TRUNCATE", characters: "x".repeat(80) })]));
    expect(truncated(out)).toBe(true);
  });

  it("a HEIGHT text clamped by ENDING + maxLines is truncated when the text is longer", async () => {
    const long = textNode({
      textAutoResize: "HEIGHT",
      textTruncation: "ENDING",
      maxLines: 2,
      height: 40,
      characters: "word ".repeat(60),
    });
    expect(truncated(await audit(frame([long])))).toBe(true);
    const short = textNode({ textAutoResize: "HEIGHT", textTruncation: "ENDING", maxLines: 2, height: 40, characters: "Two words" });
    expect(truncated(await audit(frame([short])))).toBe(false);
  });

  it("an unclamped HEIGHT text is never truncated, and never measured", async () => {
    const out = await audit(frame([textNode({ textAutoResize: "HEIGHT", characters: "word ".repeat(60) })]));
    expect(truncated(out)).toBe(false);
    expect(created).toHaveLength(0);
  });
});

describe("hidden layers", () => {
  it("are not audited, nor anything inside them", async () => {
    const hiddenText = textNode({ id: "2:9", characters: "x".repeat(80) });
    const hidden = frame([hiddenText], { id: "1:2", name: "Pressed state", visible: false, width: 10, height: 10 });
    hidden.absoluteBoundingBox = { x: 900, y: 900, width: 10, height: 10 };
    const out = await audit(frame([hidden]));
    expect(out.records.map((r: any) => r.id)).not.toContain("1:2");
    expect(out.records.map((r: any) => r.id)).not.toContain("2:9");
    expect(out.summary.issues).toEqual([]);
  });
});

describe("measuring", () => {
  it("a roomy box is judged without making any node", async () => {
    const out = await audit(frame([textNode({ height: 200, characters: "Fits easily" })]));
    expect(truncated(out)).toBe(false);
    expect(created).toHaveLength(0);
  });

  it("uses ONE probe for many tight texts, removes it, and holds the live router meanwhile", async () => {
    const texts = Array.from({ length: 12 }, (_, i) =>
      textNode({ id: `2:${i + 1}`, characters: i % 2 ? "x".repeat(80) : "Short" }),
    );
    const out = await audit(frame(texts));
    expect((globalThis as any).figma.createText).toHaveBeenCalledTimes(1);
    expect(texts.every((t) => t.clone.mock.calls.length === 0)).toBe(true);
    expect(created[0].remove).toHaveBeenCalledTimes(1);
    expect(pausedDuringProbe.length).toBeGreaterThan(0);
    expect(pausedDuringProbe.every(Boolean), "the probe existed while the live router could run").toBe(true);
    expect(liveIsPaused()).toBe(false);
    expect(out.records.filter((r: any) => r.textTruncated).length).toBe(6);
  });

  it("a text styled in several runs is still cloned (one node cannot copy it)", async () => {
    const t = textNode({ fontSize: MIXED, characters: "x".repeat(80) });
    const out = await audit(frame([t]));
    expect(t.clone).toHaveBeenCalledTimes(1);
    expect(truncated(out)).toBe(true);
  });

  it("textMightOverflow is an upper bound: it never says 'fits' for a text that overflows", () => {
    const widths = [40, 80, 120, 200, 320];
    const samples = ["Sign in", "A much longer label that wraps", "supercalifragilistic expialidocious", "x".repeat(300)];
    for (const width of widths) {
      for (const chars of samples) {
        const need = laidOutHeight(chars, 16, 20, width);
        for (const boxH of [20, 40, 60, 100, 200]) {
          const t = textNode({ width, characters: chars });
          if (need > boxH + 0.5) expect(textMightOverflow(t, width, boxH), `${chars} @${width}x${boxH}`).toBe(true);
        }
      }
    }
  });
});

describe("sibling checks read each sibling once", () => {
  it("does not re-scan the sibling list for every node", () => {
    let reads = 0;
    const siblings = Array.from({ length: 60 }, (_, i) => {
      const s: any = {
        id: `3:${i}`,
        name: `Card ${i}`,
        type: "FRAME",
        height: 100,
        visible: true,
        fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
        strokes: [],
        cornerRadius: i === 0 ? 0 : 16,
        layoutAlign: "INHERIT",
        layoutMode: "NONE",
        children: [],
        parent: { id: "1:1", type: "FRAME", layoutMode: "VERTICAL" },
      };
      Object.defineProperty(s, "width", {
        get: () => {
          reads++;
          return 300;
        },
      });
      return s;
    });
    const all = siblings.map((s) => styleWarningsFor(s, siblings));
    expect(all[0]!.join(" ")).toContain("similar siblings");
    // Was ~60 reads per node (each rule scanned the list): 3 600+.
    expect(reads).toBeLessThan(60 * 8);
  });
});
