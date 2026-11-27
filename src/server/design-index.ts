/**
 * A local, multi-file index of the design systems this machine has read.
 *
 * Every time a component / style / variable list comes back from a file —
 * through the plugin or the REST API — its names are written to
 * `<cwd>/.figma-cache/files/<file>.json` (or `$FIGMA_CACHE_DIR`). An agent can
 * then ask "which file has a DatePicker?" across every file it has seen,
 * without any of them being open, and get the file key + node id to read or
 * instantiate it from.
 *
 * Metadata only — names, ids, keys, types, descriptions. No node trees, no
 * images, no token. The folder is gitignored; `FIGMA_CACHE=off` disables it.
 */
import { link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileNameKey } from "../shared/figma-url.js";

export interface IndexedItem {
  kind: "component" | "component_set" | "style" | "variable";
  name: string;
  id?: string;
  key?: string;
  /** Style type (FILL/TEXT/…), variable type (COLOR/FLOAT/…), component type. */
  type?: string;
  description?: string;
}

export interface IndexedFile {
  fileKey: string | null;
  fileName: string;
  updatedAt: string;
  source: "plugin" | "rest";
  items: IndexedItem[];
}

export interface SearchHit extends IndexedItem {
  fileKey: string | null;
  fileName: string;
  score: number;
}

const MAX_ITEMS_PER_FILE = 5000;

/** figma_read ops answered from the index (server-side, no plugin round-trip for search). */
export const LOCAL_INDEX_OPS = ["search_design_index", "index_design_file"] as const;

/**
 * Lowercase words, accents dropped ("Nút bấm" → nut bam, "Đơn" → don) —
 * any script's letters kept: a CJK or Cyrillic name is words too, not "".
 */
