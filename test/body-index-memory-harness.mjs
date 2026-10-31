/**
 * Manual harness: memory and responsiveness of a server instance while the
 * opt-in body index builds from scratch against the real Mail store.
 *
 * It starts the server with the body index switched on (or off, for the
 * baseline), points the index at a fresh temp file, and while the first build
 * runs it samples the server's RSS and thread count with `ps` and times MCP
 * `ping` round trips (a request that does no I/O, so its latency is the main
 * thread's). Progress is read from the index file read-only. After the build is
 * done it keeps sampling, to show whether the build's memory is held or
 * returned. On macOS `ps` RSS also counts pages malloc has freed but the
 * kernel hasn't reclaimed yet, so at the end of the build and of the run it
 * also reads the physical footprint (what Activity Monitor shows, and its
 * peak) with `vmmap --summary`, and the largest categories with `footprint`.
 *
 * When the build runs in a child process, its RSS is sampled too (any child
 * of the server), so its cost is reported rather than hidden.
 *
 * Only counts and timings are printed — never subjects, senders or bodies. The
 * Mail store is only read (by the server); the index goes to a temp directory
 * that is removed at the end. Needs Full Disk Access for the Node runtime.
 *
 * The server must sit in a checkout (it reads ../package.json at startup).
 *
 * Run:  node test/body-index-memory-harness.mjs [build/index.js] [--off]
 *       HARNESS_AFTER_SECONDS=60 node test/body-index-memory-harness.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const off = args.includes("--off");
const serverPath = args.find((a) => !a.startsWith("--")) ?? "build/index.js";
const AFTER_SECONDS = Number(process.env.HARNESS_AFTER_SECONDS ?? 30);
const OFF_SECONDS = Number(process.env.HARNESS_OFF_SECONDS ?? 30);
const TIMEOUT_SECONDS = Number(process.env.HARNESS_TIMEOUT_SECONDS ?? 900);
const SAMPLE_MS = 200;

const dir = mkdtempSync(join(tmpdir(), "amcp-bodyidx-harness-"));
const indexFile = join(dir, "body-index.db");

const env = {
  ...process.env,
  APPLE_MAIL_MCP_ENVELOPE_INDEX: "1",
  APPLE_MAIL_MCP_BODY_INDEX: off ? "0" : "1",
  APPLE_MAIL_MCP_BODY_INDEX_FILE: indexFile,
  APPLE_MAIL_MCP_IMAP_IDLE: "0",
};
const t0 = performance.now();
const server = spawn(process.execPath, [serverPath], { env, stdio: ["pipe", "pipe", "pipe"] });
// Server diagnostics are counts and states only; keep the [bodyIndex] lines,
// and everything if the server dies early.
let stderrTail = "";
server.stderr.on("data", (d) => {
  stderrTail = (stderrTail + String(d)).slice(-4000);
  for (const line of String(d).split("\n")) {
    if (line.includes("[bodyIndex]")) console.error(`  ${line.trim()}`);
  }
});
let exited = false;
server.on("exit", (code) => {
  exited = true;
  for (const resolve of pending.values()) resolve({ error: `server exited (${code})` });
  pending.clear();
});

const pending = new Map();
let buf = "";
server.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* not JSON-RPC */
    }
  }
});
let nextId = 1;
function request(method, params = {}) {
  const id = nextId++;
  if (exited) return Promise.resolve({ error: "server exited" });
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (kb) => Math.round(kb / 1024);

const childPids = new Set();
function sampleProcess() {
  try {
    const rss = Number(execFileSync("ps", ["-o", "rss=", "-p", String(server.pid)]).toString());
    const threads =
      execFileSync("ps", ["-M", "-p", String(server.pid)]).toString().trim().split("\n").length - 1;
    let childRss = 0;
    try {
      const kids = execFileSync("pgrep", ["-P", String(server.pid)]).toString().trim().split("\n");
      for (const k of kids.filter(Boolean)) {
        childPids.add(k);
        childRss += Number(execFileSync("ps", ["-o", "rss=", "-p", k]).toString()) || 0;
      }
    } catch {
      /* no children */
    }
    return { rss, threads, childRss };
  } catch {
    return null;
  }
}

/** Physical footprint now and at its peak (MB), from `vmmap --summary`. */
function physFootprint() {
  try {
    const out = execFileSync("vmmap", ["--summary", String(server.pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    }).toString();
    const read = (label) => {
      const m = new RegExp(`^${label}:\\s+([\\d.]+)([KMG])`, "m").exec(out);
      if (!m) return null;
      return Math.round(Number(m[1]) * { K: 1 / 1024, M: 1, G: 1024 }[m[2]]);
    };
    return { now: read("Physical footprint"), peak: read("Physical footprint \\(peak\\)") };
  } catch {
    return null;
  }
}

/** The largest dirty-memory categories (MB), from `footprint`. */
function footprintTop(n = 5) {
  try {
    const out = execFileSync("footprint", ["-p", String(server.pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const unit = { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 };
    const rows = [];
    for (const line of out.split("\n")) {
      const m = /^\s*([\d.]+) (B|KB|MB|GB)\s+[\d.]+ (?:B|KB|MB|GB)\s+[\d.]+ (?:B|KB|MB|GB)\s+\d+\s+(.+)$/.exec(line);
      if (m && m[3] !== "TOTAL") rows.push([m[3].trim(), +(Number(m[1]) * unit[m[2]]).toFixed(1)]);
    }
    return Object.fromEntries(rows.sort((a, b) => b[1] - a[1]).slice(0, n));
  } catch {
    return null;
  }
}

/** Build progress from the index file, read-only; null before it exists. */
function progress() {
  if (!existsSync(indexFile)) return null;
  let db;
  try {
    db = new DatabaseSync(indexFile, { readOnly: true });
    const docs = db
      .prepare("SELECT count(*) AS n, coalesce(sum(state = 0), 0) AS queued FROM docs")
      .get();
    const walked = db.prepare("SELECT value FROM meta WHERE key = 'lastFullWalk'").get();
    return { docs: Number(docs.n), queued: Number(docs.queued), walked: walked !== undefined };
  } catch {
    return null; // being created
  } finally {
    db?.close();
  }
}

function stats(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    p50: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
  };
}

async function main() {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "body-index-memory-harness", version: "1" },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}\n${stderrTail}`);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const phases = {
    build: { rss: [], threads: [], ping: [], childRss: [], total: [] },
    after: { rss: [], threads: [], ping: [], childRss: [], total: [] },
  };
  let phase = "build";
  let doneAt = null;
  let lastProgress = null;
  let footprintAtDone = null;
  const deadline = t0 + (off ? OFF_SECONDS : TIMEOUT_SECONDS) * 1000;

  // Ping continuously, one in flight at a time.
  let pinging = true;
  const pinger = (async () => {
    while (pinging && !exited) {
      const t = performance.now();
      await request("ping");
      phases[phase].ping.push(performance.now() - t);
      await sleep(SAMPLE_MS);
    }
  })();

  while (performance.now() < deadline && !exited) {
    const p = sampleProcess();
    if (p) {
      phases[phase].rss.push(p.rss);
      phases[phase].threads.push(p.threads);
      phases[phase].childRss.push(p.childRss);
      phases[phase].total.push(p.rss + p.childRss);
    }
    if (!off && phase === "build") {
      const pr = progress();
      if (pr) lastProgress = pr;
      if (pr && pr.walked && pr.queued === 0 && pr.docs > 0) {
        doneAt = performance.now();
        phase = "after";
        footprintAtDone = physFootprint();
        console.error(`  build done: ${pr.docs} files in ${((doneAt - t0) / 1000).toFixed(1)} s`);
      }
    }
    if (phase === "after" && performance.now() - doneAt >= AFTER_SECONDS * 1000) break;
    await sleep(SAMPLE_MS);
  }
  pinging = false;
  await pinger;
  const footprintAtEnd = exited ? null : physFootprint();
  const categoriesAtEnd = exited ? null : footprintTop();
  if (exited) throw new Error(`server exited during the run\n${stderrTail}`);

  const b = phases.build;
  const a = phases.after;
  const report = {
    server: serverPath,
    node: process.version,
    mode: off ? "flag off" : "body index on",
    files: lastProgress?.docs ?? 0,
    buildSeconds: doneAt ? +((doneAt - t0) / 1000).toFixed(1) : null,
    rssMB: {
      peak: mb(Math.max(...b.rss, ...a.rss)),
      steadyDuringRun: off ? mb(b.rss[b.rss.length - 1]) : undefined,
      atBuildDone: a.rss.length ? mb(a.rss[0]) : undefined,
      afterBuild: a.rss.length ? mb(a.rss[a.rss.length - 1]) : undefined,
      afterBuildMin: a.rss.length ? mb(Math.min(...a.rss)) : undefined,
    },
    physFootprintMB: {
      peak: footprintAtEnd?.peak,
      atBuildDone: footprintAtDone?.now,
      atEnd: footprintAtEnd?.now,
      largestAtEnd: categoriesAtEnd,
    },
    buildProcess: {
      processesSeen: childPids.size,
      rssPeakMB: mb(Math.max(0, ...b.childRss, ...a.childRss)),
      runningAfterBuild: a.childRss.length ? a.childRss[a.childRss.length - 1] > 0 : undefined,
      serverPlusBuildPeakMB: mb(Math.max(...b.total, ...a.total)),
    },
    threads: {
      maxDuringBuild: Math.max(...b.threads),
      afterBuild: a.threads.length ? a.threads[a.threads.length - 1] : undefined,
    },
    pingMs: { duringBuild: stats(b.ping), afterBuild: stats(a.ping) },
  };
  console.log(JSON.stringify(report, null, 2));
}

try {
  await main();
} finally {
  if (!exited) {
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
  }
  rmSync(dir, { recursive: true, force: true });
}
