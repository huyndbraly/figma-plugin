import { describe, expect, it } from "vitest";
import { buildUsecase, checkUsecase, parseUsecaseText } from "../../src/shared/usecase/index.js";
import { buildJourney, parseJourneyText } from "../../src/shared/journey/index.js";
import { buildPersona, parsePersonaText } from "../../src/shared/persona/index.js";
import { checkConsistency } from "../../src/shared/model/check.js";
import { runBoard } from "../../src/server/board.js";

/** Drawn height of a TEXT spec: its wrapped lines × line height. */
const textHeightOf = (t: Record<string, unknown>) => String(t.characters).split("\n").length * (t.lineHeight as number);

const USECASE = `
system "Ticketing"
actor visitor "Visitor"
actor pay "Payment gateway" system
uc book "Book seats"
uc hold "Hold seats"
uc voucher "Apply voucher"
visitor - book
book => hold
voucher +> book
member :> visitor
book - pay
`;

describe("usecase", () => {
  it("parses the compact form, generating ids used only in links", () => {
    const p = parseUsecaseText(USECASE);
    expect(p.system).toBe("Ticketing");
    expect(p.actors.find((a) => a.id === "pay")?.kind).toBe("system");
    expect(p.links.map((l) => l.kind)).toEqual(["association", "include", "extend", "generalization", "association"]);
    const c = checkUsecase(p);
    expect(c.actors.map((a) => a.id)).toContain("member");
    // book - pay was written use case first: stored actor → use case.
    expect(c.links.find((l) => l.to === "book" && l.from === "pay")).toBeTruthy();
    expect(c.warnings).toEqual([]);
  });

  it("reports what UML cannot mean, and who is left out", () => {
    const c = checkUsecase({
      actors: [{ id: "a" }, { id: "idle" }],
      useCases: [{ id: "x" }, { id: "y" }, { id: "orphan" }],
      links: [
        { from: "a", to: "x" },
        { from: "x", to: "y" }, // association between use cases
        { from: "a", to: "y", kind: "include" },
        { from: "x", to: "y", kind: "include" },
        { from: "y", to: "x", kind: "include" },
      ],
    });
    const w = c.warnings.join("\n");
    expect(w).toMatch(/Association x association y must join an ACTOR/);
    expect(w).toMatch(/«include» a include y must join two use cases/);
    expect(w).toMatch(/Actor "idle" uses nothing/);
    expect(w).toMatch(/"orphan" has no actor/);
    expect(w).toMatch(/goes round in a circle/);
  });

  it("lays out actors outside the boundary and use cases inside it", () => {
    const b = buildUsecase({ text: USECASE, title: "Booking" });
    const names = b.draw.children.map((c) => c.name as string);
    expect(names).toContain("system boundary");
    expect(names).toContain("usecase:book");
    expect(names).toContain("usecase:visitor");
    const boundary = b.draw.children.find((c) => c.name === "system boundary")!;
    const visitor = b.draw.children.find((c) => c.name === "usecase:visitor")!;
    const payBox = b.draw.children.find((c) => c.name === "usecase:pay")!;
    const book = b.draw.children.find((c) => c.name === "usecase:book")!;
    expect(visitor.x as number).toBeLessThan(boundary.x as number);
    expect(payBox.x as number).toBeGreaterThan((boundary.x as number) + (boundary.width as number));
    expect(book.x as number).toBeGreaterThan(boundary.x as number);
    // hold is only «include»d: second column, right of book.
    const hold = b.draw.children.find((c) => c.name === "usecase:hold")!;
    expect(hold.x as number).toBeGreaterThan(book.x as number);
    expect(b.stats).toMatchObject({ actors: 3, useCases: 3, includes: 1, extends: 1, generalizations: 1 });
    expect(b.draw.children.every((c) => typeof c.type === "string")).toBe(true);
  });
});

const JOURNEY = `
persona "Thu"
phase find "Find a film"
  do Open the app
  at Home
  think "What's on?"
  feel 1 Curious
phase pay "Pay"
  do Enter card
  feel -2 Worried
  pain Hidden fees
`;

