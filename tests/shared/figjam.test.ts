import { describe, expect, it } from "vitest";
import { toFigjamGraph, layoutFigjam, sizeFor, isFigjamNativeKind } from "../../src/shared/figjam/index.js";

/**
 * Diagram models → FigJam-native graphs. Pinned: the SHAPE each kind of node
 * becomes (a decision drawn as a rectangle reads as a step), the text a
 * transition carries (event [guard] / action, as UML writes it), and that
 * the placed boxes never overlap.
 */

describe("toFigjamGraph", () => {
  it("userflow: decisions are diamonds, return edges dashed, error screens red", () => {
    const g = toFigjamGraph("userflow", {
      title: "Checkout",
      nodes: [
        { id: "cart", label: "Cart" },
        { id: "ok", label: "Paid?", kind: "decision" },
        { id: "err", label: "Card declined", cls: "error" },
        { id: "end", label: "Done", kind: "terminal" },
      ],
      edges: [
        { from: "cart", to: "ok" },
        { from: "ok", to: "err", label: "no" },
        { from: "err", to: "cart", kind: "return" },
      ],
    });
    expect(g.title).toBe("Checkout");
    expect(g.nodes.map((n) => n.shape)).toEqual(["ROUNDED_RECTANGLE", "DIAMOND", "ROUNDED_RECTANGLE", "ELLIPSE"]);
    expect(g.nodes[2]!.color).toBe("red");
    expect(g.edges[1]).toEqual({ from: "ok", to: "err", label: "no" });
    expect(g.edges[2]!.dashed).toBe(true);
  });

  it("userflow from mermaid source", () => {
    const g = toFigjamGraph("userflow", { title: "M", mermaid: "flowchart TD\n A[Home] --> B{Logged in?}\n B -->|yes| C[Feed]" });
    expect(g.rankdir).toBe("TB");
    expect(g.nodes.find((n) => n.id === "B")!.shape).toBe("DIAMOND");
    expect(g.edges).toContainEqual({ from: "B", to: "C", label: "yes" });
  });

  it("state: event [guard] / action on the connector, entry/do/exit inside the state", () => {
    const g = toFigjamGraph("state", {
      title: "Order",
      states: [{ id: "i", kind: "initial" }, { id: "paid", label: "Paid", entry: "send receipt" }, { id: "f", kind: "final" }],
      transitions: [{ from: "i", to: "paid", event: "pay", guard: "amount > 0", action: "charge" }, { from: "paid", to: "f" }],
    });
    expect(g.edges[0]!.label).toBe("pay [amount > 0] / charge");
    expect(g.edges[1]!.label).toBeUndefined();
    expect(g.nodes.find((n) => n.id === "paid")!.label).toBe("Paid\nentry / send receipt");
    expect(g.nodes[0]).toMatchObject({ shape: "ELLIPSE", label: "●" });
  });

  it("activity: the lane owner leads the label (FigJam has no swimlanes)", () => {
    const g = toFigjamGraph("activity", {
      title: "Refund",
      lanes: [{ id: "cs", label: "Support" }],
      nodes: [{ id: "s", kind: "start", lane: "cs", label: "Start" }, { id: "a", lane: "cs", label: "Check order" }, { id: "d", kind: "decision", lane: "cs", label: "Eligible?" }],
      edges: [{ from: "s", to: "a" }, { from: "a", to: "d" }],
    });
    expect(g.nodes.map((n) => n.label)).toEqual(["Start", "Support: Check order", "Support: Eligible?"]);
    expect(g.nodes[2]!.shape).toBe("DIAMOND");
  });

  it("sitemap: one edge per containment, drawn top-down", () => {
    const g = toFigjamGraph("sitemap", { title: "IA", pages: [{ id: "home", label: "Home" }, { id: "set", label: "Settings", parent: "home" }, { id: "m", label: "Delete account", parent: "set", kind: "modal" }] });
    expect(g.rankdir).toBe("TB");
    expect(g.edges).toEqual([{ from: "home", to: "set" }, { from: "set", to: "m" }]);
    expect(g.nodes[2]!.color).toBe("orange");
  });

  it("only the graph kinds convert", () => {
    expect(isFigjamNativeKind("state")).toBe(true);
    expect(isFigjamNativeKind("erd")).toBe(false);
  });
});

describe("layoutFigjam", () => {
  it("places every node with no two boxes overlapping", () => {
    const g = toFigjamGraph("userflow", {
      title: "x",
      nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, label: `Screen number ${i}` })),
      edges: Array.from({ length: 7 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })).concat([{ from: "n0", to: "n5" }]),
    });
    const { graph, width, height } = layoutFigjam(g);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    const boxes = graph.nodes;
    for (const a of boxes) for (const b of boxes) {
      if (a === b) continue;
      const overlap = a.x! < b.x! + b.w! && b.x! < a.x! + a.w! && a.y! < b.y! + b.h! && b.y! < a.y! + a.h!;
      expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
    }
  });

  it("drops (and reports) an edge to a node that does not exist", () => {
    const { graph, warnings } = layoutFigjam({ title: "x", rankdir: "LR", nodes: [{ id: "a", label: "A", shape: "SQUARE", color: "blue" }], edges: [{ from: "a", to: "ghost" }] });
    expect(graph.edges).toEqual([]);
    expect(warnings[0]).toMatch(/ghost/);
  });

  it("sizes a box from its label", () => {
    expect(sizeFor({ id: "a", label: "x".repeat(30), shape: "ROUNDED_RECTANGLE", color: "blue" }).w).toBeGreaterThan(sizeFor({ id: "b", label: "x", shape: "ROUNDED_RECTANGLE", color: "blue" }).w);
    expect(sizeFor({ id: "c", label: "●", shape: "ELLIPSE", color: "gray" })).toEqual({ w: 48, h: 48 });
  });
});

