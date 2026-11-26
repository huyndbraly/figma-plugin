import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * plugin/ui.html's WebSocket lifecycle, run in a vm with a fake WebSocket
 * and fake timers. ui.html is plain script (Figma loads it as-is), so this
 * is the only way to pin its reconnect behaviour: each case below was a
 * reproduced failure — a stale socket's onclose hijacking its replacement,
 * a hello sent before the stored channel was known, a silent port stalling
 * the walk, a restarted server found only after a lap of dead ports.
 */

const html = readFileSync(fileURLToPath(new URL("../../plugin/ui.html", import.meta.url)), "utf8");
const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));

interface Msg {
  type: string;
  [k: string]: unknown;
}

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: Msg[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { reason: string }) => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  get port(): number {
    return Number(/:(\d+)\//.exec(this.url)?.[1]);
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error(`send on a socket in state ${this.readyState}`);
    this.sent.push(JSON.parse(data) as Msg);
  }
  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    // The browser delivers onclose asynchronously — that delay is the bug window.
    setTimeout(() => {
      this.readyState = 3;
      this.onclose?.({ reason: "" });
    }, 5);
  }
  // ---- test controls ----
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: Msg): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ reason });
  }
}

function el(): Record<string, unknown> {
  return {
    style: {},
    children: [],
    appendChild() {},
    insertBefore() {},
    remove() {},
    removeChild() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
    select() {},
    textContent: "",
    className: "",
    innerHTML: "",
    value: "",
  };
}

let els: Record<string, Record<string, unknown>>;
let toMain: Array<Record<string, unknown>>;
let win: { onmessage?: (e: unknown) => void; innerWidth: number; innerHeight: number };

function load(): void {
  els = {};
  toMain = [];
  win = { innerWidth: 320, innerHeight: 600 };
  FakeWS.all = [];
  const ctx = {
    WebSocket: FakeWS,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame() {},
    console,
    Date,
    document: {
      getElementById: (id: string) => (els[id] ??= el()),
      createElement: el,
      body: el(),
      execCommand() {},
    },
    parent: { postMessage: (m: { pluginMessage: Record<string, unknown> }) => toMain.push(m.pluginMessage) },
    window: win,
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
}

/** The main thread answers the UI's handshake request. */
function mainHello(hello: Record<string, unknown> = {}): void {
  win.onmessage?.({ data: { pluginMessage: { kind: "handshake", pluginVersion: "9.9.9", protocolVersion: 6 } } });
  win.onmessage?.({
    data: {
      pluginMessage: {
        kind: "hello",
        hello: { fileName: "File A", pageName: "Page 1", channel: "chan-a", resumeToken: "tok-a", ...hello },
      },
    },
  });
}

const status = () => String(els["status"]?.textContent ?? "");
const last = () => FakeWS.all[FakeWS.all.length - 1]!;

beforeEach(() => {
  vi.useFakeTimers();
  load();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ui.html connects after the main thread's hello", () => {
  it("does not open a socket before the hello, then joins the stored channel", () => {
    expect(FakeWS.all).toHaveLength(0);
    mainHello();
    expect(FakeWS.all).toHaveLength(1);
    FakeWS.all[0]!.open();
    expect(FakeWS.all[0]!.sent[0]).toMatchObject({
      type: "hello",
      channel: "chan-a",
      resumeToken: "tok-a",
      protocolVersion: 6,
      pluginVersion: "9.9.9",
    });
  });

  it("connects anyway when no hello arrives within a second", () => {
    vi.advanceTimersByTime(999);
    expect(FakeWS.all).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(FakeWS.all).toHaveLength(1);
  });
});

describe("a replaced socket cannot touch its replacement", () => {
  it("Reconnect: the old socket's late onclose is ignored", () => {
    mainHello();
    const ws1 = last();
    ws1.open();
    ws1.receive({ type: "assigned", channel: "chan-a", resumeToken: "tok-a" });
    const staleClose = ws1.onclose!; // what the browser would still call

    (els["retry"]!.onclick as () => void)();
    const ws2 = last();
    expect(ws2).not.toBe(ws1);
    ws2.open();
    vi.advanceTimersByTime(20); // ws1's own onclose would fire now
    staleClose({ reason: "replaced" }); // even a direct call does nothing

    vi.advanceTimersByTime(3000);
    expect(FakeWS.all).toHaveLength(2); // no extra reconnect was scheduled
    expect(toMain.some((m) => m.kind === "save-channel" && m.channel === null)).toBe(false);
    ws2.receive({ type: "ping", at: 1 });
    expect(ws2.sent.map((m) => m.type)).toContain("pong");
    expect(ws2.sent[0]).toMatchObject({ type: "hello", channel: "chan-a", resumeToken: "tok-a" });
  });

  it("Join: the chosen channel survives the old socket closing", () => {
    mainHello();
    const ws1 = last();
    ws1.open();
    ws1.receive({ type: "assigned", channel: "chan-a", resumeToken: "tok-a" });
    els["channel-input"]!.value = "team-board";
    (els["channel-join"]!.onclick as () => void)();
    const ws2 = last();
    ws2.open();
    vi.advanceTimersByTime(3000);
    expect(FakeWS.all).toHaveLength(2);
    expect(ws2.sent[0]).toMatchObject({ type: "hello", channel: "team-board", resumeToken: null });
  });
});

describe("finding the server", () => {
  it("gives up on a port that accepts but never completes the handshake", () => {
    mainHello();
    const stuck = last();
    expect(stuck.port).toBe(38470);
    vi.advanceTimersByTime(2500);
    expect(stuck.readyState).toBeGreaterThanOrEqual(2);
    vi.advanceTimersByTime(1000);
    expect(last()).not.toBe(stuck);
    expect(last().port).toBe(38471);
  });

  it("after losing a connection, retries its port twice a second before walking", () => {
    mainHello();
    const ws1 = last();
    ws1.open();
    ws1.serverClose();
    const ports: number[] = [];
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(500);
      const s = last();
      ports.push(s.port);
      s.serverClose(); // still down
    }
    expect(ports.slice(0, 12).every((p) => p === 38470)).toBe(true);
    expect(FakeWS.all.length).toBeGreaterThanOrEqual(12);
    // Past the 10s window the walk resumes.
    vi.advanceTimersByTime(10_000);
    for (let i = 0; i < 5; i++) {
      last().serverClose();
      vi.advanceTimersByTime(8000);
    }
    expect(FakeWS.all.some((s) => s.port !== 38470)).toBe(true);
  });
});

describe("a channel already live in another window", () => {
  it("says so when the server assigns a different channel", () => {
    mainHello();
    const ws = last();
    ws.open();
    ws.receive({ type: "assigned", channel: "calm-otter-12", resumeToken: "tok-b" });
    expect(status()).toMatch(/"chan-a" is live in another window/);
    expect(toMain).toContainEqual({ kind: "save-channel", channel: "calm-otter-12", resumeToken: "tok-b" });
  });
});
