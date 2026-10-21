// core.js 和 i18n.js 的测试。跑法：node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import "../i18n.js";
import "../core.js";

const C = globalThis.FocusCore;
const I = globalThis.FocusI18n;
const MIN = C.MINUTE;

// 2026-10-21 是周三，10-24 是周六
const at = (h, m, day = 21) => new Date(2026, 9, day, h, m).getTime();
const defaults = C.withDefaults(null);
const say = (key, vars = {}) => C.message(key, vars, "zh-CN");
const minutes = (state, t) => C.elapsed(state, t) / MIN;

/** 一天里按时间顺序喂给规则。focus 的第三个参数是事件到达的时间，默认就是发生的时间 */
function day(settings = defaults) {
  let state = null;
  const notes = [];
  const feed = (time, input) => {
    const r = C.step(state, settings, input, time, "zh-CN");
    state = r.state;
    notes.push(...r.notes);
    return state;
  };
  return {
    notes,
    start: (t) => feed(t, { type: "command", name: "start" }),
    pause: (t) => feed(t, { type: "command", name: "pause" }),
    resume: (t) => feed(t, { type: "command", name: "resume" }),
    tick: (t) => feed(t, { type: "tick" }),
    focus: (t, kind, arrives = t) => feed(arrives, { type: "focus", at: t, kind }),
  };
}

test("日期对得上：10-21 是周三，10-24 是周六", () => {
  assert.equal(new Date(at(9, 0)).getDay(), 3);
  assert.equal(new Date(at(9, 0, 24)).getDay(), 6);
});

test("焦点事件的种类：离开、工作、摸鱼、中性；看不到的窗口算中性；两边都挑了算工作", () => {
  const code = { id: "code", name: "编程", superCategory: { id: "work", name: "工作" } };
  const video = { id: "video", name: "视频", superCategory: { id: "play", name: "娱乐" } };
  const talk = { id: "talk", name: "社交", superCategory: { id: "social", name: "社交" } };
  assert.equal(C.kindOf({ away: true, category: null }, defaults), "away");
  assert.equal(C.kindOf({ away: false, category: code }, defaults), "work");
  assert.equal(C.kindOf({ away: false, category: video }, defaults), "slack");
  assert.equal(C.kindOf({ away: false, category: talk }, defaults), "neutral");
  assert.equal(C.kindOf({ away: false, category: null }, defaults), "neutral");

  const byCategory = C.withDefaults({
    rhythm: { work: [{ type: "category", id: "video" }], slack: [{ type: "super", id: "play" }] },
  });
  assert.equal(C.kindOf({ away: false, category: video }, byCategory), "work");
});

test("满 45 分钟提醒休息；休息满 15 分钟提醒结束；人不在就等着，回到工作才开始下一段", () => {
  const d = day();
  d.focus(at(8, 55), "work");
  assert.equal(d.start(at(9, 0)).phase, "working");
  assert.equal(d.tick(at(9, 44)).phase, "working");
  const resting = d.tick(at(9, 45));
  assert.equal(resting.phase, "resting");
  assert.equal(resting.rounds, 1);

  d.focus(at(9, 46), "away");
  assert.equal(d.tick(at(10, 0)).phase, "waiting");
  const next = d.focus(at(10, 10), "work");
  assert.equal(next.phase, "working");
  assert.equal(minutes(next, at(10, 20)), 10);
  assert.deepEqual(d.notes, [say("rest", { work: 45, rest: 15 }), say("restOver")]);
});

test("休息结束时人已经在工作分类里：下一段从休息结束那一刻开始", () => {
  const d = day();
  d.focus(at(8, 55), "work");
  d.start(at(9, 0));
  d.tick(at(9, 45));
  const next = d.tick(at(10, 0));
  assert.equal(next.phase, "working");
  assert.equal(minutes(next, at(10, 30)), 30);
});

test("摸鱼满 5 分钟：提醒、暂停，这 5 分钟扣掉；回到工作接着计时", () => {
  const d = day();
  d.focus(at(8, 55), "work");
  d.start(at(9, 0));
  d.focus(at(9, 10), "slack");
  const still = d.tick(at(9, 14));
  assert.equal(still.phase, "working");
  assert.equal(minutes(still, at(9, 14)), 14);

  const slacking = d.tick(at(9, 15));
  assert.equal(slacking.phase, "slacking");
  assert.equal(minutes(slacking, at(9, 15)), 10);
  assert.equal(minutes(d.tick(at(9, 19)), at(9, 19)), 10);

  d.focus(at(9, 20), "work");
  assert.equal(d.tick(at(9, 54)).phase, "working");
  assert.equal(d.tick(at(9, 55)).phase, "resting");
  assert.deepEqual(d.notes, [say("slack", { minutes: 5 }), say("rest", { work: 45, rest: 15 })]);
});

