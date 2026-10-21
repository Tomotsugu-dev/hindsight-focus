import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import "../history.js";

const H = globalThis.FocusHistory;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const BASE = new Date(2026, 9, 20, 23, 50).getTime();
const category = { id: "code", name: "编程", color: "#123456", superCategory: { id: "work", name: "工作", color: "#578b6d" } };

function recorder() {
  let value = H.reduce(null, { type: "boot", sessionId: "a" }, BASE);
  return {
    get value() { return value; },
    focus(time, kind = "work", app = "Code", at = time) {
      value = H.reduce(value, { type: "focus", sessionId: "a", at, kind, app, category }, time);
    },
    tick(time) { value = H.reduce(value, { type: "tick", sessionId: "a" }, time); },
    range(from, to) { return H.range(value, from, to, { now: to, projectMs: 0 }); },
  };
}

test("first observation begins on receipt; old source time and timer state cannot backfill", () => {
  const r = recorder();
  r.focus(BASE + MINUTE, "work", "Code", BASE - MINUTE);
  r.tick(BASE + MINUTE + 15000);
  const got = r.range(BASE, BASE + 2 * MINUTE);
  assert.equal(got.workMs, 15000);
  assert.equal(got.segments[0].start, BASE + MINUTE);
  assert.deepEqual(got.segments[0].category, { id: "code", superId: "work", name: "编程", superName: "工作", color: "#578b6d" });
});

test("foreground chronology survives timer phases and midnight; adjacent identical observations merge", () => {
  const r = recorder();
  r.focus(BASE);
  for (let t = BASE + 15000; t <= BASE + 50 * MINUTE; t += 15000) {
    // The history API has no timer phase: finishing, pausing and resting cannot clear it.
    r.tick(t);
  }
  r.focus(BASE + 50 * MINUTE);
  r.tick(BASE + 50 * MINUTE + 15000);
  const got = r.range(BASE, BASE + 50 * MINUTE + 15000);
  assert.equal(got.workMs, 50 * MINUTE + 15000);
  assert.equal(got.segments.length, 1);
});

test("half-open boundaries and clipping count each millisecond once", () => {
  const r = recorder();
  r.focus(BASE);
  r.tick(BASE + 15000);
  r.focus(BASE + 30000, "slack", "Video");
  r.tick(BASE + 45000);
  assert.equal(r.range(BASE + 10000, BASE + 30000).workMs, 20000);
  const right = r.range(BASE + 30000, BASE + 45000);
  assert.equal(right.workMs, 0);
  assert.equal(right.slackMs, 15000);
  assert.equal(right.knownMs + right.unknownMs, 15000);
});

test("sleep gap does not extend old focus and ticks wait for a newly received event", () => {
  const r = recorder();
  r.focus(BASE);
  r.tick(BASE + 15000);
  r.tick(BASE + 2 * MINUTE);
  r.tick(BASE + 2 * MINUTE + 15000);
  r.focus(BASE + 3 * MINUTE, "work", "Code", BASE + 15000);
  r.tick(BASE + 3 * MINUTE + 15000);
  const got = r.range(BASE, BASE + 4 * MINUTE);
  assert.equal(got.workMs, 30000);
  assert.equal(got.segments.length, 2);
  assert.equal(got.segments[1].start, BASE + 3 * MINUTE);
});

test("worker restart preserves past observations and cannot inherit an active tail", () => {
  const r = recorder();
  r.focus(BASE);
  r.tick(BASE + 15000);
  const boot = H.reduce(r.value, { type: "boot", sessionId: "b" }, BASE + 30000);
  const staleWorker = H.reduce(boot, { type: "focus", sessionId: "a", at: BASE + 40000, kind: "work" }, BASE + 40000);
  const tick = H.reduce(staleWorker, { type: "tick", sessionId: "b" }, BASE + 45000);
  const got = H.range(tick, BASE, BASE + MINUTE, { now: BASE + MINUTE });
  assert.equal(got.workMs, 15000);
  assert.equal(tick.focus, null);
});

test("a delayed focus corrects the observed tail; out-of-order and future source times stay bounded", () => {
  const r = recorder();
  r.focus(BASE);
  r.tick(BASE + 15000);
  r.focus(BASE + 30000, "slack", "Video", BASE + 10000);
  r.focus(BASE + 35000, "neutral", "Old", BASE + 5000);
  let got = r.range(BASE, BASE + 35000);
  assert.equal(got.workMs, 10000);
  assert.equal(got.slackMs, 25000);
  assert.equal(got.neutralMs, 0);
  r.focus(BASE + 40000, "work", "Code", BASE + 5 * MINUTE);
  r.tick(BASE + 45000);
  got = r.range(BASE, BASE + 45000);
  assert.equal(got.knownMs, 45000);
  assert.ok(got.segments.every((g) => g.end >= g.start && g.end <= BASE + 45000));
});

