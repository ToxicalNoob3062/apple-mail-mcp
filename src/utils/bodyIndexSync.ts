/**
 * Body index: who keeps it current. The writer lock, the FSEvents watcher and
 * the background loop live here; the schema, queries and indexing steps are in
 * bodyIndex.ts.
 *
 *  - **Opt-in, and inert when off.** Needs `APPLE_MAIL_MCP_BODY_INDEX` *and*
 *    `APPLE_MAIL_MCP_ENVELOPE_INDEX`. With either off, nothing here creates a
 *    file, a watcher or a timer. On a runtime without `node:sqlite` (Node <
 *    22.5) or without FTS5 `contentless_delete`, it reports why and stays off.
 *  - **One writer per index file.** Hosts like the Claude desktop app run one
 *    server instance per conversation, all sharing the file. The first to take
 *    the lock is the writer — the only one that walks, watches, parses and
 *    writes; the rest attach the index read-only when they search. The lock is
 *    an exclusive SQLite transaction on a small sidecar file; the OS drops it
 *    when the process exits or crashes, and a reader takes over on its next
 *    search or within {@link WRITER_RETRY_MS}.
 *  - **Watcher plus walk.** A recursive `fs.watch` (one FSEvents stream on
 *    macOS) reports new, changed, moved and deleted `.emlx` files, applied in a
 *    batch after a short quiet period. FSEvents can coalesce or drop events and
 *    Node doesn't surface those flags, so a periodic full walk is the
 *    guarantee: every {@link RESCAN_WATCHED_MS}, or {@link RESCAN_UNWATCHED_MS}
 *    without a watcher. An event without a file name, a renamed `.mbox` or a
 *    watcher error starts a walk at once.
 *  - **Small slices.** Walking and indexing run in {@link SLICE_MS} slices with
 *    {@link PAUSE_MS} between them, on timers that are `unref()`'d; the watcher
 *    is non-persistent. Neither keeps the process alive, and both stop on
 *    shutdown. A search never waits for indexing: it applies queued file
 *    events and indexes for at most {@link SEARCH_CATCHUP_MS}, then answers
 *    with whatever coverage the index has.
 *
 * @module utils/bodyIndexSync
 */

import { watch as fsWatch } from "fs";
import { dirname, join } from "path";
import {
  BodyIndexWriter,
  bodyIndexLockPath,
  bodyIndexPath,
  ensurePrivateDir,
  ensurePrivateFile,
  fts5Unsupported,
  inspectIndexFile,
  readIndexState,
  realClock,
  stampMismatch,
  type Clock,
  type IndexCounts,
  type IndexMeta,
} from "@/utils/bodyIndex.js";
import {
  FULL_DISK_ACCESS_REASON,
  isEnvelopeIndexEnabled,
  isTruthyFlag,
  loadSqlite,
  resolveMailStore,
  type SqliteDatabase,
  type SqliteModule,
} from "@/utils/envelopeIndex.js";

/** Env switch for the body index. */
export const BODY_INDEX_ENV = "APPLE_MAIL_MCP_BODY_INDEX";

/** Full walk interval while the watcher runs (a safety net) and without it (the update path). */
export const RESCAN_WATCHED_MS = 10 * 60_000;
export const RESCAN_UNWATCHED_MS = 5 * 60_000;
/** Collect file events this long before applying them, so a sync burst is one batch. */
export const WATCH_DEBOUNCE_MS = 1_500;
/** How often a reader checks whether the writer has gone. */
export const WRITER_RETRY_MS = 30_000;
/** One slice of walking or indexing, then a pause. ~33% of a core while there is work. */
export const SLICE_MS = 50;
export const PAUSE_MS = 100;
/** Most indexing a search does before answering (queued file events only, in practice). */
export const SEARCH_CATCHUP_MS = 50;
/** A search's catch-up leaves files larger than this to the background loop, so it never waits on a big parse. */
export const SEARCH_CATCHUP_MAX_BYTES = 1024 * 1024;