test("摸鱼不满 5 分钟就回来：照算工作时间，不提醒", () => {
  const d = day();
  d.focus(at(8, 55), "work");
  d.start(at(9, 0));
  d.focus(at(9, 10), "slack");
  d.focus(at(9, 13), "work");
  assert.equal(d.tick(at(9, 45)).phase, "resting");
  assert.deepEqual(d.notes, [say("rest", { work: 45, rest: 15 })]);
});

test("从一个摸鱼应用切到另一个，还是同一段摸鱼", () => {
  const d = day();
  d.focus(at(8, 55), "work");
  d.start(at(9, 0));
  d.focus(at(9, 10), "slack");
  d.focus(at(9, 13), "slack");
  assert.equal(d.tick(at(9, 15)).phase, "slacking");
});

test("手动暂停：计时停住，切到工作也不会自己继续；点继续才接着走", () => {
  const d = day();
  d.focus(at(8, 55), "work");
  d.start(at(9, 0));
  assert.equal(d.pause(at(9, 10)).phase, "paused");
  d.focus(at(9, 15), "slack");
  d.focus(at(9, 20), "work");
  const paused = d.tick(at(9, 30));
  assert.equal(paused.phase, "paused");
  assert.equal(minutes(paused, at(9, 30)), 10);

  assert.equal(d.resume(at(9, 30)).phase, "working");
  assert.equal(d.tick(at(10, 4)).phase, "working");
  assert.equal(d.tick(at(10, 5)).phase, "resting");
});

test("离开不满 15 分钟：从离开那一刻起不计时，回来接着走；离开事件晚到也按离开的时刻算", () => {
  const d = day();
  d.focus(at(8, 55), "work");
  d.start(at(9, 0));
  const away = d.focus(at(9, 10), "away", at(9, 13));
  assert.equal(minutes(away, at(9, 13)), 10);

  const back = d.focus(at(9, 20), "work");
  assert.equal(back.phase, "working");
  assert.equal(minutes(back, at(9, 20)), 10);
  assert.equal(d.tick(at(9, 55)).phase, "resting");
});

test("离开满 15 分钟算休息过了：计时清零，等回到工作再开始下一段", () => {
  const d = day();
  d.focus(at(8, 55), "work");
  d.start(at(9, 0));
  d.focus(at(9, 10), "away", at(9, 13));
  const waiting = d.tick(at(9, 26));
  assert.equal(waiting.phase, "waiting");
  assert.equal(waiting.blockMs, 0);

  d.focus(at(9, 30), "work");
  assert.equal(d.tick(at(10, 14)).phase, "working");
  assert.equal(d.tick(at(10, 15)).phase, "resting");
  assert.deepEqual(d.notes, [say("rest", { work: 45, rest: 15 })]);
});

test("中性分类：设成暂停时不计时，设成照走时照算", () => {
  const sequence = (settings) => {
    const d = day(settings);
    d.focus(at(8, 55), "work");
    d.start(at(9, 0));
    d.focus(at(9, 10), "neutral");
    d.focus(at(9, 20), "work");
    return d;
  };
  const paused = sequence(C.withDefaults({ rhythm: { neutral: "pause" } }));
  assert.equal(paused.tick(at(9, 54)).phase, "working");
  assert.equal(paused.tick(at(9, 55)).phase, "resting");

  const kept = sequence(defaults);
  assert.equal(kept.tick(at(9, 45)).phase, "resting");
});

test("非工作日点开始没反应", () => {
  const d = day();
  d.focus(at(8, 55, 24), "work");
  assert.equal(d.start(at(9, 0, 24)).phase, "idle");
  assert.equal(d.tick(at(10, 0, 24)).phase, "idle");
});

test("过了 0 点回到未开始，最后的焦点留着", () => {
  const d = day();
  d.focus(at(23, 30), "work");
  d.start(at(23, 40));
  const next = d.tick(at(0, 5, 22));
  assert.equal(next.phase, "idle");
  assert.equal(next.date, "2026-10-22");
  assert.equal(next.focus.kind, "work");
});

test("事件来之前没跑过定时检查：先按事件的时刻补上，补出来的提醒不发", () => {
  const d = day();
  d.focus(at(8, 55), "work");
  d.start(at(9, 0));
  d.focus(at(9, 10), "slack");
  const back = d.focus(at(9, 20), "work");
  assert.equal(back.phase, "working");
  assert.equal(minutes(back, at(9, 20)), 10);
  assert.deepEqual(d.notes, []);
});

