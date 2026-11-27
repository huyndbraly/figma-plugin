import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * plugin/ui.html's REST Token field (harness copied from ui-socket.test.ts).
 * Earlier doc of the original harness: plugin/ui.html's WebSocket lifecycle, run in a vm with a fake WebSocket
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
const badge = () => String(els["token-badge"]?.textContent ?? "");
const main = (m: Record<string, unknown>) => win.onmessage?.({ data: { pluginMessage: m } });

describe("the REST Token field", () => {
  it("the hello never carries the token (it is sent with set_rest_token after `assigned`)", () => {
    const ws = connected();
    expect("restToken" in ws.sent[0]!).toBe(false);
    expect(JSON.stringify(ws.sent[0])).not.toContain("figd_");
  });

  it("after `assigned`, it asks the main thread for what clientStorage holds NOW, and sends that", () => {
    const ws = connected();
    expect(toMain.some((m) => m.kind === "rest-token-request")).toBe(true);
    expect(ws.sent.some((m) => m.type === "set_rest_token")).toBe(false); // nothing until the main thread answers
    main({ kind: "rest-token", token: TOKEN, expiresAt: null, savedAt: 1234, reason: "sync" });
    expect(ws.sent.at(-1)).toEqual({ type: "set_rest_token", token: TOKEN, expiresAt: null, savedAt: 1234 });
  });

  it("nothing saved from this plugin (no token, no dated Clear): it says nothing", () => {
    const ws = connected();
    main({ kind: "rest-token", token: null, expiresAt: null, savedAt: null, reason: "sync" });
    expect(ws.sent.some((m) => m.type === "set_rest_token")).toBe(false);
  });

  it("Save hands the token to the main thread, not to the socket", () => {
    const ws = connected();
    els["token-input"]!.value = `  ${TOKEN} `;
    (els["token-save"]!.onclick as () => void)();
    expect(toMain.at(-1)).toEqual({ kind: "save-rest-token", token: TOKEN, expiresAt: null });
    expect(ws.sent.some((m) => m.type === "set_rest_token")).toBe(false);
    expect(badge()).toBe("Checking…");
  });

  it("once stored, it goes to the server with its savedAt and the input is emptied", () => {
    const ws = connected();
    els["token-input"]!.value = TOKEN;
    main({ kind: "rest-token", token: TOKEN, savedAt: 99, reason: "saved" });
    expect(ws.sent.at(-1)).toEqual({ type: "set_rest_token", token: TOKEN, expiresAt: null, savedAt: 99 });
    expect(els["token-input"]!.value).toBe("");
  });

  it("Clear sends an explicit, dated null", () => {
    const ws = connected();
    (els["token-clear"]!.onclick as () => void)();
    expect(toMain.at(-1)).toEqual({ kind: "save-rest-token", token: null });
    main({ kind: "rest-token", token: null, savedAt: 500, reason: "cleared" });
    expect(ws.sent.at(-1)).toEqual({ type: "set_rest_token", token: null, expiresAt: null, savedAt: 500 });
    expect(badge()).toBe("Not set");
  });

  it("a Clear made while disconnected reaches the server after the reconnect", () => {
    const ws1 = connected();
    ws1.serverClose();
    main({ kind: "rest-token", token: null, savedAt: 700, reason: "cleared" }); // socket down: not sent
    vi.advanceTimersByTime(600);
    const ws2 = last();
    ws2.open();
    ws2.receive({ type: "assigned", channel: "chan-a", resumeToken: "tok-a" });
    main({ kind: "rest-token", token: null, expiresAt: null, savedAt: 700, reason: "sync" });
    expect(ws2.sent.at(-1)).toEqual({ type: "set_rest_token", token: null, expiresAt: null, savedAt: 700 });
  });

  it("a refused Save changes nothing: the badge keeps the server's verdict", () => {
    const ws = connected();
    ws.receive({ type: "rest_status", status: { state: "valid", source: "plugin", handle: "h" } });
    els["token-input"]!.value = "not a token";
    (els["token-save"]!.onclick as () => void)();
    main({ kind: "rest-token", token: null, reason: "rejected", error: "That does not look like a token" });
    expect(badge()).toBe("Valid (@h)");
    expect(els["token-input"]!.placeholder).toBe("That does not look like a token");
    expect(els["token-input"]!.value).toBe("not a token"); // kept, so one wrong character can be fixed
  });

  it.each([
    [{ state: "not_set", source: null }, "Not set"],
    [{ state: "checking", source: "plugin" }, "Checking…"],
    [{ state: "valid", source: "plugin", handle: "ngoc" }, "Valid (@ngoc)"],
    [{ state: "invalid", source: "plugin", httpStatus: 403 }, "Expired / Invalid (403)"],
    [{ state: "rate_limited", source: "plugin", httpStatus: 429 }, "Rate-limited (429)"],
    [{ state: "valid", source: "env", handle: "ci" }, "Valid (@ci) · env"],
  ])("the badge reads the server's verdict %j → %s", (status, text) => {
    const ws = connected();
    ws.receive({ type: "rest_status", status });
    expect(badge()).toBe(text);
  });
});