/** Whether body search via the local index is switched on. */
export function isBodyIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyFlag(env[BODY_INDEX_ENV]) && isEnvelopeIndexEnabled(env);
}

/** What feeds file changes in; swappable in tests. */
export type WatchFn = (
  dir: string,
  onEvent: (eventType: string, filename: string | null) => void,
  onError: (err: unknown) => void
) => { close(): void };

/** Node's recursive `fs.watch`: on macOS, one FSEvents stream for the whole tree. */
const fsEventsWatch: WatchFn = (dir, onEvent, onError) => {
  const w = fsWatch(dir, { recursive: true, persistent: false }, (eventType, filename) =>
    onEvent(eventType, filename === null ? null : String(filename))
  );
  w.on("error", onError);
  return w;
};

// --- module state (one per process) ---------------------------------------

let watchImpl: WatchFn = fsEventsWatch;
let clock: Clock = realClock;
let sqliteOverride: SqliteModule | null | undefined;

let writer: BodyIndexWriter | null = null;
let writerLock: SqliteDatabase | null = null;
let watcher: { close(): void } | null = null;
let backgroundTimer: ReturnType<typeof setTimeout> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
const changedPaths = new Set<string>();
let walkRequested = false;
let lastError: string | null = null;

function sqliteModule(): SqliteModule | null {
  return sqliteOverride === undefined ? loadSqlite() : sqliteOverride;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function noteError(where: string, err: unknown): void {
  lastError = `${new Date(clock.now()).toISOString()} ${where}: ${errText(err)}`;
  console.error(`[bodyIndex] ${where}: ${errText(err)}`);
  try {
    writer?.setMeta("lastError", lastError);
  } catch {
    /* the index itself may be the problem */
  }
}

/**
 * Why the body index can't run on this server, or null when it can. Checked in
 * an order that touches nothing: the flags, the runtime, SQLite's FTS5, then
 * whether the Mail store is readable.
 */
export function bodyIndexUnavailable(): string | null {
  if (!isBodyIndexEnabled()) return "body index disabled";
  const sqlite = sqliteModule();
  if (!sqlite) return "node:sqlite unavailable (requires Node >= 22.5)";
  const fts = fts5Unsupported(sqlite);
  if (fts) return fts;
  if (!resolveMailStore()) return FULL_DISK_ACCESS_REASON;
  return null;
}

// --- writer role --------------------------------------------------------------

function tryAcquireWriterLock(sqlite: SqliteModule, indexPath: string): boolean {
  if (writerLock) return true;
  let db: SqliteDatabase | null = null;
  try {
    const lockPath = bodyIndexLockPath(indexPath);
    ensurePrivateDir(dirname(lockPath));
    ensurePrivateFile(lockPath);
    db = new sqlite.DatabaseSync(lockPath);
    db.exec("PRAGMA busy_timeout = 0");
    // An in-memory journal: holding the lock must not leave a `-journal` file
    // (with the umask's mode) next to it.
    db.exec("PRAGMA journal_mode = MEMORY");
    db.exec("BEGIN EXCLUSIVE");
    writerLock = db;
    return true;
  } catch {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    return false;
  }
}

function releaseWriterLock(): void {
  if (!writerLock) return;
  try {
    writerLock.exec("ROLLBACK");
  } catch {
    /* ignore */
  }
  try {
    writerLock.close();
  } catch {
    /* ignore */
  }
  writerLock = null;
}

/**
 * Become the writer if no other instance is: take the lock, open the index
 * read-write (creating or rebuilding it), and start watching when the
 * background loop runs. Returns the writer, or null when another instance
 * holds the role (or the index can't be opened, which is noted).
 */
function claimWriter(): BodyIndexWriter | null {
  if (writer) return writer;
  const sqlite = sqliteModule();
  const store = resolveMailStore();
  if (!sqlite || !store) return null;
  const path = bodyIndexPath();
  if (!tryAcquireWriterLock(sqlite, path)) return null;
  const opened = BodyIndexWriter.open(store.versionDir, path, sqlite, clock);
  if ("reason" in opened) {
    releaseWriterLock();
    noteError("open", opened.reason);
    return null;
  }
  writer = opened;
  if (opened.rebuilt) console.error(`[bodyIndex] rebuilt the index: ${opened.rebuilt}`);
  console.error("[bodyIndex] writer: this instance keeps the index current");
  if (running) startWatching(opened);
  return writer;
}

/** Whether this instance is the one keeping the index current. */
export function isBodyIndexWriter(): boolean {
  return writer !== null;
}

/** Whether the FSEvents watcher is feeding changes in. */
export function isBodyIndexWatching(): boolean {
  return watcher !== null;
}

// --- watcher -------------------------------------------------------------------

function startWatching(w: BodyIndexWriter): void {
  if (watcher) return;
  try {
    watcher = watchImpl(
      w.versionDir,
      (eventType, filename) => {
        if (filename === null) {
          walkRequested = true; // FSEvents coalesced or dropped events
        } else if (filename.endsWith(".emlx")) {
          if (filename.split("/")[0] === "MailData") return;
          changedPaths.add(join(w.versionDir, filename));
        } else if (eventType === "rename" && filename.endsWith(".mbox")) {
          walkRequested = true; // a mailbox was moved, renamed or deleted
        } else {
          return;
        }
        scheduleBatch();
      },
      (err) => {
        noteError("file watcher stopped, using timed walks", err);
        stopWatching();
        walkRequested = true;
        wake(0);
      }
    );
  } catch (err) {
    noteError("file watcher unavailable, using timed walks", err);
    watcher = null;
  }
}

function stopWatching(): void {
  try {
    watcher?.close();
  } catch {
    /* ignore */
  }
  watcher = null;
}

function scheduleBatch(): void {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    wake(0);
  }, WATCH_DEBOUNCE_MS);
  debounceTimer.unref?.();
}

