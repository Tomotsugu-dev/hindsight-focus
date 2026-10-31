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

/** 45 分钟做完，休息 15 分钟；10:00 休息结束时不在工作的分类里，就等下一段 */
function waiting() {
  const d = day();
  d.focus(at(9, 0), "work", { app: "Code", category: code });
  d.start(at(9, 0));
  d.tick(at(9, 45));
  d.focus(at(9, 50), "neutral");
  return d.tick(at(10, 1));
}

test("还没开始：左边是时钟，右边是灰色的一整段，展开有开始按钮；没有轨迹和分心", () => {
  const s = day().tick(at(9, 0));
  assert.equal(s.phase, "idle");
  const c = island(s, at(9, 5));
  assert.deepEqual(c.closed.left, { type: "icon", name: "Clock" });
  // 停在一段的开头：45 分钟，不走
  assert.equal(c.closed.right.color, "#918d9f");
  assert.equal(c.closed.right.start, new Date(at(9, 0)).toISOString());
  assert.equal(c.closed.right.end, new Date(at(9, 45)).toISOString());
  assert.equal(c.closed.right.pausedAt, c.closed.right.start);
  assert.deepEqual(c.open.right, [c.closed.right, { type: "button", id: "start", icon: "Play" }]);
  assert.deepEqual(c.open.topRight.text, [{ text: "未开始", bold: true }]);
  assert.deepEqual(c.open.left, []);
  assert.equal(c.open.bottomRight, undefined);
  // 等多久都一样，不用重交
  assert.deepEqual(island(s, at(11, 0)), c);
  // 有今日目标就放目标
  const items = [{ id: "code", seconds: 30 * 60, superCategory: { id: "work" } }];
  assert.deepEqual(F.content(s, defaults, at(9, 5), "zh-CN", items).open.left.map((x) => x.type), ["text"]);
});

test("等下一段：也是时钟和灰色的一整段，展开有轨迹和分心，没有按钮", () => {
  const s = waiting();
  assert.equal(s.phase, "waiting");
  const c = island(s, at(10, 1));
  assert.deepEqual(c.closed.left, { type: "icon", name: "Clock" });
  assert.equal(c.closed.right.color, "#918d9f");
  // 从休息结束的 10:00 起的一整段
  assert.equal(c.closed.right.start, new Date(at(10, 0)).toISOString());
  assert.equal(c.closed.right.pausedAt, new Date(at(10, 0)).toISOString());
  assert.deepEqual(c.open.right, [c.closed.right]);
  assert.deepEqual(c.open.topRight.text, [{ text: "等下一段", bold: true }]);
  assert.deepEqual(c.open.left.map((x) => x.type), ["cells"]);
  assert.ok(c.open.left[0].colors.every((color) => color === null));
  assert.equal(c.open.bottomRight.text[1].text, "0");
});

test("不是工作日：只放一个时钟，鼠标移上去不展开", () => {
  // 2026-10-24 是周六
  const saturday = new Date(2026, 9, 24, 10, 0).getTime();
  const s = C.step(null, defaults, { type: "tick" }, saturday, "zh-CN").state;
  assert.deepEqual(island(s, saturday), { closed: { left: { type: "icon", name: "Clock" } } });
});

test("计时时：左边是小类的白色图标，右边绿色倒数本段，展开有暂停按钮", () => {
  const d = day();
  d.focus(at(9, 0), "work", { app: "Code", category: code });
  const s = d.start(at(9, 0));
  const c = island(s, at(9, 10));
  // 不给颜色，岛就画成白的
  assert.deepEqual(c.closed.left, { type: "icon", name: "Code" });
  assert.equal(c.closed.right.color, "#34d399");
  assert.equal(c.closed.right.start, new Date(at(9, 0)).toISOString());
  assert.equal(c.closed.right.end, new Date(at(9, 45)).toISOString());
  assert.equal(c.closed.right.pausedAt, undefined);
  assert.deepEqual(c.open.right[1], { type: "button", id: "pause", icon: "Pause" });
  // 右上角只有阶段名，不带应用名
  assert.deepEqual(c.open.topRight.text, [{ text: "工作中", bold: true }]);
  assert.deepEqual(c.open.bottomRight.text, [
    { text: "分心 " },
    { text: "0", color: "#ee939c", bold: true },
    { text: " 次" },
  ]);
  // 还没拿到统计：没有今日目标那一行，只有轨迹
  assert.deepEqual(c.open.left.map((x) => x.type), ["cells"]);
});

test("今日目标：第一个「至少」目标今天到了多少；没有这种目标就不放", () => {
  const d = day();
  d.focus(at(9, 0), "work", { app: "Code", category: code });
  const s = d.start(at(9, 0));
  const items = [
    { id: "code", seconds: 160 * 60 + 59, superCategory: { id: "work" } },
    { id: "video", seconds: 30 * 60, superCategory: { id: "play" } },
  ];
  const c = F.content(s, defaults, at(9, 10), "zh-CN", items);
  assert.deepEqual(c.open.left[0], {
    type: "text",
    text: [{ text: "2:40", bold: true }],
    sub: "/ 6:00",
    size: "large",
  });
  assert.equal(c.open.left[1].type, "cells");
  const atMostOnly = { ...defaults, goals: defaults.goals.filter((g) => g.rule === "atMost") };
  assert.equal(F.content(s, atMostOnly, at(9, 10), "zh-CN", items).open.left.length, 1);
});