function words(s: string): string[] {
  return s
    .replace(/[đĐ]/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** 0 = no match. Exact name > prefix > contains > every query word present. */
export function scoreName(name: string, query: string): number {
  const n = words(name).join(" ");
  const q = words(query).join(" ");
  // An empty query lists everything; a query of only punctuation matches nothing.
  if (!q) return query.trim() ? 0 : 1;
  if (n === q) return 100;
  const last = words(name.split("/").pop() ?? name).join(" ");
  if (last === q) return 90;
  if (n.startsWith(q) || last.startsWith(q)) return 70;
  if (n.includes(q)) return 50;
  const qw = words(query);
  const nw = new Set(words(name));
  const hit = qw.filter((w) => nw.has(w) || [...nw].some((x) => x.startsWith(w))).length;
  return hit === qw.length ? 30 : 0;
}

function safeFileId(fileKey: string | null, fileName: string): string {
  const base = fileKey || `name-${fileNameKey(fileName) || "untitled"}`;
  return base.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

/** Pull indexable items out of whatever a read returned. Tolerant of every shape this server produces. */
export function itemsFromResult(op: string, result: unknown): IndexedItem[] {
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const out: IndexedItem[] = [];
  const pushComponents = (list: unknown) => {
    for (const c of Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []) {
      if (typeof c?.name !== "string") continue;
      const t = String(c.type ?? "COMPONENT");
      out.push({
        kind: t === "COMPONENT_SET" ? "component_set" : "component",
        name: c.name,
        ...(typeof c.id === "string" ? { id: c.id } : {}),
        ...(typeof c.key === "string" && c.key ? { key: c.key } : {}),
        type: t,
        ...(typeof c.description === "string" && c.description ? { description: c.description.slice(0, 300) } : {}),
      });
    }
  };
  const pushStyles = (list: unknown, type?: string) => {
    for (const s of Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []) {
      if (typeof s?.name !== "string") continue;
      out.push({ kind: "style", name: s.name, ...(typeof s.id === "string" ? { id: s.id } : {}), ...(typeof s.key === "string" && s.key ? { key: s.key } : {}), type: String(s.type ?? s.styleType ?? type ?? "STYLE"), ...(typeof s.description === "string" && s.description ? { description: s.description.slice(0, 300) } : {}) });
    }
  };
  const pushVariables = (collections: unknown) => {
    for (const c of Array.isArray(collections) ? (collections as Array<Record<string, unknown>>) : []) {
      for (const v of Array.isArray(c?.variables) ? (c.variables as Array<Record<string, unknown>>) : []) {
        if (typeof v?.name !== "string") continue;
        out.push({ kind: "variable", name: typeof c.name === "string" ? `${c.name}/${v.name}` : v.name, ...(typeof v.id === "string" ? { id: v.id } : {}), type: String(v.resolvedType ?? v.type ?? "VARIABLE") });
      }
    }
  };
  if (op === "get_components" || op === "find_component") pushComponents(r.components ?? r.matches ?? result);
  if (op === "get_styles") {
    if (Array.isArray(r.styles)) pushStyles(r.styles);
    for (const [k, t] of [["paint", "FILL"], ["paintStyles", "FILL"], ["text", "TEXT"], ["textStyles", "TEXT"], ["effect", "EFFECT"], ["effectStyles", "EFFECT"], ["grid", "GRID"], ["gridStyles", "GRID"]] as const) pushStyles(r[k], t);
  }
  if (op === "get_variables") pushVariables(r.collections ?? result);
  if (op === "get_design_system_kit" || op === "design_kit") {
    pushComponents(r.components);
    const st = (r.styles ?? {}) as Record<string, unknown>;
    for (const [k, t] of [["paint", "FILL"], ["text", "TEXT"], ["effect", "EFFECT"], ["grid", "GRID"]] as const) pushStyles(st[k], t);
    pushVariables(((r.variables ?? {}) as Record<string, unknown>).collections);
  }
  return out;
}

/**
 * How old a lock may get while its writer is still running before it is
 * taken for a hung one. Far above any index write — a live writer is never
 * broken in practice; a DEAD writer's lock is broken at once (pid check).
 */
const LOCK_STALE_MS = 30_000;
/** How long to wait for another process's lock before writing without it. */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;

/** Is the process that wrote this lock still running? */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A lock that names no pid (empty: an older build mid-write) is broken once this old. */
const LOCK_NO_PID_MS = 3_000;
/** link() errors that mean "this filesystem has no hard links" (exFAT, FAT, some network mounts). */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EINVAL"]);

/** The pid a lock's content names, or null when it does not name one. */
export function lockOwner(content: string): number | null {
  const m = /^(\d+)(?::|\s*$)/.exec(content);
  return m ? Number(m[1]) : null;
}

/**
 * Run `fn` holding an exclusive lock file — best effort: the index is a
 * cache, so a lost race costs at most one index update, never a read.
 *
 * - The lock's content is just the writer's pid (what every build reads).
 *   It is written COMPLETE to a private file, then hard-linked into place
 *   (`link` fails with EEXIST when it is taken), so nobody reads it half
 *   written. Where the filesystem has no hard links, an O_EXCL create is used.
 * - Ownership is the lock file's INODE (a hard link shares ours): a lock is
 *   released only while it is still ours, and a broken lock that turns out to
 *   be a different file than the one judged dead is put back.
 * - Only EEXIST means "someone else holds it" and is waited on; any other
 *   error (a read-only cache folder) skips the lock at once.
 * - A lock is broken when its writer is dead, when it names no pid and is
 *   LOCK_NO_PID_MS old, or when it is LOCK_STALE_MS old.
 * - After LOCK_WAIT_MS the write goes ahead unlocked, and `fn` is told so.
 * - Not covered (no compare-and-rename on a filesystem): a third process
 *   taking the lock in the instant it is put back or released, and a cache
 *   folder shared by several MACHINES (pids are per machine).
 */
export async function withFileLock<T>(lockPath: string, fn: (locked: boolean) => Promise<T>): Promise<T> {
  const pid = String(process.pid);
  const mine = `${lockPath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  let held = false;
  let myIno: number | undefined;
  try {
    await writeFile(mine, pid, { flag: "wx" });
    myIno = (await stat(mine)).ino;
  } catch {
    await unlink(mine).catch(() => undefined);
    return fn(false); // the folder cannot be written: no lock to be had
  }
  let hardLinks = true;
  /** true = taken, false = someone holds it, undefined = cannot lock here. */
  const take = async (): Promise<boolean | undefined> => {
    if (hardLinks) {
      try {
        await link(mine, lockPath);
        return true;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "";
        if (code === "EEXIST") return false;
        if (!NO_HARD_LINKS.has(code)) return undefined;
        hardLinks = false;
      }
    }
    try {
      await writeFile(lockPath, pid, { flag: "wx" });
      myIno = (await stat(lockPath)).ino;
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EEXIST" ? false : undefined;
    }
  };
  try {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      const got = await take();
      if (got) {
        held = true;
        break;
      }
      if (got === undefined) break;
      let owner: string;
      let seen: { ino: number; mtimeMs: number };
      try {
        const [st, content] = await Promise.all([stat(lockPath), readFile(lockPath, "utf8")]);
        owner = content;
        seen = st;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // released between the calls
        break; // unreadable: do not spin on it
      }
      const ownerPid = lockOwner(owner);
      const age = Date.now() - seen.mtimeMs;
      const breakable = (ownerPid !== null && !alive(ownerPid)) || (ownerPid === null && age > LOCK_NO_PID_MS) || age > LOCK_STALE_MS;
      if (breakable) {
        const grave = `${lockPath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.stale`;
        const moved = await rename(lockPath, grave).then(() => true, () => false);
        if (moved) {
          const ino = await stat(grave).then((g) => g.ino, () => seen.ino);
          // Someone took the lock between our look and our rename: give it back.
          if (ino !== seen.ino) await link(grave, lockPath).catch(() => undefined);
          await unlink(grave).catch(() => undefined);
          continue;
        }
      }
      await sleep(LOCK_POLL_MS);
    }
  } finally {
    await unlink(mine).catch(() => undefined);
  }
  try {
    return await fn(held);
  } finally {
    if (held) {
      const ino = await stat(lockPath).then((st) => st.ino, () => undefined);
      if (ino !== undefined && ino === myIno) await unlink(lockPath).catch(() => undefined);
    }
  }
}

export class DesignIndex {
  readonly dir: string;
  private writing = Promise.resolve();

  constructor(dir?: string) {
    this.dir = resolve(dir ?? process.env.FIGMA_CACHE_DIR ?? join(process.cwd(), ".figma-cache"));
  }

  /** null when FIGMA_CACHE=off. */
  static fromEnv(): DesignIndex | null {
    if (/^(off|0|false|no)$/i.test(process.env.FIGMA_CACHE ?? "")) return null;
    return new DesignIndex();
  }

  private filesDir(): string {
    return join(this.dir, "files");
  }

  /**
   * Merge `items` into the file's entry: items of the kinds given replace
   * that kind's old items (a re-read of components replaces components and
   * leaves styles alone). Writes are serialised and atomic (tmp + rename).
   */
  record(
    file: { fileKey: string | null; fileName: string; source: "plugin" | "rest" },
    items: IndexedItem[],
    /**
     * "replace": `items` is the file's WHOLE list of those kinds (an
     * unfiltered read) and replaces it. "merge": a partial answer
     * (find_component, a capped read) — adds and updates, never removes;
     * replacing there shrank 300 indexed components to the 3 a search found.
     */
    mode: "replace" | "merge" = "replace",
  ): Promise<IndexedFile | null> {
    if (!items.length) return Promise.resolve(null);
    const run = this.writing.then(async () => {
      await mkdir(this.filesDir(), { recursive: true });
      const id = safeFileId(file.fileKey, file.fileName);
      const path = join(this.filesDir(), `${id}.json`);
      // Two files with one name ("Untitled") are two files: an entry stored
      // by name is never folded into a keyed one — nothing here can prove
      // they are the same file.
      const kinds = new Set(items.map((i) => (i.kind === "component_set" ? "component" : i.kind)));
      // Identity: the node id when there is one (a rename keeps it, and must
      // not leave the old name behind), else the name.
      const identity = (i: IndexedItem) => (i.id ? `${i.kind === "component_set" ? "component" : i.kind}|#${i.id}` : `${i.kind}|${i.name}`);
      const build = (prev: IndexedFile | null): IndexedFile => {
        const previous = prev?.items ?? [];
        const kept = mode === "merge" ? previous : previous.filter((i) => !kinds.has(i.kind === "component_set" ? "component" : i.kind));
        // New items first: an update wins, and when the cap cuts, it cuts what is oldest.
        const seen = new Set<string>();
        const merged = [...items, ...kept].filter((i) => {
          const k = identity(i);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        return {
          fileKey: file.fileKey ?? prev?.fileKey ?? null,
          fileName: file.fileName || prev?.fileName || "",
          updatedAt: new Date().toISOString(),
          source: file.source,
          items: merged.slice(0, MAX_ITEMS_PER_FILE),
        };
      };
      // Leader and follower share this folder: the read-modify-write runs
      // under a lock file, so neither overwrites what the other just wrote.
      return withFileLock(`${path}.lock`, async () => {
        let prev: IndexedFile | null = null;
        try {
          prev = JSON.parse(await readFile(path, "utf8")) as IndexedFile;
        } catch {
          prev = null;
        }
        const entry = build(prev);
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(entry), "utf8");
          await rename(tmp, path);
        } catch (e) {
          await unlink(tmp).catch(() => undefined);
          throw e;
        }
        await this.ensureGitignore();
        return entry;
      });
    });
    this.writing = run.then(() => undefined, () => undefined);
    return run;
  }

  /** A `.gitignore` of `*` inside the cache, so it is never committed whatever the repo's rules. */
  private async ensureGitignore(): Promise<void> {
    try {
      await writeFile(join(this.dir, ".gitignore"), "*\n", { flag: "wx" });
    } catch {
      /* already there */
    }
  }

  async files(): Promise<IndexedFile[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.filesDir())).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: IndexedFile[] = [];
    for (const n of names) {
      try {
        out.push(JSON.parse(await readFile(join(this.filesDir(), n), "utf8")) as IndexedFile);
      } catch {
        /* a half-written or foreign file — skip */
      }
    }
    return out;
  }

  async search(query: string, opts: { kinds?: string[]; limit?: number; file?: string } = {}): Promise<{ hits: SearchHit[]; total: number; files: Array<{ fileKey: string | null; fileName: string; items: number; updatedAt: string }> }> {
    const files = await this.files();
    const kinds = opts.kinds?.length ? new Set(opts.kinds.map((k) => (k === "component_set" ? "component" : k))) : null;
    const want = opts.file ? fileNameKey(opts.file) : "";
    const hits: SearchHit[] = [];
    for (const f of files) {
      if (want && fileNameKey(f.fileName) !== want && f.fileKey !== opts.file) continue;
      for (const i of f.items) {
        if (kinds && !kinds.has(i.kind === "component_set" ? "component" : i.kind)) continue;
        const score = scoreName(i.name, query) + (i.description && words(i.description).some((w) => words(query).includes(w)) ? 5 : 0);
        if (score > 0) hits.push({ ...i, fileKey: f.fileKey, fileName: f.fileName, score });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const limit = opts.limit && opts.limit > 0 ? Math.min(500, Math.floor(opts.limit)) : 30;
    return {
      hits: hits.slice(0, limit),
      total: hits.length,
      files: files.map((f) => ({ fileKey: f.fileKey, fileName: f.fileName, items: f.items.length, updatedAt: f.updatedAt })),
    };
  }
}
