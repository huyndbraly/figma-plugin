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
