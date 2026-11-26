import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netServer, type Server as NetServer } from "node:net";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ServerHandle } from "../../src/server/index.js";
import type { BridgeRequest, WireMessage } from "../../src/shared/protocol.js";

/**
 * The MCP server as a client sees it: tools are listed before the election
 * finishes (a slow election used to leave the client with "connection
 * closed" / 0 tools), and a cancelled call drops its op from the queue
 * instead of running it later for nobody.
 */

let dir: string;
let prevTmp: string | undefined;
let prevPort: string | undefined;
const handles: ServerHandle[] = [];
const holes: NetServer[] = [];

beforeEach(async () => {
  prevTmp = process.env["TMPDIR"];
  prevPort = process.env["FIGMA_MCP_PORT"];
  dir = await mkdtemp(join(tmpdir(), "figma-plugin-startup-"));
  process.env["TMPDIR"] = dir;
});

afterEach(async () => {
  while (handles.length) await handles.pop()?.close().catch(() => {});
  while (holes.length) holes.pop()?.close();
  if (prevTmp === undefined) delete process.env["TMPDIR"];
  else process.env["TMPDIR"] = prevTmp;
  if (prevPort === undefined) delete process.env["FIGMA_MCP_PORT"];
  else process.env["FIGMA_MCP_PORT"] = prevPort;
  await rm(dir, { recursive: true, force: true });
});

async function connectClient(port: number): Promise<{ client: Client; handle: ServerHandle }> {
  process.env["FIGMA_MCP_PORT"] = String(port);
  const handle = await createServer();
  handles.push(handle);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return { client, handle };
}

describe("MCP server startup", () => {
  it("lists tools while the election is still running", async () => {
    // A silent process on the start port makes the election take > 1.5s.
    const hole = netServer(() => {});
    holes.push(hole);
    await new Promise<void>((r) => hole.listen(46420, "127.0.0.1", () => r()));

    const t0 = Date.now();
    const { client, handle } = await connectClient(46420);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("figma_status");
    expect(Date.now() - t0).toBeLessThan(1000);

    // A tool call waits for the election instead of failing.
    const status = await client.callTool({ name: "figma_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    expect(await handle.ready).toBe("leader");
  }, 20_000);
});

describe("a cancelled tool call", () => {
  it("drops its op from the window's queue", async () => {
    const { client, handle } = await connectClient(46430);
    expect(await handle.ready).toBe("leader");

    const received: BridgeRequest[] = [];
    const ws = new WebSocket("ws://127.0.0.1:46430/ws");
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString()) as WireMessage;
      if (msg.type === "request") received.push(msg.payload); // never answers
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 6,
        pluginVersion: "1",
        fileKey: null,
        fileName: "File A",
        pageName: "Page 1",
        editorType: "figma",
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    // First call occupies the window; the second queues behind it.
    void client.callTool({ name: "figma_read", arguments: { op: "get_selection" } }).catch(() => {});
    await waitFor(() => received.length === 1);
    const abort = new AbortController();
    const second = client
      .callTool({ name: "figma_read", arguments: { op: "get_selection", params: { detail: "sparse" } } }, undefined, {
        signal: abort.signal,
      })
      .catch((e: unknown) => e);
    await waitFor(() => handle.coordinator.bridge!.queueLength === 1);
    abort.abort();
    await second;
    await waitFor(() => handle.coordinator.bridge!.queueLength === 0);
    expect(received).toHaveLength(1);
    ws.terminate();
  }, 20_000);
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
