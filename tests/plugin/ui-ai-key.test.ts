import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * plugin/ui.html's AI Image Key field, run in a vm with a fake WebSocket and
 * fake timers (harness copied from ui-rest-token.test.ts). ui.html is plain
 * script (Figma loads it as-is), so this is how its behaviour is pinned: the
 * keys go to the main thread on Save, to the server only after `assigned`
 * (with per-provider save times), and the badge never shows a key.
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


const last = () => FakeWS.all[FakeWS.all.length - 1]!;
const TOKEN = "figd_abcdefghijklmnopqrstuvwxyz1234";

beforeEach(() => {
  vi.useFakeTimers();
  load();
});
afterEach(() => {
  vi.useRealTimers();
});

function connected(hello: Record<string, unknown> = {}): FakeWS {
  mainHello(hello);
  const ws = last();
  ws.open();
  ws.receive({ type: "assigned", channel: "chan-a", resumeToken: "tok-a" });
  return ws;
}
const main = (m: Record<string, unknown>) => win.onmessage?.({ data: { pluginMessage: m } });
const aiBadge = () => String(els["ai-badge"]?.textContent ?? "");
const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz";

describe("the AI Image Key field", () => {
  it("after `assigned` it asks clientStorage for the keys and sends them as set_ai_keys (never in the hello)", () => {
    const ws = connected();
    expect(JSON.stringify(ws.sent[0])).not.toContain("sk-");
    expect(toMain.some((m) => m.kind === "ai-keys-request")).toBe(true);
    main({ kind: "ai-keys", keys: { openai: KEY }, savedAt: 42, savedAtBy: { openai: 42, flux: 30 }, reason: "sync" });
    expect(ws.sent.at(-1)).toEqual({ type: "set_ai_keys", keys: { openai: KEY, gemini: null, flux: null, anthropic: null }, savedAt: 42, savedAtBy: { openai: 42, flux: 30 } });
  });

  it("nothing ever saved: it says nothing", () => {
    const ws = connected();
    main({ kind: "ai-keys", keys: {}, savedAt: null, reason: "sync" });
    expect(ws.sent.some((m) => m.type === "set_ai_keys")).toBe(false);
    expect(aiBadge()).toBe("Not set");
  });

  it("Save hands the key and the chosen provider to the main thread, not to the socket", () => {
    const ws = connected();
    els["ai-provider"]!.value = "gemini";
    els["ai-input"]!.value = `  ${KEY} `;
    (els["ai-save"]!.onclick as () => void)();
    expect(toMain.at(-1)).toEqual({ kind: "save-ai-key", provider: "gemini", key: KEY });
    expect(ws.sent.some((m) => m.type === "set_ai_keys")).toBe(false);
  });

  it("an empty Save asks for a key and sends nothing", () => {
    connected();
    els["ai-input"]!.value = "  ";
    const before = toMain.length;
    (els["ai-save"]!.onclick as () => void)();
    expect(toMain.length).toBe(before);
    expect(String(els["ai-input"]!.placeholder)).toMatch(/paste a key/);
  });

  it("Clear sends an explicit null for the chosen provider", () => {
    connected();
    els["ai-provider"]!.value = "flux";
    (els["ai-clear"]!.onclick as () => void)();
    expect(toMain.at(-1)).toEqual({ kind: "save-ai-key", provider: "flux", key: null });
  });

  it("once stored it is sent, the input is emptied, and the badge names the provider — never the key", () => {
    const ws = connected();
    els["ai-input"]!.value = KEY;
    main({ kind: "ai-keys", keys: { flux: KEY }, savedAt: 7, reason: "saved" });
    expect(ws.sent.at(-1)!.type).toBe("set_ai_keys");
    expect(els["ai-input"]!.value).toBe("");
    expect(aiBadge()).toBe("Flux");
    expect(String(els["ai-badge"]!.title)).not.toContain(KEY);
    expect(String(els["ai-badge"]!.title)).toContain("sk-…wxyz");
  });

  it("a refused key keeps what was typed, shows the refusal ON THE BADGE (a placeholder is hidden by the text), and changes nothing", () => {
    const ws = connected();
    els["ai-input"]!.value = "bad key";
    main({ kind: "ai-keys", keys: {}, savedAt: null, reason: "rejected", error: "That does not look like an API key" });
    expect(els["ai-input"]!.value).toBe("bad key");
    expect(aiBadge()).toBe("Not saved");
    expect(String(els["ai-badge"]!.className)).toContain("bad");
    expect(String(els["ai-badge"]!.title)).toMatch(/does not look like/);
    expect(ws.sent.some((m) => m.type === "set_ai_keys")).toBe(false);
    // Typing again clears the refusal and the stale hints.
    (els["ai-input"]!.oninput as () => void)();
    expect(aiBadge()).toBe("Not set");
    expect(String(els["ai-input"]!.placeholder)).toBe("API key");
  });

  it("after \"paste a key first\", a later successful Save resets the placeholder", () => {
    connected();
    els["ai-input"]!.value = "";
    (els["ai-save"]!.onclick as () => void)();
    expect(String(els["ai-input"]!.placeholder)).toMatch(/paste a key/);
    main({ kind: "ai-keys", keys: { openai: KEY }, savedAt: 3, savedAtBy: { openai: 3 }, reason: "saved" });
    expect(String(els["ai-input"]!.placeholder)).toBe("API key");
  });

  it("a short key shows no characters in the badge's preview", () => {
    connected();
    main({ kind: "ai-keys", keys: { gemini: "short-key-1234567" }, savedAt: 1, savedAtBy: { gemini: 1 }, reason: "sync" });
    expect(String(els["ai-badge"]!.title)).toBe("Gemini: ••••");
  });

  it("the server's ai_status (env keys too) drives the badge; a disconnect falls back to what the panel holds", () => {
    const ws = connected();
    main({ kind: "ai-keys", keys: { openai: KEY }, savedAt: 1, reason: "sync" });
    ws.receive({ type: "ai_status", status: { providers: [{ provider: "openai", source: "plugin", masked: "sk-…wxyz" }, { provider: "anthropic", source: "env", masked: "sk-…0000" }] } });
    expect(aiBadge()).toBe("OpenAI, Anthropic");
    expect(String(els["ai-badge"]!.title)).toMatch(/Anthropic: sk-…0000 \(server env\)/);
    ws.serverClose();
    expect(aiBadge()).toBe("OpenAI");
  });

  it("a key saved while disconnected reaches the server after the reconnect", () => {
    const ws1 = connected();
    ws1.serverClose();
    main({ kind: "ai-keys", keys: { gemini: KEY }, savedAt: 9, reason: "saved" });
    expect(ws1.sent.some((m) => m.type === "set_ai_keys")).toBe(false);
    vi.advanceTimersByTime(20_000);
    const ws2 = last();
    expect(ws2).not.toBe(ws1);
    ws2.open();
    ws2.receive({ type: "assigned", channel: "chan-a", resumeToken: "tok-a" });
    expect(toMain.filter((m) => m.kind === "ai-keys-request").length).toBe(2);
    main({ kind: "ai-keys", keys: { gemini: KEY }, savedAt: 9, reason: "sync" });
    expect(ws2.sent.at(-1)).toMatchObject({ type: "set_ai_keys", savedAt: 9, keys: { gemini: KEY } });
  });
});