describe("usecase layout", () => {
  it("routes an actor's line around a use case standing in its way", () => {
    // pay (right side) → book, with hold («include»d by book) between them.
    const b = buildUsecase({ text: USECASE });
    const link = b.draw.children.find((c) => c.name === "link pay association book")!;
    const pts = link.points as number[][];
    expect(pts.length).toBe(3);
    const hold = b.draw.children.find((c) => c.name === "usecase:hold")!;
    const [hx, hy, hw, hh] = [hold.x as number, hold.y as number, hold.width as number, hold.height as number];
    const inside = (x: number, y: number) => ((x - (hx + hw / 2)) / (hw / 2)) ** 2 + ((y - (hy + hh / 2)) / (hh / 2)) ** 2 < 1;
    for (let i = 0; i < pts.length - 1; i++) {
      for (let t = 0; t <= 1; t += 0.02) {
        const x = pts[i]![0]! + (pts[i + 1]![0]! - pts[i]![0]!) * t;
        const y = pts[i]![1]! + (pts[i + 1]![1]! - pts[i]![1]!) * t;
        expect(inside(x, y), `segment ${i} crosses hold at ${x},${y}`).toBe(false);
      }
    }
  });

  it("takes «include» between two primary cases round the case between them", () => {
    const b = buildUsecase({ text: "actor v\nuc a\nuc s\nuc l\nv - a\nv - s\nv - l\na => l" });
    const link = b.draw.children.find((c) => c.name === "link a include l")!;
    const pts = link.points as number[][];
    const s = b.draw.children.find((c) => c.name === "usecase:s")!;
    const [sx, sy, sw, sh] = [s.x as number, s.y as number, s.width as number, s.height as number];
    const inside = (x: number, y: number) => ((x - (sx + sw / 2)) / (sw / 2)) ** 2 + ((y - (sy + sh / 2)) / (sh / 2)) ** 2 < 1;
    for (let i = 0; i < pts.length - 1; i++) {
      for (let t = 0; t <= 1; t += 0.02) {
        const x = pts[i]![0]! + (pts[i + 1]![0]! - pts[i]![0]!) * t;
        const y = pts[i]![1]! + (pts[i + 1]![1]! - pts[i]![1]!) * t;
        expect(inside(x, y), `segment ${i} crosses s at ${x},${y}`).toBe(false);
      }
    }
    // The lane stays inside the system boundary, and so does its label.
    const boundary = b.draw.children.find((c) => c.name === "system boundary")!;
    const right = (boundary.x as number) + (boundary.width as number);
    expect(Math.max(...pts.map((p) => p[0]!))).toBeLessThan(right);
    const label = b.draw.children.find((c) => c.name === "link a include l label")!;
    expect((label.x as number) + (label.width as number)).toBeLessThanOrEqual(right);
  });

  it("gives each actor a slot as tall as its name and detail", () => {
    const long = "Quản trị viên hệ thống của rạp chiếu phim trung tâm";
    const b = buildUsecase({
      actors: [
        { id: "a", name: long, detail: "Manages showtimes, rooms, prices and refunds for every branch" },
        { id: "b", name: "Visitor" },
      ],
      useCases: [{ id: "x" }, { id: "y" }],
      links: [{ from: "a", to: "x" }, { from: "b", to: "y" }],
    });
    const detail = b.draw.children.find((c) => c.name === "usecase:a detail")!;
    const next = b.draw.children.find((c) => c.name === "usecase:b")!;
    const detailBottom = (detail.y as number) + textHeightOf(detail);
    expect(next.y as number).toBeGreaterThan(detailBottom);
    const boundary = b.draw.children.find((c) => c.name === "system boundary")!;
    const lastName = b.draw.children.find((c) => c.name === "usecase:b name")!;
    expect((boundary.y as number) + (boundary.height as number)).toBeGreaterThanOrEqual(lastName.y as number);
  });

  it("reads `system-admin - book` as a link, and keeps non-ASCII ids whole", () => {
    const p = parseUsecaseText('system "Rạp"\nactor quản_lý "Quản lý"\nuc tìm "Tìm phim"\nsystem-admin - tìm\nquản_lý - tìm');
    expect(p.system).toBe("Rạp");
    expect(p.useCases.map((u) => u.id)).toEqual(["tìm"]);
    expect(p.actors.map((a) => a.id)).toEqual(["quản_lý"]);
    expect(p.links).toEqual([
      { from: "system-admin", to: "tìm", kind: "association" },
      { from: "quản_lý", to: "tìm", kind: "association" },
    ]);
    expect(p.warnings).toEqual([]);
  });

  it("draws an actor generalization from the child's head to under the parent's name", () => {
    const b = buildUsecase({ text: USECASE });
    const gen = b.draw.children.find((c) => c.name === "link member generalization visitor")!;
    const visitorName = b.draw.children.find((c) => c.name === "usecase:visitor name")!;
    const pts = gen.points as number[][];
    expect(pts[0]![0]).toBe(pts[1]![0]); // vertical
    expect(pts[1]![1]!).toBeGreaterThanOrEqual(visitorName.y as number);
  });
});

