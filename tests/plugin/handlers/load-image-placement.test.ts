import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadImage, loadIcon } from "../../../src/plugin/handlers/assets.js";
import { makeContext } from "../../../src/plugin/context.js";
import { resetKeepClearGroups } from "../../../src/plugin/keep-clear.js";

/**
 * load_image / load_icon on a page used to land at 0,0 — over whatever frame
 * was there. They now keep clear of the canvas like create() does.
 */

function ctx(params: Record<string, unknown>) {
  return makeContext(params, () => {});
}

function container(id: string, type: string, x: number, y: number, w: number, h: number): any {
  return {
    id,
    type,
    name: type,
    x,
    y,
    width: w,
    height: h,
    visible: true,
    fills: [],
    strokes: [],
    effects: [],
    children: [] as any[],
    absoluteTransform: [
      [1, 0, x],
      [0, 1, y],
    ],
    appendChild(n: any) {
      if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
      this.children.push(n);
      n.parent = this;
    },
    insertChild(i: number, n: any) {
      if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
      this.children.splice(i, 0, n);
      n.parent = this;
    },
  };
}

function leaf(id: string, type: string, w = 100, h = 100): any {
  return {
    id,
    type,
    name: "",
    x: 0,
    y: 0,
    width: w,
    height: h,
    visible: true,
    fills: [] as any[],
    strokes: [] as any[],
    effects: [] as any[],
    removed: false,
    resize(nw: number, nh: number) {
      this.width = nw;
      this.height = nh;
    },
    remove() {
      this.removed = true;
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    },
  };
}

let page: any;
let frame: any;
let photo: any;
let nodes: Map<string, any>;

beforeEach(() => {
  resetKeepClearGroups();
  page = container("0:1", "PAGE", 0, 0, 0, 0);
  delete page.width;
  delete page.height;
  frame = container("1:1", "FRAME", 0, 0, 400, 300);
  frame.layoutMode = "NONE";
  page.appendChild(frame);
  photo = leaf("2:1", "RECTANGLE", 120, 80);
  photo.name = "Photo";
  photo.x = 20;
  photo.y = 30;
  photo.fills = [{ type: "IMAGE", scaleMode: "CROP", imageHash: "old" }];
  frame.appendChild(photo);
  nodes = new Map([
    ["0:1", page],
    ["1:1", frame],
    ["2:1", photo],
  ]);
  let seq = 0;
  (globalThis as any).figma = {
    currentPage: page,
    mixed: Symbol("mixed"),
    getNodeByIdAsync: vi.fn(async (id: string) => nodes.get(id) ?? null),
    createRectangle: vi.fn(() => {
      const n = leaf(`10:${++seq}`, "RECTANGLE");
      nodes.set(n.id, n);
      return n;
    }),
    createImage: vi.fn(() => ({ hash: "new", getSizeAsync: async () => ({ width: 240, height: 160 }) })),
    createNodeFromSvg: vi.fn(() => {
      const n = container(`12:${++seq}`, "FRAME", 0, 0, 24, 24);
      n.rescale = vi.fn();
      n.clipsContent = true;
      nodes.set(n.id, n);
      return n;
    }),
  };
});

describe("load_image / load_icon on the canvas", () => {
  it("an image dropped on the page does not cover the frame already at 0,0", async () => {
    const res = (await loadImage(ctx({ base64: "AAAA" }))) as { id: string };
    const img = nodes.get(res.id);
    expect(img.parent).toBe(page);
    expect(img.y).toBeGreaterThanOrEqual(300); // slid below the 400x300 frame
  });

  it("allowOverlap keeps the given position", async () => {
    const res = (await loadImage(ctx({ base64: "AAAA", x: 10, y: 10, allowOverlap: true }))) as { id: string };
    expect([nodes.get(res.id).x, nodes.get(res.id).y]).toEqual([10, 10]);
  });

  it("an icon dropped on the page keeps clear too", async () => {
    const res = (await loadIcon(ctx({ svg: "<svg/>", size: 24 }))) as { id: string };
    expect(nodes.get(res.id).y).toBeGreaterThanOrEqual(300);
  });

  it("inside a frame nothing is moved (the frame is the caller's layout)", async () => {
    const res = (await loadImage(ctx({ base64: "AAAA", parentId: "1:1", x: 25, y: 35 }))) as { id: string };
    expect([nodes.get(res.id).x, nodes.get(res.id).y]).toEqual([25, 35]);
  });
});
