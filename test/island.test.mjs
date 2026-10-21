// island.js 的测试，和 core.js 里给岛用的 trail、nextLimit。跑法：node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import "../i18n.js";
import "../core.js";
import "../island.js";

const C = globalThis.FocusCore;
const I = globalThis.FocusI18n;
const F = globalThis.FocusIsland;
const MIN = C.MINUTE;

// 2026-10-21 是周三
const at = (h, m, s = 0) => new Date(2026, 9, 21, h, m, s).getTime();
const defaults = C.withDefaults(null);
const code = { name: "编程", superName: "工作", color: "#a78bfa", icon: "Code" };

/** 按时间顺序喂给规则，返回每一步之后的状态 */
function day(settings = defaults) {
  let state = null;
  const feed = (time, input) => {
    state = C.step(state, settings, input, time, "zh-CN").state;
    return state;
  };
  return {
    start: (t) => feed(t, { type: "command", name: "start" }),
    pause: (t) => feed(t, { type: "command", name: "pause" }),
    tick: (t) => feed(t, { type: "tick" }),
    focus: (t, kind, extra = {}) => feed(t, { type: "focus", at: t, kind, ...extra }),
  };
}

const island = (state, now, settings = defaults, lang = "zh-CN") =>
  F.content(state, settings, now, lang);

test("还没开始、等下一段的时候岛上不放东西", () => {
  const d = day();
  assert.equal(island(d.tick(at(9, 0)), at(9, 0)), null);
  d.focus(at(9, 0), "work", { app: "Code", category: code });
  d.start(at(9, 0));
  // 45 分钟做完，休息 15 分钟；休息结束时不在工作的分类里，就等下一段
  d.tick(at(9, 45));
  d.focus(at(9, 50), "neutral");
  const waiting = d.tick(at(10, 1));
  assert.equal(waiting.phase, "waiting");
  assert.equal(island(waiting, at(10, 1)), null);
});

test("计时时：左边是分类的图标，右边倒数本段，展开有暂停按钮", () => {
  const d = day();
  d.focus(at(9, 0), "work", { app: "Code", category: code });
  const s = d.start(at(9, 0));
  const c = island(s, at(9, 10));
  assert.deepEqual(c.closed.left, { type: "icon", name: "Code", color: "#a78bfa" });
  assert.equal(c.closed.right.start, new Date(at(9, 0)).toISOString());
  assert.equal(c.closed.right.end, new Date(at(9, 45)).toISOString());
  assert.equal(c.closed.right.pausedAt, undefined);
  assert.deepEqual(c.open.right[1], { type: "button", id: "pause", icon: "Pause" });
  assert.deepEqual(c.open.topRight.text, "今天完成 0 段");
  assert.deepEqual(c.open.left[0].text, [
    { text: "工作中", bold: true },
    { text: " · Code", dim: true },
  ]);
});

test("计时器自己倒数：同一个状态过了几秒，内容不变，不用重交", () => {
  const d = day();
  d.focus(at(9, 0), "work", { app: "Code", category: code });
  const s = d.start(at(9, 0));
  const a = island(s, at(9, 10, 5));
  const b = island(s, at(9, 10, 20));
  assert.deepEqual(a.closed, b.closed);
  assert.deepEqual(a.open.right, b.open.right);
});

test("计时停着：停在最后一次计时停下的那一刻，灰色", () => {
  const d = day();
  d.focus(at(9, 0), "work", { app: "Code", category: code });
  d.start(at(9, 0));
  // 9:20 切到不算工作的分类，设置成暂停计时
  const settings = { ...defaults, rhythm: { ...defaults.rhythm, neutral: "pause" } };
  const s = C.step(
    d.tick(at(9, 20)),
    settings,
    { type: "focus", at: at(9, 20), kind: "neutral", app: "Finder" },
    at(9, 20),
    "zh-CN",
  ).state;
  const later = island(s, at(9, 30), settings);
  assert.equal(later.closed.right.pausedAt, new Date(at(9, 20)).toISOString());
  assert.equal(later.closed.right.start, new Date(at(9, 0)).toISOString());
  assert.equal(later.closed.right.color, "#918d9f");
  // 停着的时候过多久都一样
  assert.deepEqual(later.closed, island(s, at(9, 40), settings).closed);
});

