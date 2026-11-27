/**
 * The design-index lock on a disk WITHOUT hard links (exFAT, FAT, some SMB
 * mounts): link() fails with EPERM there, so the lock falls back to an
 * exclusive create — and a lock broken by mistake is moved back with rename.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return {
    ...real,
    link: async () => {
      throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
    },
  };
});

const { withFileLock } = await import("../../src/server/design-index.js");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lock-nolink-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("lock without hard links", () => {
  it("still LOCKS (exclusive create), holds the pid, and is released", async () => {
    const lock = join(dir, "a.lock");
    let content = "";
    const locked = await withFileLock(lock, async (l) => {
      content = await readFile(lock, "utf8");
      return l;
    });
    expect(locked).toBe(true);
    expect(content).toBe(String(process.pid));
    expect(await readdir(dir)).toEqual([]); // lock and temp file both gone
  });

  it("a live holder is waited on, then the lock is taken", async () => {
    const lock = join(dir, "b.lock");
    await writeFile(lock, String(process.ppid));
    setTimeout(() => void rm(lock, { force: true }), 100);
    expect(await withFileLock(lock, async (l) => l)).toBe(true);
  });

  it("a dead holder's lock is broken at once", async () => {
    const { spawnSync } = await import("node:child_process");
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const lock = join(dir, "c.lock");
    await writeFile(lock, String(dead));
    const started = Date.now();
    expect(await withFileLock(lock, async (l) => l)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
