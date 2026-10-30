/**
 * The build loop (what the build process runs), driven on this thread through
 * a hand-held port with fake timers, on a synthetic mail store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BodyIndexWriter, ftsPhrase } from "@/utils/bodyIndex.js";
import {
  ORPHAN_CHECK_MS,
  runBuilder,
  runBuilderProcess,
  type BuilderInit,
  type BuilderProcess,
  type BuilderReport,
  type BuilderStart,
  type BuilderWork,
} from "@/utils/bodyIndexBuild.js";
import { realClock } from "@/utils/bodyIndex.js";
import { plainMessage, sqlite, writeEmlx } from "@/utils/envelopeIndex.testFixture.js";

const describeIfSqlite = sqlite ? describe : describe.skip;

function port() {
  const reports: BuilderReport[] = [];
  let listener: ((w: BuilderWork) => void) | null = null;
  return {
    reports,
    types: () => reports.map((r) => r.type),
    send: (w: Omit<BuilderWork, "type">) => listener!({ type: "work", ...w }),
    port: {
      postMessage: (m: BuilderReport) => reports.push(m),
      on: (_e: "message", fn: (w: BuilderWork) => void) => {
        listener = fn;
      },
    },
  };
}

describeIfSqlite("runBuilder", () => {
  let root: string;
  let init: BuilderInit;
  let main: BodyIndexWriter;

  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), "bodyidx-build-"));
    const store = join(root, "V10");
    writeEmlx(store, "ACC", "INBOX", 1, plainMessage("a", "harbour cruise"));
    writeEmlx(store, "ACC", "INBOX", 2, plainMessage("b", "dentist appointment"));
    init = { versionDir: store, indexPath: join(root, "body.db"), sliceMs: 50, pauseMs: 100 };
    // The main thread has created and stamped the file before any build starts.
    const opened = BodyIndexWriter.open(store, init.indexPath, sqlite!);
    if ("reason" in opened) throw new Error(opened.reason);
    main = opened;
  });
  afterEach(() => {
    vi.useRealTimers();
    main.close();
    rmSync(root, { recursive: true, force: true });
  });

  const deps = () => ({ sqlite, clock: realClock });
  const hits = (text: string) =>
    main.db
      .prepare("SELECT rowid AS id FROM bodies WHERE bodies MATCH ? ORDER BY rowid")
      .all(ftsPhrase(text))
      .map((r) => Number(r.id));

  it("reports ready with its process, then walks, indexes and reports idle for the last hand-off", () => {
    const p = port();
    const loop = runBuilder(p.port, init, deps());
    expect(p.reports).toEqual([{ type: "ready", pid: process.pid }]);
    p.send({ seq: 1, walk: true, paths: [] });
    vi.advanceTimersByTime(5_000);
    expect(p.types()).toEqual(["ready", "walked", "idle"]);
    expect(p.reports.at(-1)).toEqual({ type: "idle", seq: 1 });
    expect(main.state().counts.indexed).toBe(2);
    expect(hits("dentist")).toEqual([2]);
    // Idle: no timer left spinning.
    expect(vi.getTimerCount()).toBe(0);
    loop.stop();
  });

  it("applies file changes without a walk, and reports the newest hand-off it saw", () => {
    const p = port();
    const loop = runBuilder(p.port, init, deps());
    const added = writeEmlx(init.versionDir, "ACC", "INBOX", 3, plainMessage("c", "boarding"));
    p.send({ seq: 4, walk: false, paths: [added] });
    p.send({ seq: 5, walk: false, paths: [] });
    vi.advanceTimersByTime(1_000);
    expect(p.types()).toEqual(["ready", "idle"]);
    expect(p.reports.at(-1)).toEqual({ type: "idle", seq: 5 });
    expect(hits("boarding")).toEqual([3]);
    loop.stop();
  });

  it("paces itself: one slice, then a pause", () => {
    for (let id = 10; id < 40; id++) {
      writeEmlx(init.versionDir, "ACC", "INBOX", id, plainMessage("x", `note ${id}`));
    }
    // 20 ms per clock read: a 50 ms slice indexes a couple of files, then pauses.
    let t = 0;
    const p = port();
    const loop = runBuilder(p.port, init, {
      sqlite,
      clock: { now: () => Date.now(), monotonic: () => (t += 20) },
    });
    p.send({ seq: 1, walk: true, paths: [] });
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(1); // the pause before the next slice
    vi.advanceTimersByTime(60_000);
    expect(p.reports.at(-1)).toEqual({ type: "idle", seq: 1 });
    loop.stop();
  });

  it("reports a missing index instead of creating one", () => {
    rmSync(init.indexPath);
    const p = port();
    const loop = runBuilder(p.port, { ...init, indexPath: join(root, "nope.db") }, deps());
    expect(p.reports).toEqual([
      { type: "failed", where: "open", message: expect.stringContaining("does not exist") },
    ]);
    expect(() => loop.stop()).not.toThrow(); // nothing to stop
  });

  it("reports a store it can't read, before doing any work", () => {
    const p = port();
    const loop = runBuilder(p.port, { ...init, versionDir: join(root, "unreadable") }, deps());
    expect(p.reports).toEqual([
      { type: "failed", where: "store", message: "can't read the Mail store (ENOENT)" },
    ]);
    expect(main.state().counts.indexed).toBe(0);
    expect(() => loop.stop()).not.toThrow(); // its connection is already closed
  });

  it("reports when node:sqlite is missing", () => {
    const p = port();
    runBuilder(p.port, init, { sqlite: null, clock: realClock });
    expect(p.reports).toEqual([
      { type: "failed", where: "open", message: expect.stringContaining("node:sqlite") },
    ]);
  });

  it("reports a failed step, records it in the index, and does no more", () => {
    const p = port();
    runBuilder(p.port, init, deps());
    p.send({ seq: 1, walk: false, paths: [] });
    main.db.exec("DROP TABLE docs");
    vi.advanceTimersByTime(1_000);
    expect(p.reports.at(-1)).toEqual({
      type: "failed",
      where: "step",
      message: expect.stringContaining("no such table"),
    });
    const lastError = main.db.prepare("SELECT value FROM meta WHERE key = 'lastError'").get();
    expect(String(lastError?.value)).toMatch(/index build: .*no such table/);
    // Later work is ignored: it failed, the main thread decides what next.
    p.send({ seq: 2, walk: true, paths: [] });
    vi.advanceTimersByTime(1_000);
    expect(p.types().filter((t) => t === "failed")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a hand-off it can't apply", () => {
    const p = port();
    runBuilder(p.port, init, deps());
    main.db.exec("DROP TABLE docs");
    p.send({ seq: 1, walk: false, paths: [join(init.versionDir, "x", "1.emlx")] });
    expect(p.reports.at(-1)).toMatchObject({ type: "failed", where: "step" });
    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops between slices and closes its connection", () => {
    const p = port();
    const loop = runBuilder(p.port, init, deps());
    p.send({ seq: 1, walk: true, paths: [] });
    loop.stop();
    expect(vi.getTimerCount()).toBe(0);
    p.send({ seq: 2, walk: true, paths: [] });
    vi.advanceTimersByTime(5_000);
    expect(p.types()).toEqual(["ready"]);
    expect(main.state().counts.indexed).toBe(0);
  });
});

/** A stand-in for the build process's `process`. */
function fakeProcess() {
  const state = {
    sent: [] as BuilderReport[],
    ppid: 4242,
    exited: null as number | null,
    sendFails: false,
    onMessage: null as null | ((m: BuilderStart | BuilderWork) => void),
    onDisconnect: null as null | (() => void),
  };
  const proc: BuilderProcess = {
    send: (m) => {
      if (state.sendFails) throw new Error("ERR_IPC_CHANNEL_CLOSED");
      state.sent.push(m);
    },
    onMessage: (fn) => {
      state.onMessage = fn;
    },
    onDisconnect: (fn) => {
      state.onDisconnect = fn;
    },
    ppid: () => state.ppid,
    exit: (code) => {
      state.exited = code;
    },
  };
  return { state, proc };
}