test("目标：至少的达到时提醒一次；至多的剩 15 分钟一次、超过一次；非工作日不提醒", () => {
  const items = (workMinutes, playMinutes) => [
    { id: "code", name: "编程", seconds: workMinutes * 60, superCategory: { id: "work", name: "工作" } },
    { id: "video", name: "视频", seconds: playMinutes * 60, superCategory: { id: "play", name: "娱乐" } },
  ];
  let state = null;
  const check = (work, play, t = at(18, 0)) => {
    const r = C.checkGoals(state, defaults, items(work, play), t, "zh-CN");
    state = r.state;
    return r.notes;
  };

  assert.deepEqual(check(300, 100), []);
  assert.deepEqual(check(300, 105), ["今天「娱乐」再过 15 分钟就到 2 小时的上限了。"]);
  assert.deepEqual(check(300, 110), []);
  assert.deepEqual(check(360, 110), ["今天「工作」满 6 小时了，目标完成。"]);
  assert.deepEqual(check(400, 120), ["今天「娱乐」超过 2 小时了。"]);
  assert.deepEqual(check(500, 200), []);

  state = null;
  assert.deepEqual(check(400, 200, at(18, 0, 24)), []);
});

test("目标挑的是分类时，按分类名提醒", () => {
  const settings = C.withDefaults({
    goals: [{ target: { type: "category", id: "code" }, rule: "atLeast", minutes: 240 }],
  });
  const items = [
    { id: "code", name: "编程", seconds: 240 * 60, superCategory: { id: "work", name: "工作" } },
  ];
  const { notes } = C.checkGoals(null, settings, items, at(15, 0), "zh-CN");
  assert.deepEqual(notes, ["今天「编程」满 4 小时了，目标完成。"]);
});

test("时长的写法", () => {
  assert.equal(C.formatMinutes(90, "zh-CN"), "1 小时 30 分钟");
  assert.equal(C.formatMinutes(120, "zh-CN"), "2 小时");
  assert.equal(C.formatMinutes(45, "zh-CN"), "45 分钟");
  assert.equal(C.formatMinutes(90, "en"), "1 h 30 min");
  assert.equal(C.formatMinutes(90, "ja"), "1時間30分");
});