describe("board kinds in FigJam (review D2)", () => {
  it("usecase: actors and ellipse use cases; «include»/«extend» dashed with their label", () => {
    const g = toFigjamGraph("usecase", {
      title: "Shop",
      actors: [{ id: "c", name: "Customer" }, { id: "pay", name: "Payment GW", kind: "system" }],
      useCases: [{ id: "buy", label: "Buy" }, { id: "login", label: "Log in" }],
      links: [{ from: "c", to: "buy" }, { from: "buy", to: "login", kind: "include" }],
    });
    expect(g.nodes.find((n) => n.id === "buy")!.shape).toBe("ELLIPSE");
    expect(g.nodes.find((n) => n.id === "pay")!.label).toMatch(/Payment GW/);
    expect(g.edges[1]).toEqual({ from: "buy", to: "login", label: "«include»", dashed: true });
  });

  it("persona: a column of stickies per persona, primary starred, empty sections left out", () => {
    const g = toFigjamGraph("persona", {
      title: "People",
      source: "interviews",
      personas: [
        { id: "an", name: "An", primary: true, goals: ["ship fast"], pains: ["slow review"] },
        { id: "bo", name: "Bo", needs: ["clarity"] },
      ],
    });
    expect(g.placed).toBe(true);
    expect(g.nodes.every((n) => n.shape === "STICKY")).toBe(true);
    expect(g.nodes.find((n) => n.id === "an#head")!.label).toMatch(/^★ An/);
    expect(g.nodes.find((n) => n.id === "an#goals")!.label).toBe("Goals\n• ship fast");
    expect(g.nodes.some((n) => n.id === "bo#goals")).toBe(false);
    const xs = new Set(g.nodes.filter((n) => n.id.startsWith("bo")).map((n) => n.x));
    expect(xs.size).toBe(1); // one column
  });

  it("journey: phase headers chained left to right; feelings say their sign", () => {
    const g = toFigjamGraph("journey", {
      title: "Checkout",
      persona: "An",
      phases: [
        { id: "find", label: "Find", actions: ["search"], feeling: 1 },
        { id: "pay", label: "Pay", pains: ["card refused"], feeling: -2, feelingNote: "angry" },
      ],
    });
    expect(g.edges).toEqual([{ from: "find#phase", to: "pay#phase" }]);
    expect(g.nodes.find((n) => n.id === "pay#feels")).toMatchObject({ color: "red", label: expect.stringMatching(/^Feels 🙁 -2\n• angry/) });
  });

  it("a placed board keeps its grid and gets sizes, inside the section margins", () => {
    const g = toFigjamGraph("persona", { title: "P", personas: [{ id: "a", name: "A", goals: ["g"] }] });
    const { graph, width, height } = layoutFigjam(g);
    expect(graph.nodes[0]).toMatchObject({ x: 40, y: 80, w: 240, h: 240 });
    expect(graph.nodes[1]!.y).toBe(80 + 280);
    expect(width).toBeGreaterThan(240);
    expect(height).toBeGreaterThan(520);
  });
});

describe("FigJam layout fixes (review)", () => {
  it("a long single-line label gets the height of its WRAPPED lines", () => {
    const short = sizeFor({ id: "a", label: "Short", shape: "ROUNDED_RECTANGLE", color: "blue" });
    const long = sizeFor({ id: "b", label: "x".repeat(120), shape: "ROUNDED_RECTANGLE", color: "blue" });
    expect(long.w).toBe(320);
    expect(long.h).toBeGreaterThan(short.h + 40);
  });

  it("duplicate and empty ids are dropped with a warning; numeric ids become strings", () => {
    const { graph, warnings } = layoutFigjam({
      title: "x",
      rankdir: "LR",
      nodes: [
        { id: "a", label: "A", shape: "SQUARE", color: "blue" },
        { id: "a", label: "A again", shape: "SQUARE", color: "blue" },
        { id: "", label: "nameless", shape: "SQUARE", color: "blue" },
        { id: 7 as unknown as string, label: "seven", shape: "SQUARE", color: "blue" },
      ],
      edges: [{ from: "a", to: 7 as unknown as string }],
    });
    expect(graph.nodes.map((n) => n.id)).toEqual(["a", "7"]);
    expect(graph.edges).toEqual([{ from: "a", to: "7" }]);
    expect(warnings.join("\n")).toMatch(/used twice/);
    expect(warnings.join("\n")).toMatch(/no id/);
  });
});
