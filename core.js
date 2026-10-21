// The rules of the Focus plugin: the daily goals and the work rhythm. Nothing here calls
// Hindsight, so the background script, the page and the tests all use the same rules. Needs
// i18n.js loaded first.
(() => {
  const I18n = globalThis.FocusI18n;
  const MINUTE = 60 * 1000;

  /** Settings for a new install. A target is a category or a super-category, by id */
  const DEFAULT_SETTINGS = {
    // "system", or one of FocusI18n.LOCALES
    language: "system",
    // 页面的深浅色："system" 跟随系统，或者 "light"、"dark"
    appearance: "system",
    // Days of the week as in Date.getDay(): 0 is Sunday
    workdays: [1, 2, 3, 4, 5],
    goals: [
      { target: { type: "super", id: "work" }, rule: "atLeast", minutes: 360 },
      { target: { type: "super", id: "play" }, rule: "atMost", minutes: 120 },
    ],
    rhythm: {
      workMinutes: 45,
      restMinutes: 15,
      slackMinutes: 5,
      work: [{ type: "super", id: "work" }],
      slack: [{ type: "super", id: "play" }],
      // In a category that is neither work nor slacking, the timer goes on ("keep") or stops
      // ("pause")
      neutral: "keep",
    },
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));

  /** Fills in what saved settings lack, such as a field added by a newer version */
  function withDefaults(saved) {
    const s = saved ?? {};
    return clone({
      ...DEFAULT_SETTINGS,
      ...s,
      rhythm: { ...DEFAULT_SETTINGS.rhythm, ...(s.rhythm ?? {}) },
    });
  }

  /** The local date of `ms`, as "YYYY-MM-DD" */
  function localDate(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function isWorkday(settings, ms) {
    return settings.workdays.includes(new Date(ms).getDay());
  }

  /** Whether a category, from a focus event or from the statistics, is one of `targets` */
  function matches(targets, category) {
    if (!category) return false;
    return targets.some((t) =>
      t.type === "category" ? t.id === category.id : t.id === category.superCategory?.id,
    );
  }

  /** What a focus.changed event is for the rhythm: "work", "slack", "neutral" or "away". A window
   * that the statistics do not show comes without a category, so it is neutral */
  function kindOf(event, settings) {
    if (event.away) return "away";
    if (matches(settings.rhythm.work, event.category)) return "work";
    if (matches(settings.rhythm.slack, event.category)) return "slack";
    return "neutral";
  }

  /** The state at the start of a day. `focus` is the last focus seen: it is still in front */
  function newDay(now, focus) {
    return {
      date: localDate(now),
      // "idle", "working", "paused", "slacking", "resting" or "waiting"
      phase: "idle",
      // Work time in this block, counted up to `runningSince`
      blockMs: 0,
      // What the counted time in this block was spent on, for the progress bar: { kind, color,
      // name, start, ms }, oldest first. Their ms add up to blockMs
      segments: [],
      // When the timer last started; null while it is stopped
      runningSince: null,
      // The focus kind since runningSince, and the color and name of its category
      runKind: null,
      runColor: null,
      runName: null,
      // When the current stretch of slacking began; null when not slacking
      slackSince: null,
      phaseSince: now,
      // Blocks finished today
      rounds: 0,
      // 今天计时中开始了几段摸鱼，见 slackOn
      distractions: 0,
      // `seen` stays false until the first focus event: the page then says it does not know yet
      focus: focus ?? { kind: "neutral", since: now, seen: false },
      // The goal notifications already sent today
      notified: {},
    };
  }

  /** Today's state: a state from an earlier day starts over */
  function today(state, now) {
    if (!state || state.date !== localDate(now)) return newDay(now, state?.focus);
    const s = clone(state);
    // Saved by version 0.1.3 or earlier, which kept no segments
    s.segments ??= [];
    s.runKind ??= s.runningSince === null ? null : s.focus.kind;
    s.runColor ??= null;
    s.runName ??= null;
    // 0.1.25 及以前存的没有
    s.distractions ??= 0;
    return s;
  }

  /** `value` if it is a color as Hindsight gives it, "#rrggbb"; otherwise null. The page puts it
   * into CSS, so nothing else may get through */
  function safeColor(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
  }

  const runs = (kind, rhythm) =>
    kind === "work" || kind === "slack" || (kind === "neutral" && rhythm.neutral === "keep");

  /** The work time in this block at `now` */
  function elapsed(state, now) {
    const running = state.runningSince === null ? 0 : Math.max(0, now - state.runningSince);
    return state.blockMs + running;
  }

  /** What [from, to) of the block went to most, and when that was on the clock. null if the
   * block has not got there yet */
  function topOf(pieces, from, to) {
    const totals = new Map();
    let start = null;
    let end = null;
    for (const g of pieces) {
      const a = Math.max(g.from, from);
      const b = Math.min(g.to, to);
      if (b <= a) continue;
      start ??= g.start + (a - g.from);
      end = g.start + (b - g.from);
      const key = `${g.kind}:${g.color}:${g.name}`;
      const entry = totals.get(key) ?? { kind: g.kind, name: g.name, color: safeColor(g.color), ms: 0 };
      entry.ms += b - a;
      totals.set(key, entry);
    }
    let top = null;
    for (const entry of totals.values()) if (!top || entry.ms > top.ms) top = entry;
    return top && { ...top, start, end };
  }

  /** 本段的轨迹：本段 `minutes` 分钟里每 `step` 分钟一格，每格是那段时间用得最多的（见 topOf），
   * 还没到的是 null。`current` 是计时器正在走的那格，停着时是 -1；`start` 是本段从几点开始，
   * 还没开始是 null。暂停的时间不算在本段里，轨迹里也没有 */
  function trail(view, now, minutes, step = 1) {
    const list = [...view.segments];
    if (view.runningSince !== null) {
      list.push({
        kind: view.runKind,
        color: view.runColor,
        name: view.runName,
        start: view.runningSince,
        ms: now - view.runningSince,
      });
    }
    // Where each piece starts and ends, in ms from the start of the block
    let at = 0;
    const pieces = list.map((g) => {
      const from = at;
      at += Math.max(0, g.ms);
      return { ...g, from, to: at };
    });
    const size = step * MINUTE;
    const cells = [];
    for (let i = 0; i * step < minutes; i++) {
      cells.push(topOf(pieces, i * size, Math.min((i + 1) * size, minutes * MINUTE)));
    }
    const current = view.runningSince !== null ? Math.floor(at / size) : -1;
    return { cells, current, start: pieces[0]?.start ?? null };
  }

  /** 什么都不发生的话，下一个时限几点到：本段做完、摸鱼到时、休息结束、离开够久。null：没有时限
   * 在走 */
  function nextLimit(state, rhythm) {
    const s = state;
    const times = [];
    if (s.phase === "working") {
      if (s.runningSince !== null) {
        times.push(s.runningSince + rhythm.workMinutes * MINUTE - s.blockMs);
      }
      if (s.slackSince !== null) times.push(s.slackSince + rhythm.slackMinutes * MINUTE);
    }
    if ((s.phase === "working" || s.phase === "slacking") && s.focus.kind === "away") {
      times.push(s.focus.since + rhythm.restMinutes * MINUTE);
    }
    if (s.phase === "resting") times.push(s.phaseSince + rhythm.restMinutes * MINUTE);
    return times.length ? Math.min(...times) : null;
  }

  function startAt(s, at) {
    const c = s.focus.category;
    s.runningSince = at;
    s.runKind = s.focus.kind;
    s.runColor = c?.color ?? null;
    // The same name as the page's tag for the focus
    s.runName = c ? (c.superName ?? c.name) : null;
  }

  function clearRun(s) {
    s.runningSince = null;
    s.runKind = null;
    s.runColor = null;
    s.runName = null;
  }

  /** Stops the timer at `at`, and adds the time since it started to the block */
  function stopAt(s, at) {
    if (s.runningSince === null) return;
    const ms = Math.max(0, at - s.runningSince);
    s.blockMs += ms;
    const last = s.segments.at(-1);
    // Joined with the segment before when it goes on from it, so the list stays short
    const goesOn =
      last &&
      last.kind === s.runKind &&
      (last.color ?? null) === s.runColor &&
      (last.name ?? null) === s.runName &&
      last.start + last.ms === s.runningSince;
    if (goesOn) last.ms += ms;
    else if (ms > 0) {
      s.segments.push({
        kind: s.runKind,
        color: s.runColor,
        name: s.runName,
        start: s.runningSince,
        ms,
      });
    }
    clearRun(s);
  }

  /** Stops the timer, and takes the time from `from` on out of the block */
  function dropFrom(s, from) {
    if (s.runningSince !== null && s.runningSince < from) stopAt(s, from);
    clearRun(s);
    const dropped = s.segments.filter((g) => g.start >= from);
    s.segments = s.segments.filter((g) => g.start < from);
    s.blockMs -= dropped.reduce((sum, g) => sum + g.ms, 0);
  }

  function newBlock(s) {
    s.blockMs = 0;
    s.segments = [];
  }

  /** 计时中焦点换成 `kind`：从不摸鱼换到摸鱼，是新的一段摸鱼，分心多一次。从一个摸鱼的应用换到
   * 另一个还是同一段 */
  function slackOn(s, kind, at) {
    if (kind !== "slack") {
      s.slackSince = null;
    } else if (s.slackSince === null) {
      s.slackSince = at;
      s.distractions += 1;
    }
  }

  function work(s, rhythm, at, isNewBlock) {
    s.phase = "working";
    s.phaseSince = at;
    if (isNewBlock) newBlock(s);
    if (runs(s.focus.kind, rhythm)) startAt(s, at);
    slackOn(s, s.focus.kind, at);
  }

  function wait(s, rhythm, at) {
    s.phase = "waiting";
    s.phaseSince = at;
    newBlock(s);
    clearRun(s);
    s.slackSince = null;
    // Already at work when the rest ends: the next block starts now
    if (s.focus.kind === "work") work(s, rhythm, at, true);
  }

  /** Moves on if a time limit has passed by `t`. `say` collects the notifications */
  function checkTime(s, rhythm, t, say) {
    const rest = rhythm.restMinutes * MINUTE;
    const awayForRest = s.focus.kind === "away" && t - s.focus.since >= rest;
    if (s.phase === "working") {
      if (awayForRest) {
        wait(s, rhythm, s.focus.since + rest);
        return;
      }
      if (s.slackSince !== null && t - s.slackSince >= rhythm.slackMinutes * MINUTE) {
        // The slacking time does not count as work
        dropFrom(s, s.slackSince);
        s.slackSince = null;
        s.phase = "slacking";
        s.phaseSince = t;
        say("slack", { minutes: rhythm.slackMinutes });
        return;
      }
      const over = elapsed(s, t) - rhythm.workMinutes * MINUTE;
      if (over >= 0) {
        const doneAt = t - over;
        stopAt(s, doneAt);
        s.slackSince = null;
        s.phase = "resting";
        s.phaseSince = doneAt;
        s.rounds += 1;
        say("rest", { work: rhythm.workMinutes, rest: rhythm.restMinutes });
      }
    } else if (s.phase === "slacking") {
      if (awayForRest) wait(s, rhythm, s.focus.since + rest);
    } else if (s.phase === "resting") {
      if (t - s.phaseSince >= rest) {
        wait(s, rhythm, s.phaseSince + rest);
        say("restOver", {});
      }
    }
  }

  function onFocus(s, rhythm, input) {
    const { at, kind } = input;
    // The rules use only the kind. The app and the category are for the page to show
    s.focus = { kind, since: at, seen: true, app: input.app ?? null, category: input.category ?? null };
    if (s.phase === "working") {
      // A new segment for each focus, so the progress bar shows what the time went to
      stopAt(s, at);
      if (runs(kind, rhythm)) startAt(s, at);
      slackOn(s, kind, at);
    } else if (s.phase === "slacking") {
      if (kind === "work") work(s, rhythm, at, false);
    } else if (s.phase === "waiting") {
      if (kind === "work") work(s, rhythm, at, true);
    }
  }

  function onCommand(s, rhythm, name, now, workday) {
    if (name === "start" && s.phase === "idle" && workday) {
      work(s, rhythm, now, true);
    } else if (name === "pause" && (s.phase === "working" || s.phase === "slacking")) {
      stopAt(s, now);
      s.slackSince = null;
      s.phase = "paused";
      s.phaseSince = now;
    } else if (name === "resume" && s.phase === "paused") {
      work(s, rhythm, now, false);
    }
  }

  /** Applies one input to the state, and returns the new state and the notifications to send.
   * `input` is { type: "focus", at, kind, app, category }, { type: "command", name } or
   * { type: "tick" }. `category` is { name, superName, color } */
  function step(state, settings, input, now, lang) {
    const s = today(state, now);
    const notes = [];
    const say = (key, vars) => notes.push(message(key, vars, lang));
    const { rhythm } = settings;
    if (input.type === "focus") {
      // Catch up first: a limit may have passed before this event while no tick ran. Its
      // notification would come too late, so it is not sent
      checkTime(s, rhythm, input.at, () => {});
      onFocus(s, rhythm, input);
    } else if (input.type === "command") {
      onCommand(s, rhythm, input.name, now, isWorkday(settings, now));
    }
    checkTime(s, rhythm, now, say);
    return { state: s, notes };
  }

  /** The seconds of `target` in the statistics of a day */
  function totalSeconds(items, target) {
    return items
      .filter((item) => matches([target], item))
      .reduce((sum, item) => sum + item.seconds, 0);
  }

  function targetName(items, target) {
    const item = items.find((i) => matches([target], i));
    if (!item) return null;
    return target.type === "category" ? item.name : item.superCategory.name;
  }

  const goalKey = (g) => `${g.target.type}:${g.target.id}:${g.rule}:${g.minutes}`;

  /** Where a goal stands with `seconds` today: "done", "near", "over" or null. "near" is the
   * last 15 minutes before an upper limit */
  function goalLevel(goal, seconds) {
    const limit = goal.minutes * 60;
    if (goal.rule === "atLeast") return seconds >= limit ? "done" : null;
    if (seconds >= limit) return "over";
    if (goal.minutes > 15 && seconds >= limit - 15 * 60) return "near";
    return null;
  }

  /** How far a day got toward a goal, from 0 to 1, and whether it met it. A goal to stay under
   * a limit is at 1 while under it; past it, it goes down to 0 at twice the limit */
  function goalRate(goal, seconds) {
    const limit = goal.minutes * 60;
    if (goal.rule === "atLeast") return { rate: Math.min(1, seconds / limit), met: seconds >= limit };
    if (goalLevel(goal, seconds) !== "over") return { rate: 1, met: true };
    return { rate: Math.min(0.99, Math.max(0, 2 - seconds / limit)), met: false };
  }

  /** How a day did on the goals: each goal, their mean rate, and whether it met them all.
   * `items` is the result of stats.day_by_category for that day. null without goals */
  function dayResult(goals, items) {
    if (goals.length === 0) return null;
    const results = goals.map((goal) => {
      const seconds = totalSeconds(items, goal.target);
      return { goal, seconds, ...goalRate(goal, seconds) };
    });
    return {
      goals: results,
      rate: results.reduce((sum, r) => sum + r.rate, 0) / results.length,
      met: results.every((r) => r.met),
    };
  }

  const GOAL_MESSAGES = { done: "goalDone", near: "goalNear", over: "goalOver" };

  /** The goal notifications due now. Each one goes out once a day, and only on workdays.
   * `items` is the result of stats.day_by_category for today */
  function checkGoals(state, settings, items, now, lang) {
    const s = today(state, now);
    const notes = [];
    if (!isWorkday(settings, now)) return { state: s, notes };
    for (const goal of settings.goals) {
      const name = targetName(items, goal.target);
      if (name === null) continue;
      const level = goalLevel(goal, totalSeconds(items, goal.target));
      if (level === null) continue;
      const id = `${goalKey(goal)}:${level}`;
      if (s.notified[id]) continue;
      s.notified[id] = true;
      const vars = { name, time: formatMinutes(goal.minutes, lang) };
      notes.push(message(GOAL_MESSAGES[level], vars, lang));
    }
    return { state: s, notes };
  }

  function message(key, vars, lang = I18n.locale()) {
    return I18n.format(I18n.text(lang).notify[key], vars);
  }

  /** 90 → "1 小时 30 分钟", "1 h 30 min", "1時間30分" */
  function formatMinutes(minutes, lang = I18n.locale()) {
    const { units } = I18n.text(lang);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const hours = I18n.format(units.hours, { n: h });
    const mins = I18n.format(units.minutes, { n: m });
    if (h && m) return hours + units.join + mins;
    return h ? hours : mins;
  }

  globalThis.FocusCore = {
    MINUTE,
    DEFAULT_SETTINGS,
    withDefaults,
    localDate,
    isWorkday,
    matches,
    kindOf,
    newDay,
    today,
    elapsed,
    trail,
    nextLimit,
    step,
    checkGoals,
    goalLevel,
    goalRate,
    dayResult,
    safeColor,
    totalSeconds,
    message,
    formatMinutes,
  };
})();