test("分心次数跟着状态走，和计时用的同一份", () => {
  const d = day();
  d.focus(at(9, 0), "work", { app: "Code", category: code });
  d.start(at(9, 0));
  d.focus(at(9, 5), "slack", { app: "Video" });
  const s = d.focus(at(9, 6), "work", { app: "Code", category: code });
  assert.equal(island(s, at(9, 7)).open.bottomRight.text[1].text, "1");
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
  assert.deepEqual(paused.closed.left, { type: "icon", name: "Pause" });
  assert.equal(paused.closed.right.color, "#918d9f");
  assert.deepEqual(paused.open.right[1], { type: "button", id: "resume", icon: "Play" });

  const d2 = day();
  d2.focus(at(9, 0), "work", { app: "Code", category: code });
  d2.start(at(9, 0));
  const resting = d2.tick(at(9, 46));
  const c = island(resting, at(9, 50));
  assert.deepEqual(c.closed.left, { type: "icon", name: "Coffee" });
  assert.equal(c.closed.right.color, "#34d399");
  assert.equal(c.closed.right.start, new Date(at(9, 45)).toISOString());
  assert.equal(c.closed.right.end, new Date(at(10, 0)).toISOString());
  assert.equal(c.open.right.length, 1);
  assert.deepEqual(c.open.topRight.text, [{ text: "休息中", bold: true }]);
});

test("轨迹：一分钟一格，超过 60 分钟时一格几分钟，行数不超过 3", () => {
  const d = day();
  d.focus(at(9, 0), "work", { app: "Code", category: code });
  const s = d.start(at(9, 0));
  const cells = (minutes) =>
    island(s, at(9, 10, 30), { ...defaults, rhythm: { ...defaults.rhythm, workMinutes: minutes } })
      .open.left.at(-1);
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

test("没有小类时是时钟图标", () => {
  const d = day();
  d.focus(at(9, 0), "work", { app: "Code", category: code });
  d.start(at(9, 0));
  // 看不到的窗口没有应用、没有小类，计时照走
  const s = d.focus(at(9, 5), "work");
  assert.deepEqual(island(s, at(9, 6)).closed.left, { type: "icon", name: "Clock" });
});

test("每种语言的字都在岛的上限里", () => {
  const d = day();
  d.focus(at(9, 0), "slack", { app: "Code", category: code });
  d.start(at(9, 0));
  // 最宽的目标：做了 23:59，目标 24:00；分心次数三位数
  const goals = [{ target: { type: "super", id: "work" }, rule: "atLeast", minutes: 24 * 60 }];
  const items = [{ id: "code", seconds: (24 * 60 - 1) * 60, superCategory: { id: "work" } }];
  const joined = (text) => text.text.map((r) => r.text).join("");
  const idle = day().tick(at(9, 0));
  for (const s of [idle, d.tick(at(9, 1)), d.tick(at(9, 7)), d.pause(at(9, 8)), waiting()]) {
    s.distractions = 999;
    for (const lang of I.LOCALES) {
      const c = F.content(s, { ...defaults, goals }, at(9, 9), lang, items);
      // 还没开始时没有分心那一行
      for (const text of [c.open.topRight, c.open.bottomRight].filter(Boolean)) {
        assert.ok(F.width(joined(text)) <= 20, `${lang} ${s.phase} ${joined(text)}`);
        assert.ok(text.text.every((r) => r.text !== ""), `${lang} 有空的一段`);
      }
      // 大字最多 8，后面的小字最多 14
      const target = c.open.left[0];
      assert.equal(target.size, "large");
      assert.ok(F.width(joined(target)) <= 8 && F.width(target.sub) <= 14, joined(target));
    }
  }
});

test("右上角的阶段名每种语言都不超过 12 宽：再长岛就会变宽", () => {
  for (const lang of I.LOCALES) {
    for (const phase of ["idle", "working", "slacking", "paused", "resting", "waiting"]) {
      const name = I.text(lang).islandPhase[phase];
      assert.ok(name && F.width(name) <= 12, `${lang} ${phase} ${name}`);
    }
  }
});

test("岛上放不放：默认不放；开了「最小化到灵动岛」，窗口最小化或者关着，没点「退出」才放", () => {
  assert.equal(defaults.minimizeToIsland, false);
  for (const window of ["open", "minimized", "closed"]) assert.equal(F.wanted(defaults, window, false), false);
  const on = { ...defaults, minimizeToIsland: true };
  assert.equal(F.wanted(on, "open", false), false);
  assert.equal(F.wanted(on, "minimized", false), true);
  assert.equal(F.wanted(on, "closed", false), true);
  assert.equal(F.wanted(on, "minimized", true), false);
  assert.equal(F.wanted(on, "closed", true), false);
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