/** Hand queued watcher events to the writer. */
function flushChanges(w: BodyIndexWriter): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  if (walkRequested) {
    walkRequested = false;
    changedPaths.clear(); // the walk will see them
    w.startWalk();
    return;
  }
  if (changedPaths.size === 0) return;
  const batch = [...changedPaths];
  changedPaths.clear();
  w.applyChanges(batch);
}

// --- background loop -------------------------------------------------------------

function wake(delay: number): void {
  if (!running) return;
  if (backgroundTimer) clearTimeout(backgroundTimer);
  backgroundTimer = setTimeout(tick, delay);
  backgroundTimer.unref?.();
}

/**
 * One slice of background work. A reader only checks whether it can take over.
 * The writer applies file events, then does one slice of whichever is pending
 * — the walk first, then indexing — and sleeps until the next walk is due once
 * there is nothing left.
 */
function tick(): void {
  backgroundTimer = null;
  const w = claimWriter();
  if (!w) {
    wake(WRITER_RETRY_MS);
    return;
  }
  const interval = watcher ? RESCAN_WATCHED_MS : RESCAN_UNWATCHED_MS;
  try {
    flushChanges(w);
    if (w.walkDue(interval)) w.startWalk();
    if (w.walking) {
      w.walkStep(SLICE_MS);
      wake(PAUSE_MS);
      return;
    }
    if (w.hasQueued()) {
      w.indexStep(SLICE_MS);
      wake(PAUSE_MS);
      return;
    }
  } catch (err) {
    noteError("indexing step failed", err);
  }
  wake(interval);
}

/**
 * Start keeping the index current in the background. No-op (and no file, timer
 * or watcher) when the index is disabled; logs why when it is enabled but
 * can't run.
 */
