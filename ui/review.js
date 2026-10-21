// The Review tab: this month's calendar of the daily goals. A met day is green with a tick, a
// missed day is violet, deeper the closer it came. The goals of the settings count for every
// day, as Hindsight keeps no older goals.
(() => {
  const C = FocusCore;
  const I = FocusI18n;
  // Monday first, as on the Settings page
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const $ = (id) => document.getElementById(id);

  let lang = I.locale();
  let T = I.text(lang);
  let settings = null;
  // From main.js: the name of a goal's target, and its icon tile or dot
  let nameOf = (target) => target.id;
  let markOf = () => null;

  // The statistics of each day, by date. A past day does not change, so only today is read again
  const days = new Map();
  let loaded = false;
  let loading = null;
  let failed = null;
  let selected = null;

  /** Makes an element, as in main.js */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== false && value != null) node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child != null) node.append(child);
    }
    return node;
  }

  function tick() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "icon tick");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M20 6 9 17l-5-5");
    svg.append(path);
    return svg;
  }

  /** Noon of each day of this month, so that a change of summer time never moves a day */
  function monthDays(now) {
    const d = new Date(now);
    const count = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return Array.from({ length: count }, (_, i) => new Date(d.getFullYear(), d.getMonth(), i + 1, 12).getTime());
  }

  /** A day of the calendar. `state`: offday, future, pending (not read yet), none (no goals),
   * met or missed */
  function dayOf(ms, today) {
    const date = C.localDate(ms);
    if (!C.isWorkday(settings, ms)) return { date, ms, state: "offday" };
    if (date > today) return { date, ms, state: "future" };
    const items = days.get(date);
    if (!items) return { date, ms, state: "pending" };
    const result = C.dayResult(settings.goals, items);
    if (!result) return { date, ms, state: "none" };
    return { date, ms, state: result.met ? "met" : "missed", result };
  }

  const percent = (rate) => Math.round(rate * 100);
  // How much violet a missed day gets. From DEEP up, its text is light, as on the accent itself
  const shade = (rate) => `--shade: ${12 + Math.round(rate * 88)}%`;
  const DEEP = 0.83;
  const dateLabel = (ms) => new Intl.DateTimeFormat(lang, { month: "long", day: "numeric", weekday: "short" }).format(ms);

  function cell(day, today) {
    const R = T.review;
    const number = String(new Date(day.ms).getDate());
    const isToday = day.date === today ? " today" : "";
    if (!day.result) {
      return el(
        "span",
        { class: `date ${day.state}${isToday}`, title: day.state === "offday" ? R.offday : null },
        number,
      );
    }
    const { rate, met } = day.result;
    return el(
      "button",
      {
        type: "button",
        class: `date ${day.state}${!met && rate >= DEEP ? " deep" : ""}${isToday}`,
        style: met ? null : shade(rate),
        "aria-pressed": String(day.date === selected),
        "aria-label": `${dateLabel(day.ms)}, ${met ? R.met : I.format(R.rate, { rate: percent(rate) })}`,
        "data-date": day.date,
        onclick: () => {
          selected = day.date;
          render();
        },
      },
      el("span", {}, number),
      met ? tick() : el("span", { class: "date-rate" }, `${percent(rate)}%`),
    );
  }

  function legend() {
    const R = T.review;
    return [
      el("span", {}, R.missed),
      ...[0, 0.33, 0.66, 0.99].map((rate) => el("span", { class: "swatch", style: shade(rate) })),
      el("span", { class: "swatch met" }, tick()),
      el("span", {}, R.met),
    ];
  }

  /** One goal of the selected day: what it asked, what the day had, and how far it was */
  function goalRow({ goal, seconds, met }) {
    const R = T.review;
    const limit = goal.minutes * 60;
    const gap = C.formatMinutes(Math.max(1, Math.ceil(Math.abs(limit - seconds) / 60)), lang);
    const status = met
      ? el("span", { class: "status done" }, R.met)
      : goal.rule === "atLeast"
        ? el("span", { class: "status kind-neutral" }, I.format(R.short, { time: gap }))
        : el("span", { class: "status over" }, I.format(R.over, { time: gap }));
    const rule = I.format(goal.rule === "atLeast" ? T.goals.atLeast : T.goals.atMost, {
      time: C.formatMinutes(goal.minutes, lang),
    });
    return el(
      "div",
      { class: "row goal-line" },
      markOf(goal.target),
      el(
        "div",
        { class: "text" },
        el("span", { class: "label goal-name" }, nameOf(goal.target)),
        el("span", { class: "description" }, rule),
      ),
      el(
        "div",
        { class: "goal-side" },
        status,
        el("span", { class: "goal-value" }, C.formatMinutes(Math.floor(seconds / 60), lang)),
      ),
    );
  }

  function renderDetail(day) {
    const box = $("day-detail");
    box.hidden = !day;
    if (!day) return;
    const R = T.review;
    const { rate, met } = day.result;
    box.replaceChildren(
      el(
        "div",
        { class: "row detail-head" },
        el("span", { class: "label" }, dateLabel(day.ms)),
        el("span", { class: met ? "status done" : "status kind-neutral" }, met ? R.met : I.format(R.rate, { rate: percent(rate) })),
      ),
      ...day.result.goals.map(goalRow),
    );
  }

  function renderMessage() {
    const R = T.review;
    const box = $("review-message");
    const text = failed
      ? I.format(R.loadError, { message: failed.message ?? String(failed) })
      : settings.goals.length === 0 ? T.goals.empty
        : !loaded ? R.loading : null;
    box.hidden = !text;
    box.textContent = text ?? "";
    box.dataset.state = failed ? "error" : "";
    $("review-retry").hidden = !failed;
  }

  function render() {
    if (!settings) return;
    const R = T.review;
    const now = Date.now();
    const today = C.localDate(now);
    const list = monthDays(now).map((ms) => dayOf(ms, today));
    const scored = list.filter((day) => day.result);

    $("month-title").textContent = new Intl.DateTimeFormat(lang, { year: "numeric", month: "long" }).format(now);
    $("month-summary").textContent = scored.length === 0 ? "" : [
      I.format(R.summary, { done: scored.filter((day) => day.result.met).length, total: scored.length }),
      I.format(R.average, { rate: percent(scored.reduce((sum, day) => sum + day.result.rate, 0) / scored.length) }),
    ].join(" · ");
    $("month-weekdays").replaceChildren(...WEEK_ORDER.map((d) => el("span", {}, T.weekdays[d])));

    // Today, or the last day with a result, until a day is chosen
    if (!scored.some((day) => day.date === selected)) {
      selected = (scored.find((day) => day.date === today) ?? scored.at(-1))?.date ?? null;
    }
    // The calendar is made again each minute: keep the keyboard on the same day
    const focused = document.activeElement?.dataset?.date;
    const blanks = (new Date(list[0].ms).getDay() + 6) % 7;
    $("month-grid").replaceChildren(
      ...Array.from({ length: blanks }, () => el("span", { class: "date blank" })),
      ...list.map((day) => cell(day, today)),
    );
    if (focused) $("month-grid").querySelector(`[data-date="${focused}"]`)?.focus();
    $("month-legend").replaceChildren(...(scored.length ? legend() : []));

    renderMessage();
    renderDetail(scored.find((day) => day.date === selected) ?? null);
  }

  /** Reads the workdays of this month that are not read yet, and today again */
  function refresh() {
    if (!settings) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
      const now = Date.now();
      const today = C.localDate(now);
      const dates = monthDays(now)
        .filter((ms) => C.isWorkday(settings, ms))
        .map(C.localDate)
        .filter((date) => date === today || (date < today && !days.has(date)));
      // Each day on its own: without stats.month, today still shows
      const results = await Promise.allSettled(dates.map((date) => hindsight.call("stats.day_by_category", { date })));
      results.forEach((result, i) => {
        if (result.status === "fulfilled") days.set(dates[i], result.value);
      });
      failed = results.find((result) => result.status === "rejected")?.reason ?? null;
      if (failed) console.error(failed);
      loaded = true;
      loading = null;
      render();
    })();
    return loading;
  }

  const isOpen = () => !$("view-history").hidden;

  function setLanguage(value) {
    lang = value;
    T = I.text(lang);
    $("month-grid").setAttribute("aria-label", T.review.title);
    $("review-retry").textContent = T.review.retry;
    render();
  }

  /** The settings, after each change. `helpers`: nameOf(target), and markOf(target) for its
   * icon tile or dot */
  function setGoals(value, helpers) {
    settings = value;
    ({ nameOf, markOf } = helpers);
    render();
    if (isOpen()) refresh();
  }

  function init() {
    $("review-retry").addEventListener("click", refresh);
    setLanguage(lang);
    setInterval(() => {
      if (isOpen()) refresh();
    }, 60 * 1000);
  }

  globalThis.FocusReview = { init, setLanguage, setGoals, open: refresh };
})();