test("live projection lasts at most 15 seconds and never bridges an expired heartbeat", () => {
  const r = recorder();
  r.focus(BASE);
  r.tick(BASE + 15000);
  assert.equal(H.range(r.value, BASE, BASE + MINUTE, { now: BASE + 40000 }).workMs, 30000);
  assert.equal(H.range(r.value, BASE, BASE + MINUTE, { now: BASE + MINUTE + 1 }).workMs, 15000);
  assert.equal(H.range(r.value, BASE, BASE + MINUTE, { now: BASE + 25000, projectMs: 999999 }).workMs, 25000);
});

test("rolling 24-hour retention clips old segments; max count and bytes leave database headroom", () => {
  const raw = { version: 1, sessionId: "a", sessionStartedAt: BASE, observedSince: BASE, lastEventAt: BASE,
    updatedAt: BASE, focus: null, segments: [{ start: BASE - H.RETENTION_MS - MINUTE, end: BASE - H.RETENTION_MS + MINUTE, kind: "work", app: "Code", category }] };
  const clipped = H.reduce(raw, { type: "tick", sessionId: "a" }, BASE);
  assert.equal(clipped.segments[0].start, BASE - H.RETENTION_MS);
  const longName = "😀\"\\".repeat(1000);
  raw.segments = Array.from({ length: 1500 }, (_, i) => ({ start: BASE - (1500 - i) * 1000, end: BASE - (1499 - i) * 1000,
    kind: i % 2 ? "work" : "slack", app: longName, category: { id: longName, name: longName, superId: longName, superName: longName, color: "#123456" } }));
  const bounded = H.reduce(raw, { type: "tick", sessionId: "a" }, BASE);
  assert.ok(bounded.segments.length <= 1200);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 512000);
});

test("malformed overlap cannot inflate summary; unknown does not count as away", () => {
  const got = H.summarize({ segments: [
    { start: 0, end: 20, kind: "work" }, { start: 10, end: 40, kind: "slack" },
    { start: 40, end: 30, kind: "away" }, { start: 50, end: 60, kind: "away" },
  ] }, 10, 100, { now: 100 });
  assert.equal(got.knownMs, 40);
  assert.equal(got.unknownMs, 50);
  assert.equal(got.awayMs, 10);
  assert.equal(got.workMs + got.slackMs + got.neutralMs + got.awayMs, got.knownMs);
});

test("reducer does not mutate saved values", () => {
  const r = recorder();
  r.focus(BASE);
  const previous = JSON.stringify(r.value);
  H.reduce(r.value, { type: "tick", sessionId: "a" }, BASE + 15000);
  assert.equal(JSON.stringify(r.value), previous);
});

test("Store records while idle and paused; history write failure leaves timer commands operational", async () => {
  const rows = new Map();
  let now = BASE;
  let failHistory = false;
  let failures = 0;
  const ctx = { Date: class extends Date { static now() { return now; } }, Math, navigator: { language: "zh-CN" },
    console: { error() { failures++; } }, hindsight: { async call(method, { sql, params = [] } = {}) {
      if (method === "notifications.send") return;
      if (method === "db.query") return rows.has(params[0]) ? [rows.get(params[0])] : [];
      if (method !== "db.execute") throw new Error(method);
      if (sql.startsWith("CREATE")) return { changes: 0 };
      const key = sql.startsWith("INSERT") ? params[0] : params[1];
      if (failHistory && key === "history") throw new Error("history disk failure");
      if (sql.startsWith("INSERT")) {
        if (rows.has(key)) return { changes: 0 };
        rows.set(key, { value: params[1], version: 0 });
      } else {
        const previous = rows.get(key);
        if (!previous || previous.version !== params[2]) return { changes: 0 };
        rows.set(key, { value: params[0], version: previous.version + 1 });
      }
      return { changes: 1 };
    } } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const file of ["i18n.js", "core.js", "history.js", "store.js"]) vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), ctx);
  await ctx.FocusStore.startHistory();
  let state = await ctx.FocusStore.apply({ type: "focus", at: now, event: { app: "Code", category } });
  assert.equal(state.phase, "idle");
  now += 15000;
  await ctx.FocusStore.apply({ type: "tick" });
  await ctx.FocusStore.apply({ type: "command", name: "start" });
  now += 15000;
  state = await ctx.FocusStore.apply({ type: "command", name: "pause" });
  assert.equal(state.phase, "paused");
  now += 15000;
  await ctx.FocusStore.apply({ type: "tick" });
  const history = await ctx.FocusStore.history();
  assert.equal(H.range(history, BASE, now, { now, projectMs: 0 }).workMs, 45000);
  failHistory = true;
  now += 15000;
  state = await ctx.FocusStore.apply({ type: "tick" });
  assert.equal(state.phase, "paused");
  assert.equal(failures, 1);
  state = await ctx.FocusStore.apply({ type: "command", name: "resume" });
  assert.equal(state.phase, "working");
});