test("暂停时是继续按钮，休息时没有按钮、倒数休息", () => {
  const d = day();
  d.focus(at(9, 0), "work", { app: "Code", category: code });
  d.start(at(9, 0));
  const paused = island(d.pause(at(9, 5)), at(9, 6));
  assert.equal(paused.closed.left.name, "Pause");
  assert.deepEqual(paused.open.right[1], { type: "button", id: "resume", icon: "Play" });

  const d2 = day();
  d2.focus(at(9, 0), "work", { app: "Code", category: code });
  d2.start(at(9, 0));
  const resting = d2.tick(at(9, 46));
  const c = island(resting, at(9, 50));
  assert.equal(c.closed.left.name, "Coffee");
  assert.equal(c.closed.right.start, new Date(at(9, 45)).toISOString());
  assert.equal(c.closed.right.end, new Date(at(10, 0)).toISOString());
  assert.equal(c.open.right.length, 1);
  assert.equal(c.open.topRight.text, "今天完成 1 段");
});

test("轨迹：一分钟一格，超过 60 分钟时一格几分钟，行数不超过 3", () => {
  const d = day();
  d.focus(at(9, 0), "work", { app: "Code", category: code });
  const s = d.start(at(9, 0));
  const cells = (minutes) =>
    island(s, at(9, 10, 30), { ...defaults, rhythm: { ...defaults.rhythm, workMinutes: minutes } })
      .open.left[1];
  const c45 = cells(45);
  assert.equal(c45.colors.length, 45);
  assert.equal(c45.columns, 15);
  assert.equal(c45.current, 10);
  assert.deepEqual(c45.colors.slice(9, 12), ["#a78bfa", "#a78bfa", null]);
  for (const minutes of [1, 25, 60, 61, 90, 120, 200, 480]) {
    const c = cells(minutes);
    assert.ok(c.colors.length <= 60, `${minutes}`);
    assert.ok(c.columns <= 20 && Math.ceil(c.colors.length / c.columns) <= 3, `${minutes}`);
    assert.ok(c.current === null || c.current < c.colors.length, `${minutes}`);
  }
});

test("每种语言的字都在岛的上限里，长应用名截断", () => {
  const d = day();
  const long = "A Very Long Application Name That Goes On";
  d.focus(at(9, 0), "slack", { app: long, category: code });
  d.start(at(9, 0));
  for (const s of [d.tick(at(9, 1)), d.tick(at(9, 7)), d.pause(at(9, 8))]) {
    for (const lang of I.LOCALES) {
      const c = island(s, at(9, 9), defaults, lang);
      const line = c.open.left[0].text.map((r) => r.text).join("");
      assert.ok(F.width(line) <= 20, `${lang} ${s.phase} ${line}`);
      assert.ok(F.width(c.open.topRight.text) <= 20, `${lang} ${c.open.topRight.text}`);
    }
  }
});

test("fit：去掉换行和控制字符，太长的截到上限并加省略号", () => {
  assert.equal(F.fit("a\nb\u0007c", 20), "abc");
  assert.equal(F.fit("abcdef", 5), "abc…");
  assert.equal(F.width(F.fit("专注专注专注", 7)), 6);
});

test("nextLimit：计时时是本段做完，休息时是休息结束，停着没有", () => {
  const d = day();
  d.focus(at(9, 0), "work", { app: "Code", category: code });
  assert.equal(C.nextLimit(d.tick(at(9, 0)), defaults.rhythm), null);
  const s = d.start(at(9, 0));
  assert.equal(C.nextLimit(s, defaults.rhythm), at(9, 45));
  // 9:10 开始摸鱼：5 分钟后计时停下，比本段做完早
  const slack = d.focus(at(9, 10), "slack");
  assert.equal(C.nextLimit(slack, defaults.rhythm), at(9, 15));
  assert.equal(C.nextLimit(d.pause(at(9, 12)), defaults.rhythm), null);
  const d2 = day();
  d2.focus(at(9, 0), "work");
  d2.start(at(9, 0));
  assert.equal(C.nextLimit(d2.tick(at(9, 50)), defaults.rhythm), at(10, 0));
});