export function startBackgroundIndexing(): void {
  if (running) return;
  const unavailable = bodyIndexUnavailable();
  if (unavailable) {
    if (isBodyIndexEnabled()) {
      lastError = unavailable;
      console.error(`[bodyIndex] not started: ${unavailable}`);
    }
    return;
  }
  running = true;
  const w = claimWriter();
  if (w) startWatching(w);
  else console.error("[bodyIndex] reader: another server instance keeps the index current");
  wake(PAUSE_MS);
}

/** Stop background work and the watcher, give up the writer role, close the index. */
export function stopBodyIndexing(): void {
  running = false;
  if (backgroundTimer) clearTimeout(backgroundTimer);
  backgroundTimer = null;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  stopWatching();
  changedPaths.clear();
  walkRequested = false;
  writer?.close();
  writer = null;
  releaseWriterLock();
}

// --- search & status ----------------------------------------------------------

/**
 * Get ready for a body search: returns the index file to attach, or why body
 * search can't run. The writer first applies queued file events and indexes
 * for at most {@link SEARCH_CATCHUP_MS}, so a message that just arrived is
 * usually found; nobody waits for the build. Whether the file can be searched
 * (ours, current schema) is checked at attach time.
 */
export function prepareBodySearch(): { ok: true; file: string } | { ok: false; reason: string } {
  const unavailable = bodyIndexUnavailable();
  if (unavailable) return { ok: false, reason: unavailable };
  const path = bodyIndexPath();
  const w = claimWriter();
  if (w) {
    try {
      flushChanges(w);
      if (!w.walking && w.hasQueued()) {
        w.indexStep(SEARCH_CATCHUP_MS, { maxBytes: SEARCH_CATCHUP_MAX_BYTES });
      }
      // Taking the watcher's events cancelled the wake-up they had scheduled:
      // hand what is left (a walk, the rest of the queue) to the loop now.
      if (w.walking || w.hasQueued()) wake(0);
    } catch (err) {
      noteError("search catch-up failed", err);
    }
  } else if (inspectIndexFile(path) === "missing") {
    return { ok: false, reason: "body index not created yet" };
  }
  return { ok: true, file: path };
}

/** The body index's state, for `doctor`. */
export interface BodyIndexStatus {
  enabled: boolean;
  /** Why it isn't running, when enabled but unavailable. */
  unavailable?: string;
  path?: string;
  role?: "writer" | "reader";
  watching?: boolean;
  counts?: IndexCounts;
  meta?: IndexMeta;
  /** Last error this process saw (the writer also records it in the index). */
  lastError?: string;
}

/** Report the index's state without changing anything. */
export function bodyIndexStatus(): BodyIndexStatus {
  if (!isBodyIndexEnabled()) return { enabled: false };
  const unavailable = bodyIndexUnavailable();
  if (unavailable) return { enabled: true, unavailable, ...(lastError ? { lastError } : {}) };
  const path = bodyIndexPath();
  const status: BodyIndexStatus = {
    enabled: true,
    path,
    role: writer ? "writer" : "reader",
    watching: watcher !== null,
    ...(lastError ? { lastError } : {}),
  };
  try {
    if (writer) {
      Object.assign(status, writer.state());
    } else if (inspectIndexFile(path) === "ours") {
      const db = new (sqliteModule()!.DatabaseSync)(path, { readOnly: true });
      try {
        const mismatch = stampMismatch(db);
        if (mismatch) status.unavailable = mismatch;
        else Object.assign(status, readIndexState(db));
      } finally {
        db.close();
      }
    } else {
      status.unavailable = "index file not created yet";
    }
  } catch (err) {
    status.unavailable = `index unreadable: ${errText(err)}`;
  }
  return status;
}

/** Test hook: stop everything and swap the watcher, clock or SQLite module. */
export function resetBodyIndexForTests(
  opts: { watch?: WatchFn; clock?: Clock; sqlite?: SqliteModule | null } = {}
): void {
  stopBodyIndexing();
  watchImpl = opts.watch ?? fsEventsWatch;
  clock = opts.clock ?? realClock;
  sqliteOverride = "sqlite" in opts ? opts.sqlite : undefined;
  lastError = null;
}