describeIfSqlite("runBuilderProcess (the forked build process)", () => {
  let root: string;
  let init: BuilderInit;
  let main: BodyIndexWriter;

  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), "bodyidx-proc-"));
    const store = join(root, "V10");
    writeEmlx(store, "ACC", "INBOX", 1, plainMessage("a", "harbour cruise"));
    init = { versionDir: store, indexPath: join(root, "body.db"), sliceMs: 50, pauseMs: 100 };
    const opened = BodyIndexWriter.open(store, init.indexPath, sqlite!);
    if ("reason" in opened) throw new Error(opened.reason);
    main = opened;
  });
  afterEach(() => {
    vi.useRealTimers();
    main.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("waits for start, then serves work over the channel", () => {
    const f = fakeProcess();
    runBuilderProcess(f.proc, { sqlite, clock: realClock });
    f.state.onMessage!({ type: "work", seq: 1, walk: true, paths: [] }); // before start: ignored
    expect(f.state.sent).toEqual([]);
    f.state.onMessage!({ type: "start", init });
    f.state.onMessage!({ type: "start", init }); // only one loop
    f.state.onMessage!({ type: "work", seq: 2, walk: true, paths: [] });
    vi.advanceTimersByTime(5_000);
    expect(f.state.sent.map((m) => m.type)).toEqual(["ready", "walked", "idle"]);
    expect(main.state().counts.indexed).toBe(1);
    expect(f.state.exited).toBeNull();
  });

  it("exits when its channel closes, and ignores anything after", () => {
    const f = fakeProcess();
    runBuilderProcess(f.proc, { sqlite, clock: realClock });
    f.state.onMessage!({ type: "start", init });
    f.state.onDisconnect!();
    expect(f.state.exited).toBe(0);
    f.state.onDisconnect!();
    f.state.onMessage!({ type: "work", seq: 1, walk: true, paths: [] });
    vi.advanceTimersByTime(5_000);
    expect(f.state.sent.map((m) => m.type)).toEqual(["ready"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exits when its parent is gone (reparented to launchd), even with the channel open", () => {
    const f = fakeProcess();
    runBuilderProcess(f.proc, { sqlite, clock: realClock });
    f.state.onMessage!({ type: "start", init });
    vi.advanceTimersByTime(ORPHAN_CHECK_MS * 3);
    expect(f.state.exited).toBeNull();
    f.state.ppid = 1;
    vi.advanceTimersByTime(ORPHAN_CHECK_MS);
    expect(f.state.exited).toBe(0);
  });

  it("exits when a report can't be sent", () => {
    const f = fakeProcess();
    f.state.sendFails = true;
    runBuilderProcess(f.proc, { sqlite, clock: realClock, orphanCheckMs: 10 });
    f.state.onMessage!({ type: "start", init });
    expect(f.state.exited).toBe(0);
  });
});