describe("REST activity", () => {
  it("counts REST reads, writes and errors with the plugin's own ops", () => {
    const ws = connected();
    ws.receive({ type: "rest_event", at: 1, op: "get_nodes", method: "GET", fileKey: "KEY", status: 200, ms: 142, ok: true, kind: "read" });
    ws.receive({ type: "rest_event", at: 2, op: "post_comment", method: "POST", fileKey: "KEY", status: 200, ms: 90, ok: true, kind: "write" });
    ws.receive({ type: "rest_event", at: 3, op: "get_file", method: "GET", status: 403, ms: 50, ok: false, kind: "read", message: "Token expired / invalid" });
    expect(els["stat-reads"]!.textContent).toBe("1");
    expect(els["stat-writes"]!.textContent).toBe("1");
    expect(els["stat-errors"]!.textContent).toBe("1");
  });
});

describe("token expiry (Figma cannot be asked, so the user says it at Save)", () => {
  it("Save with '1 day' sends an expiry ~24h ahead, and it rides to the server", () => {
    const ws = connected();
    els["token-input"]!.value = TOKEN;
    els["token-expiry"]!.value = "1";
    const before = Date.now();
    (els["token-save"]!.onclick as () => void)();
    const sent = toMain.at(-1) as { expiresAt: number };
    expect(sent.expiresAt - before).toBeGreaterThanOrEqual(86_400_000 - 5);
    expect(sent.expiresAt - before).toBeLessThan(86_400_000 + 1000);
    main({ kind: "rest-token", token: TOKEN, expiresAt: sent.expiresAt, savedAt: 5, reason: "saved" });
    expect(ws.sent.at(-1)).toEqual({ type: "set_rest_token", token: TOKEN, expiresAt: sent.expiresAt, savedAt: 5 });
  });

  it("the badge counts down, warns under a day, and says so once the date has passed", () => {
    const ws = connected();
    const now = Date.now();
    ws.receive({ type: "rest_status", status: { state: "valid", source: "plugin", handle: "h", expiresAt: now + 5 * 86_400_000 } });
    expect(badge()).toBe("Valid (@h) · 5d left");
    expect(els["token-badge"]!.className).toBe("token-badge ok");
    ws.receive({ type: "rest_status", status: { state: "valid", source: "plugin", handle: "h", expiresAt: now + 3 * 3_600_000 } });
    expect(badge()).toBe("Valid (@h) · 3h left");
    expect(els["token-badge"]!.className).toBe("token-badge warn");
    ws.receive({ type: "rest_status", status: { state: "valid", source: "plugin", handle: "h", expiresAt: now - 1000 } });
    expect(badge()).toBe("Expired? (date passed)");
  });

  it("a missing scope shows in the tooltip and turns the badge amber", () => {
    const ws = connected();
    ws.receive({ type: "rest_status", status: { state: "valid", source: "plugin", handle: "h", missingScopes: ["file_comments:write"], scopes: ["file_content:read"] } });
    expect(els["token-badge"]!.className).toBe("token-badge warn");
    expect(String(els["token-badge"]!.title)).toContain("Missing scopes: file_comments:write");
  });
});

describe("badge details from the review", () => {
  it("a missing scope turns the badge amber even when an expiry is set", () => {
    const ws = connected();
    ws.receive({ type: "rest_status", status: { state: "valid", source: "plugin", handle: "h", missingScopes: ["file_versions:read"], expiresAt: Date.now() + 10 * 86_400_000 } });
    expect(els["token-badge"]!.className).toBe("token-badge warn");
  });

  it("the language comes from clientStorage via the main thread, and a click saves it there", () => {
    connected();
    main({ kind: "ui-lang", lang: "vi" });
    const ws = last();
    ws.receive({ type: "rest_status", status: { state: "not_set", source: null } });
    expect(badge()).toBe("Chưa đặt");
    expect(toMain.some((m) => m.kind === "save-ui-lang")).toBe(false); // restoring is not saving
    (els["lang-en"]!.onclick as () => void)();
    expect(toMain.at(-1)).toEqual({ kind: "save-ui-lang", lang: "en" });
    expect(badge()).toBe("Not set");
  });
});

describe("rate-limited badge", () => {
  it("says how long until REST works again", () => {
    const ws = connected();
    ws.receive({ type: "rest_status", status: { state: "rate_limited", source: "plugin", httpStatus: 429, retryAt: Date.now() + 4 * 86_400_000 + 60_000 } });
    expect(badge()).toBe("Rate-limited (429) · retry in 4d");
  });
});