test("按系统语言挑语言，规则和主界面没选过语言时一样；认不出的用英文", () => {
  const cases = [
    ["zh-CN", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-Hant-TW", "zh-TW"],
    ["ja-JP", "ja"],
    ["pt-PT", "pt-BR"],
    ["es-MX", "es"],
    ["en-US", "en"],
    ["fr-FR", "en"],
    [undefined, "en"],
  ];
  for (const [tag, expected] of cases) assert.equal(I.locale(tag), expected, String(tag));
  assert.deepEqual([...I.LOCALES].sort(), ["en", "es", "ja", "pt-BR", "zh-CN", "zh-TW"]);
});

test("设置里选了语言就用它；选「跟随系统」、没选过、或者是不认识的值，都用系统语言", () => {
  assert.equal(I.pick("ja"), "ja");
  for (const choice of ["system", undefined, "fr"]) assert.equal(I.pick(choice), I.locale());
  assert.equal(C.withDefaults(null).language, "system");
  // 每种语言在选择器里都有自己的名字
  assert.deepEqual(Object.keys(I.NAMES).sort(), [...I.LOCALES].sort());
});

/** 每个文字的键路径和里面的 {占位}，比如 "notify.rest {rest} {work}" */
function shape(value, path = "") {
  if (typeof value === "string") {
    const vars = [...value.matchAll(/\{(\w+)\}/g)].map((m) => `{${m[1]}}`).sort();
    return [[path, ...vars].join(" ")];
  }
  if (Array.isArray(value)) return [`${path} [${value.length}]`];
  return Object.keys(value)
    .sort()
    .flatMap((key) => shape(value[key], path ? `${path}.${key}` : key));
}

test("六种语言的键一样多，每句的占位也一样：漏翻一句、占位写错都会挂", () => {
  const zh = shape(I.text("zh-CN"));
  for (const lang of I.LOCALES) assert.deepEqual(shape(I.text(lang)), zh, lang);
});

test("进度条的分段：短暂摸鱼留在条上，也算时间；摸鱼满 5 分钟，这一轮从条上去掉", () => {
  const d = day();
  const parts = (state) => state.segments.map((g) => [g.kind, g.ms / MIN]);
  d.focus(at(8, 59), "work");
  d.start(at(9, 0));
  d.focus(at(9, 10), "slack");
  d.focus(at(9, 13), "work");
  let s = d.tick(at(9, 20));
  assert.deepEqual(parts(s), [["work", 10], ["slack", 3]]);
  assert.equal(s.runKind, "work");
  assert.equal(minutes(s, at(9, 20)), 20);

  // 换一个摸鱼应用还是同一轮，满 5 分钟时两段一起去掉
  d.focus(at(9, 20), "slack");
  d.focus(at(9, 22), "slack");
  s = d.tick(at(9, 25));
  assert.equal(s.phase, "slacking");
  assert.deepEqual(parts(s), [["work", 10], ["slack", 3], ["work", 7]]);
  assert.equal(minutes(s, at(9, 25)), 20);
});

test("进度条的每一段记下当时分类的颜色；颜色不同就分成两段", () => {
  const social = { name: "社交", superName: "社交", color: "#34d399" };
  const code = { name: "编程", superName: "工作", color: "#8b5cf6" };
  let state = null;
  const focus = (t, kind, category) =>
    C.step(state, defaults, { type: "focus", at: t, kind, category }, t, "zh-CN").state;
  state = focus(at(8, 59), "work", code);
  state = C.step(state, defaults, { type: "command", name: "start" }, at(9, 0), "zh-CN").state;
  state = focus(at(9, 10), "neutral", social);
  state = focus(at(9, 12), "work", code);
  const s = C.step(state, defaults, { type: "tick" }, at(9, 15), "zh-CN").state;
  // 名字和页面上的标签一样：有大类写大类，没有写分类
  assert.deepEqual(
    s.segments.map((g) => [g.kind, g.color, g.name, g.ms / MIN]),
    [
      ["work", "#8b5cf6", "工作", 10],
      ["neutral", "#34d399", "社交", 2],
    ],
  );
  assert.equal(s.runColor, "#8b5cf6");
  assert.equal(s.runName, "工作");
});

test("只认 #rrggbb 的颜色：别的写法会进到 CSS 里，一律不要", () => {
  assert.equal(C.safeColor("#34D399"), "#34D399");
  for (const bad of ["red", "#fff", "#34d399;background:url(x)", "", null, undefined, 123]) {
    assert.equal(C.safeColor(bad), null, String(bad));
  }
});

test("焦点事件记下应用名和分类给页面显示；收到第一个事件前算「还不知道」", () => {
  let state = C.step(null, defaults, { type: "tick" }, at(9, 0), "zh-CN").state;
  assert.equal(state.focus.seen, false);

  const category = { name: "游戏", superName: "娱乐" };
  const input = { type: "focus", at: at(9, 1), kind: "slack", app: "Steam", category };
  state = C.step(state, defaults, input, at(9, 1), "zh-CN").state;
  assert.deepEqual(state.focus, { kind: "slack", since: at(9, 1), seen: true, app: "Steam", category });

  // 离开、统计里看不到的窗口：事件里没有应用名和分类
  state = C.step(state, defaults, { type: "focus", at: at(9, 2), kind: "away" }, at(9, 2), "zh-CN").state;
  assert.deepEqual(state.focus, { kind: "away", since: at(9, 2), seen: true, app: null, category: null });
});

// 「至少」按做到的比例算；「至多」没到上限算满分，超了往下掉，到两倍上限是 0
test("一个目标的达成度", () => {
  const atLeast = { target: { type: "super", id: "work" }, rule: "atLeast", minutes: 360 };
  const atMost = { target: { type: "super", id: "play" }, rule: "atMost", minutes: 120 };
  assert.deepEqual(C.goalRate(atLeast, 180 * 60), { rate: 0.5, met: false });
  assert.deepEqual(C.goalRate(atLeast, 400 * 60), { rate: 1, met: true });
  assert.deepEqual(C.goalRate(atMost, 60 * 60), { rate: 1, met: true });
  assert.deepEqual(C.goalRate(atMost, 180 * 60), { rate: 0.5, met: false });
  assert.deepEqual(C.goalRate(atMost, 300 * 60), { rate: 0, met: false });
  // 刚好到上限算超出，和提醒一致；达成度也不到 1
  assert.deepEqual(C.goalRate(atMost, 120 * 60), { rate: 0.99, met: false });
});

// 一天的达成率是各目标的平均；全部达成才算这天达成；没有目标就没有结果
test("一天的目标结果", () => {
  const goals = defaults.goals; // 工作至少 6 小时，娱乐至多 2 小时
  const items = (work, play) => [
    { id: "code", name: "编程", seconds: work * 60, superCategory: { id: "work", name: "工作" } },
    { id: "video", name: "视频", seconds: play * 60, superCategory: { id: "play", name: "娱乐" } },
  ];
  const half = C.dayResult(goals, items(180, 30));
  assert.equal(half.rate, 0.75);
  assert.equal(half.met, false);
  assert.deepEqual(half.goals.map((g) => g.seconds), [180 * 60, 30 * 60]);
  assert.equal(C.dayResult(goals, items(360, 30)).met, true);
  assert.equal(C.dayResult([], items(360, 30)), null);
});

test("改返回的设置不会改到默认值", () => {
  const s = C.withDefaults(null);
  s.workdays.push(6);
  s.rhythm.work.push({ type: "category", id: "x" });
  assert.deepEqual(C.withDefaults(null).workdays, [1, 2, 3, 4, 5]);
  assert.equal(C.withDefaults(null).rhythm.work.length, 1);
});
