// 专注插件放在 Hindsight 岛上的内容：本段或者休息的计时器。只从状态、设置和今天的统计算出来，
// 后台脚本、页面和测试算出的内容一样。要先加载 i18n.js 和 core.js。
(() => {
  const C = globalThis.FocusCore;
  const I = globalThis.FocusI18n;

  // 轨迹里没有分类颜色的格子用的颜色，和页面深色主题里的一样
  const COLORS = { work: "#a092fb", slack: "#ee939c", neutral: "#918d9f" };
  // 计时器在走是绿的，停着是灰的
  const RUNNING = "#34d399";
  const STOPPED = "#918d9f";
  // 岛上小字最多 20 宽，见 Hindsight 的 docs/design/plugins/island.md
  const SMALL = 20;
  // 每行最多 20 格，最多 3 行
  const MAX_CELLS = 60;
  // 和页面的轨迹一样，一行 15 格
  const ROW = 15;
  const SHOWN = ["working", "slacking", "paused", "resting"];
  // 岛不收的字：控制字符（和 Rust 的 char::is_control 一样）和换行
  const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

  /** 岛算的宽度：ASCII 算 1，别的算 2。岛对一部分非 ASCII 字只算 1，所以这里只会算多 */
  const width = (text) => [...text].reduce((n, c) => n + (c.codePointAt(0) < 0x80 ? 1 : 2), 0);

  /** 去掉岛不收的字，再截到最多 `max` 宽，截了的末尾是「…」 */
  function fit(text, max) {
    const clean = String(text ?? "").replace(UNSAFE, "");
    if (width(clean) <= max) return clean;
    let out = "";
    for (const c of clean) {
      if (width(out + c) + width("…") > max) break;
      out += c;
    }
    return `${out}…`;
  }

  /** 分类的图标名，岛不收的返回 null */
  function iconName(value) {
    if (typeof value !== "string" || value === "" || value.replace(UNSAFE, "") !== value) {
      return null;
    }
    // UTF-8 的字节数
    const bytes = [...value].reduce((n, c) => {
      const p = c.codePointAt(0);
      return n + (p < 0x80 ? 1 : p < 0x800 ? 2 : p < 0x10000 ? 3 : 4);
    }, 0);
    return bytes <= 64 ? value : null;
  }

  const iso = (ms) => new Date(ms).toISOString();

  /** 计时器：本段还剩多少，休息时是休息还剩多少 */
  function timer(s, rhythm) {
    if (s.phase === "resting") {
      const start = s.phaseSince;
      const end = start + rhythm.restMinutes * C.MINUTE;
      return { type: "timer", start: iso(start), end: iso(end), color: RUNNING };
    }
    const total = rhythm.workMinutes * C.MINUTE;
    const done = Math.min(s.blockMs, total);
    if (s.runningSince !== null) {
      const start = s.runningSince - done;
      return { type: "timer", start: iso(start), end: iso(start + total), color: RUNNING };
    }
    // 停在最后一次计时停下的那一刻：停着的时候内容不变，不用每次都重画
    const last = s.segments.at(-1);
    const stopped = last ? last.start + last.ms : s.phaseSince;
    const start = stopped - done;
    return {
      type: "timer",
      start: iso(start),
      end: iso(start + total),
      pausedAt: iso(stopped),
      color: STOPPED,
    };
  }

  /** 本段的轨迹，一格一种颜色。本段超过 60 分钟时一格是几分钟 */
  function cells(s, rhythm, now) {
    const minutes = rhythm.workMinutes;
    const t = C.trail(s, now, minutes, Math.ceil(minutes / MAX_CELLS));
    const colors = t.cells.map((cell) => cell && (cell.color ?? COLORS[cell.kind] ?? COLORS.neutral));
    return {
      type: "cells",
      colors,
      columns: colors.length > 3 * ROW ? MAX_CELLS / 3 : ROW,
      current: t.current >= 0 && t.current < colors.length ? t.current : null,
    };
  }

  /** 90 分钟 → "1:30" */
  const clock = (minutes) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;

  /** 第一个「至少」目标今天到了多少，比如「今日目标 2:40/6:00」。没有这种目标、还没拿到统计时
   * 返回 null */
  function goal(settings, items, T) {
    const g = settings.goals.find((g) => g.rule === "atLeast");
    if (!g || !items) return null;
    const done = clock(Math.floor(C.totalSeconds(items, g.target) / 60));
    const total = `/${clock(g.minutes)}`;
    const label = fit(T.islandGoal, SMALL - width(done + total) - 1);
    return {
      type: "text",
      text: [{ text: `${label} ` }, { text: done, bold: true }, { text: total, dim: true }],
    };
  }

  /** 「分心 3 次」，次数用摸鱼的颜色加粗 */
  function distractions(s, T) {
    const [before, after] = T.islandDistractions.split("{n}");
    const n = { text: String(s.distractions), color: COLORS.slack, bold: true };
    // 岛不收空字
    const text = [{ text: before }, n, { text: after }].filter((run) => run.text !== "");
    return { type: "text", text };
  }

  /** `state` 在 `now` 时岛上放什么；不放东西时返回 null：还没开始、等下一段、不是工作日。
   * `state` 是 FocusCore.step 算出的今天的状态，`items` 是今天的 stats.day_by_category，还没拿到
   * 是 null */
  function content(state, settings, now, lang, items = null) {
    const s = state;
    if (!s || !SHOWN.includes(s.phase)) return null;
    const T = I.text(lang);
    const { rhythm } = settings;

    // 图标不给颜色：岛把它画成白的。没有小类（离开了、看不到的窗口）时是时钟
    let name = iconName(s.focus.category?.icon) ?? "Clock";
    if (s.phase === "resting") name = "Coffee";
    if (s.phase === "paused") name = "Pause";
    const icon = { type: "icon", name };
    const time = timer(s, rhythm);

    const phase = fit(T.phase[s.phase], SMALL);
    const line = [{ text: phase, bold: true }];
    const room = SMALL - width(phase);
    if (s.phase !== "resting" && s.focus.app && room >= 6) {
      line.push({ text: fit(` · ${s.focus.app}`, room), dim: true });
    }

    const right = [time];
    if (s.phase === "paused") right.push({ type: "button", id: "resume", icon: "Play" });
    else if (s.phase !== "resting") right.push({ type: "button", id: "pause", icon: "Pause" });

    const target = goal(settings, items, T);
    return {
      closed: { left: icon, right: time },
      open: {
        topRight: { type: "text", text: line },
        left: target ? [target, cells(s, rhythm, now)] : [cells(s, rhythm, now)],
        right,
        bottomRight: distractions(s, T),
      },
    };
  }

  globalThis.FocusIsland = { content, fit, width };
})();