describe("a server that never answers the token (an older build)", () => {
  it("after 12 s the badge says so instead of staying on Checking…", () => {
    const ws = connected();
    els["token-input"]!.value = TOKEN;
    (els["token-save"]!.onclick as () => void)();
    main({ kind: "rest-token", token: TOKEN, savedAt: 1, reason: "saved" });
    expect(badge()).toBe("Checking…");
    vi.advanceTimersByTime(11_999);
    expect(badge()).toBe("Checking…");
    vi.advanceTimersByTime(2);
    expect(badge()).toBe("No answer from server");
    expect(String(els["token-badge"]!.title)).toMatch(/restart the MCP server/);
    // A late answer still wins.
    ws.receive({ type: "rest_status", status: { state: "valid", source: "plugin", handle: "h" } });
    expect(badge()).toBe("Valid (@h)");
  });

  it("a server that answers in time never shows the warning", () => {
    const ws = connected();
    main({ kind: "rest-token", token: TOKEN, savedAt: 1, reason: "saved" });
    ws.receive({ type: "rest_status", status: { state: "valid", source: "plugin", handle: "h" } });
    vi.advanceTimersByTime(20_000);
    expect(badge()).toBe("Valid (@h)");
  });
});


describe("review fixes (second pass)", () => {
  it("a Save during the handshake of a NEW socket waits for that socket's `assigned`", () => {
    const ws1 = connected();
    ws1.serverClose();
    vi.advanceTimersByTime(600);
    const ws2 = last();
    ws2.open(); // open, but not assigned yet — `channel` still holds the old value
    main({ kind: "rest-token", token: TOKEN, savedAt: 9, reason: "saved" });
    expect(ws2.sent.some((m) => m.type === "set_rest_token")).toBe(false);
    ws2.receive({ type: "assigned", channel: "chan-a", resumeToken: "tok-a" });
    main({ kind: "rest-token", token: TOKEN, savedAt: 9, reason: "sync" });
    expect(ws2.sent.at(-1)).toMatchObject({ type: "set_rest_token", token: TOKEN });
  });

  it("a language the user clicked is not undone by the stored one arriving late", () => {
    connected();
    (els["lang-en"]!.onclick as () => void)();
    main({ kind: "ui-lang", lang: "vi" });
    last().receive({ type: "rest_status", status: { state: "not_set", source: null } });
    // "Not set" vs "Chưa đặt": the strings differ, so this fails if vi won.
    expect(badge()).toBe("Not set");
    expect(badge()).not.toBe("Chưa đặt");
  });

  it("`assigned` itself asks the main thread for the token (no manual step needed)", () => {
    mainHello();
    const ws = last();
    ws.open();
    const before = toMain.filter((m) => m.kind === "rest-token-request").length;
    ws.receive({ type: "assigned", channel: "chan-a", resumeToken: "tok-a" });
    expect(toMain.filter((m) => m.kind === "rest-token-request").length).toBe(before + 1);
  });

  it("a socket that closes cancels the 12 s no-answer diagnosis", () => {
    const ws = connected();
    main({ kind: "rest-token", token: TOKEN, savedAt: 1, reason: "saved" });
    ws.serverClose();
    vi.advanceTimersByTime(13_000);
    expect(badge()).not.toBe("No answer from server");
  });
});

describe("review fixes (fourth pass)", () => {
  it("a socket that closes mid-check does not leave the badge on Checking… forever", () => {
    const ws = connected();
    main({ kind: "rest-token", token: TOKEN, savedAt: 1, reason: "saved" });
    expect(badge()).toBe("Checking…");
    ws.serverClose();
    expect(badge()).not.toBe("Checking…");
    expect(badge()).toMatch(/not checked/i);
  });
});

describe("review fixes (fifth pass)", () => {
  it("a disconnect mid-check keeps the token preview in the tooltip (never the token)", () => {
    const ws = connected();
    main({ kind: "rest-token", token: TOKEN, savedAt: 1, reason: "saved" });
    ws.serverClose();
    const title = String(els["token-badge"]!.title);
    expect(title).toContain("figd_…" + TOKEN.slice(-4));
    expect(title).not.toContain(TOKEN);
  });

  it("a Save refused AFTER a disconnect turned Checking… into 'not checked' restores the previous badge", () => {
    const ws = connected();
    ws.receive({ type: "rest_status", status: { state: "valid", source: "plugin", handle: "h", masked: "figd_…abcd" } });
    els["token-input"]!.value = TOKEN;
    (els["token-save"]!.onclick as () => void)();
    ws.serverClose();
    main({ kind: "rest-token", reason: "rejected", error: "Not a token" });
    expect(badge()).toBe("Valid (@h)");
  });
});

describe("review fixes (sixth pass)", () => {
  it("a Save made while OFFLINE says 'not checked', then checks once the server assigns the window", () => {
    const ws1 = connected();
    ws1.serverClose();
    main({ kind: "rest-token", token: TOKEN, savedAt: 5, reason: "saved" });
    expect(badge()).toMatch(/not checked/i);
    vi.advanceTimersByTime(600);
    const ws2 = last();
    ws2.open();
    ws2.receive({ type: "assigned", channel: "chan-a", resumeToken: "tok-a" });
    main({ kind: "rest-token", token: TOKEN, savedAt: 5, reason: "sync" });
    expect(ws2.sent.at(-1)).toMatchObject({ type: "set_rest_token", token: TOKEN });
    expect(badge()).toBe("Checking…");
    ws2.receive({ type: "rest_status", status: { state: "valid", source: "plugin", handle: "h" } });
    expect(badge()).toBe("Valid (@h)");
  });
});