describe("journey", () => {
  it("parses phases with their rows and feeling", () => {
    const p = parseJourneyText(JOURNEY);
    expect(p.persona).toBe("Thu");
    expect(p.phases[1]).toMatchObject({ id: "pay", feeling: -2, feelingNote: "Worried", pains: ["Hidden fees"] });
  });

  it("reports a pain with no opportunity and draws the curve", () => {
    const b = buildJourney({ text: JOURNEY, title: "First booking" });
    expect(b.warnings.join("\n")).toMatch(/pain and no opportunity/);
    const names = b.draw.children.map((c) => c.name);
    expect(names).toContain("feeling curve");
    expect(names).toContain("journey:pay");
    expect(b.stats.phases).toBe(2);
  });

  it("keeps a non-ASCII phase id whole", () => {
    const p = parseJourneyText('phase tìm "Tìm phim"\n  do Mở app\nphase đặt "Đặt vé"\n  do Chọn ghế');
    expect(p.phases.map((x) => x.id)).toEqual(["tìm", "đặt"]);
  });

  it("puts a bad note above its dot and grows the curve row to fit long notes", () => {
    const long = "Worried about hidden fees, the seat timer running out and whether the card will be charged twice";
    const b = buildJourney({
      persona: "Thu",
      phases: [
        { id: "a", actions: ["x"], feeling: -2, feelingNote: long, pains: ["p"], ideas: ["i"] },
        { id: "b", actions: ["y"], feeling: 2, feelingNote: long },
      ],
    });
    const get = (n: string) => b.draw.children.find((c) => c.name === n)!;
    const bottomOf = (t: Record<string, unknown>) => (t.y as number) + textHeightOf(t);
    const badDot = get("journey:a feeling");
    const badNote = get("journey:a feeling note");
    expect(bottomOf(badNote)).toBeLessThanOrEqual(badDot.y as number);
    // Above the scale, but still inside the curve row.
    const feelingRule = get("row feeling rule");
    expect(badNote.y as number).toBeGreaterThan((feelingRule.points as number[][])[0]![1]!);
    // The good note ends before the next row starts.
    const nextRule = get("row pains rule");
    expect(bottomOf(get("journey:b feeling note"))).toBeLessThan((nextRule.points as number[][])[0]![1]!);
  });

  it("reports a low point with no pain", () => {
    const b = buildJourney({ persona: "A", phases: [{ id: "a", actions: ["x"], feeling: 1 }, { id: "b", actions: ["y"], feeling: -1 }] });
    expect(b.warnings.join("\n")).toMatch(/feels bad \(-1\) but names no pain/);
  });
});

const PERSONAS = `
source "4 interviews"
persona thu "Thu Trang" primary
  tag Office worker, 28
  quote "Book at lunch"
  fact Device: iPhone 13
  goal Fast seat pick
  pain Hidden fees
  level "Tech savvy" 7
  app Shopee
persona nam "Nam"
  goal Cheap tickets
`;

describe("persona", () => {
  it("parses cards and reports what is missing", () => {
    const p = parsePersonaText(PERSONAS);
    expect(p.source).toBe("4 interviews");
    expect(p.personas[0]).toMatchObject({ id: "thu", primary: true, facts: [{ label: "Device", value: "iPhone 13" }], levels: [{ label: "Tech savvy", value: 7 }] });
    const b = buildPersona({ text: PERSONAS });
    const w = b.warnings.join("\n");
    expect(w).toMatch(/outside 1–5 — clamped/);
    expect(w).toMatch(/Nam has no pain/);
    expect(b.model.personas[0]!.levels![0]!.value).toBe(5);
    expect(b.draw.children.find((c) => c.name === "persona:thu")).toBeTruthy();
    // "Persona · " is the prefix the screen checks know to skip.
    expect(b.draw.name).toMatch(/^Persona · /);
  });

  it("keeps a non-ASCII persona id whole", () => {
    const p = parsePersonaText('persona thư "Thư" primary\n  goal Đặt nhanh');
    expect(p.personas[0]).toMatchObject({ id: "thư", name: "Thư", primary: true });
  });

  it("asks for a source and a primary", () => {
    const b = buildPersona({ personas: [{ id: "a", goals: ["g"], pains: ["p"] }, { id: "b", goals: ["g"], pains: ["p"] }] });
    expect(b.warnings.join("\n")).toMatch(/No `source`/);
    expect(b.warnings.join("\n")).toMatch(/No persona is `primary`/);
  });
});

describe("cross-check", () => {
  it("flags a journey walked by someone no persona card describes", () => {
    const pageModel = [
      { nodeId: "1", kind: "persona", title: "Personas", spec: { personas: [{ id: "thu", name: "Thu Trang" }] } },
      { nodeId: "2", kind: "journey", title: "Booking", spec: { persona: "Thu", phases: [] } },
      { nodeId: "3", kind: "journey", title: "Refund", spec: { persona: "Lan", phases: [] } },
    ];
    const f = checkConsistency(pageModel).filter((x) => x.rule === "persona-drift");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/"Lan"/);
  });

  it("matches a persona by whole words of the name before the first comma", () => {
    const drift = (walker: string, card: string) =>
      checkConsistency([
        { nodeId: "1", kind: "persona", title: "Personas", spec: { personas: [{ id: "p", name: card }] } },
        { nodeId: "2", kind: "journey", title: "Booking", spec: { persona: walker, phases: [] } },
      ]).some((x) => x.rule === "persona-drift");
    expect(drift("Thu, 28, đặt vé lần đầu", "Thu Trang")).toBe(false);
    expect(drift("Thu Trang", "Thu")).toBe(false);
    expect(drift("thu trang, office worker", "Nguyễn Thu Trang")).toBe(false);
    expect(drift("An", "Thanh")).toBe(true);
    expect(drift("Thu", "Thư")).toBe(true);
  });

  it("treats use case actors as roles", () => {
    const pageModel = [
      { nodeId: "1", kind: "usecase", title: "UC", spec: { actors: [{ id: "cust", name: "Customer" }] } },
      { nodeId: "2", kind: "sequence", title: "Seq", spec: { participants: [{ id: "user", name: "Customer" }] } },
    ];
    expect(checkConsistency(pageModel).some((x) => x.rule === "id-drift")).toBe(true);
  });
});

describe("runBoard", () => {
  it("sends laid-out draw data plus the model to create_board", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const res = await runBoard("usecase", { text: USECASE, title: "Booking" }, async (op, params) => {
      calls.push({ op, params });
      return { frameId: "9:9", nodes: {} };
    });
    expect(calls[0]!.op).toBe("create_board");
    expect(calls[0]!.params).toMatchObject({ kind: "usecase", title: "Booking" });
    expect((calls[0]!.params.source as { links: unknown[] }).links).toHaveLength(5);
    expect(res.frameId).toBe("9:9");
  });

  it("dry-runs without calling the plugin, and refuses an empty spec", async () => {
    const res = await runBoard("journey", { text: JOURNEY, options: { dryRun: true } }, async () => {
      throw new Error("must not be called");
    });
    expect(res.dryRun).toBe(true);
    await expect(runBoard("persona", {}, async () => ({}))).rejects.toThrow(/no content/);
  });
});
