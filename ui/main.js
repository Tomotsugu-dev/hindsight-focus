// The page, in two tabs: "Today" shows the timer and today's goals, "Settings" changes the
// settings. A change in Settings is saved at once, as in Hindsight's own settings.
(() => {
  const C = FocusCore;
  const I = FocusI18n;
  // The system language until the settings are read, see applyLanguage()
  let lang = I.locale();
  let T = I.text(lang);
  let S = T.settings;
  // Monday first, as in most calendars
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

  const $ = (id) => document.getElementById(id);

  let settings = null;
  let state = null;
  // Today's statistics, from stats.day_by_category
  let items = [];
  let categories = [];
  let supers = [];

  /** Makes an element. Text goes in as text nodes, so names from the user are never parsed as
   * HTML. `on…` attributes become event listeners: the page cannot use inline handlers */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, "");
      else if (value !== false && value != null) node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child != null) node.append(child);
    }
    return node;
  }

  // Icons on a 24 × 24 grid. `fill`: filled shapes, otherwise lines
  const ICONS = {
    play: { fill: true, shapes: [["path", { d: "M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" }]] },
    pause: {
      fill: true,
      shapes: [
        ["rect", { x: 6, y: 5, width: 4, height: 14, rx: 1.2 }],
        ["rect", { x: 14, y: 5, width: 4, height: 14, rx: 1.2 }],
      ],
    },
    plus: { fill: false, shapes: [["path", { d: "M12 5v14M5 12h14" }]] },
    x: { fill: false, shapes: [["path", { d: "M7 7l10 10M17 7L7 17" }]] },
  };

  function icon(name) {
    const NS = "http://www.w3.org/2000/svg";
    const { fill, shapes } = ICONS[name];
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", fill ? "icon icon-fill" : "icon");
    for (const [tag, attrs] of shapes) {
      const shape = document.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, String(value));
      svg.append(shape);
    }
    return svg;
  }

  function showError(e, source = "general") {
    console.error(e);
    const box = $("error");
    box.textContent = I.format(T.error, { message: e?.message ?? String(e) });
    box.dataset.source = source;
    box.setAttribute("role", "alert");
    box.hidden = false;
  }

  const clock = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };

  const encode = (target) => `${target.type}:${target.id}`;
  function decode(value) {
    const i = value.indexOf(":");
    return { type: value.slice(0, i), id: value.slice(i + 1) };
  }

  function nameOf(target) {
    const list = target.type === "super" ? supers : categories;
    return list.find((x) => x.id === target.id)?.name ?? target.id;
  }

  /** The color of a target in the main window, or null */
  function colorOf(target) {
    const list = target.type === "super" ? supers : categories;
    return C.safeColor(list.find((x) => x.id === target.id)?.color);
  }

  /** A small dot in a category's color. `color` must have gone through FocusCore.safeColor */
  const dot = (color) => (color ? el("span", { class: "dot colored", style: `--c: ${color}` }) : null);

  /** The Lucide name of a target's icon in the main window, or null if this Hindsight does not
   * give plugins the icons yet */
  function iconOf(target) {
    const list = target.type === "super" ? supers : categories;
    const icon = list.find((x) => x.id === target.id)?.icon;
    return typeof icon === "string" ? icon : null;
  }

  /** An icon on a tile of its category's color, as on Hindsight's Categories page */
  const iconTile = (name, color) =>
    el(
      "span",
      { class: color ? "icon-tile colored" : "icon-tile", style: color ? `--c: ${color}` : null },
      FocusIcons.svg(name, "icon"),
    );

  /** A target's icon tile, or its dot when this Hindsight gives no icons */
  function markOf(target) {
    const iconName = iconOf(target);
    return iconName ? iconTile(iconName, colorOf(target)) : dot(colorOf(target));
  }

  const kindOf = (target) => (target.type === "super" ? T.kind.super : T.kind.category);
  const unitWord = (template) => template.replace("{n}", "").trim();

  // 系统是不是深色。跟随系统时，系统一换，页面跟着换
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  systemDark.addEventListener("change", () => applyAppearance());

  /** 按设置里的外观给页面换深浅色，见 style.css 的 [data-theme="dark"]。读到设置之前跟随系统 */
  function applyAppearance() {
    const look = settings?.appearance;
    const dark = look === "dark" || (look !== "light" && systemDark.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }

  /** Puts the text that is not re-rendered in the language chosen in the settings */
  function applyLanguage() {
    lang = I.pick(settings?.language);
    T = I.text(lang);
    S = T.settings;
    document.documentElement.lang = lang;
    document.title = T.title;
    $("tab-today").textContent = T.tabs.today;
    $("tab-history").textContent = T.tabs.history;
    $("tab-settings").textContent = T.tabs.settings;
    $("goals-title").textContent = T.goals.title;
    $("now-title").textContent = T.now.title;
    $("app-title").textContent = T.title;
    $("activity-title").textContent = T.ui.activityTitle;
    $("goals-edit").textContent = T.ui.goalsEdit;
    $("settings-heading").textContent = T.ui.settingsHeading;
    $("session-progress").setAttribute("aria-label", T.ui.sessionProgress);
    $("progress-wrap").setAttribute("aria-label", T.ui.timelineLabel);
    $("progress-wrap").setAttribute("aria-describedby", "activity-caption");
    renderDate();
    renderSaveStatus();
    FocusReview.setLanguage(lang);
    // renderNow() sets the button text only when the command changes
    delete $("primary").dataset.command;
  }

  function renderDate() {
    const now = new Date();
    $("page-date").dateTime = C.localDate(now.getTime());
    $("page-date").textContent = new Intl.DateTimeFormat(lang, {
      month: "long", day: "numeric", weekday: "short",
    }).format(now);
  }

  // --- Tabs ------------------------------------------------------------------------------

  function showTab(name, focus = false) {
    for (const tab of ["today", "history", "settings"]) {
      $(`tab-${tab}`).setAttribute("aria-selected", String(tab === name));
      $(`tab-${tab}`).tabIndex = tab === name ? 0 : -1;
      $(`tab-${tab}`).setAttribute("aria-controls", `view-${tab}`);
      $(`view-${tab}`).setAttribute("aria-labelledby", `tab-${tab}`);
      $(`view-${tab}`).hidden = tab !== name;
    }
    if (name === "history") FocusReview.open();
    if (focus) $(`tab-${name}`).focus();
  }

  function openGoals() {
    showTab("settings");
    const section = $("settings-goals");
    if (!section) return;
    section.scrollIntoView({ behavior: "auto", block: "start" });
    section.querySelector("h2").focus({ preventScroll: true });
  }

  function watchTabs() {
    const names = ["today", "history", "settings"];
    for (const [i, name] of names.entries()) {
      $(`tab-${name}`).addEventListener("click", () => showTab(name));
      $(`tab-${name}`).addEventListener("keydown", (e) => {
        let next;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = names[(i + 1) % names.length];
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = names[(i + names.length - 1) % names.length];
        if (e.key === "Home") next = names[0];
        if (e.key === "End") next = names[names.length - 1];
        if (next) {
          e.preventDefault();
          showTab(next, true);
        }
      });
    }
    showTab("today");
  }

  // --- The focus now ---------------------------------------------------------------------

  /** What the background script saw last: the app, its category, and whether it counts as work
   * or off task */
  function renderFocus(view, now) {
    const f = view.focus;
    let app;
    let detail = "";
    // The super-category, or the category if it has none. Its color says how it counts
    let tag = null;
    if (!f.seen) {
      app = T.now.unknown;
    } else if (f.kind === "away") {
      app = T.now.away;
    } else if (!f.app) {
      // A hidden window, or one an ignore rule matches: the event has only the time
      app = T.now.hidden;
    } else {
      app = f.app;
      const c = f.category;
      tag = c ? (c.superName ?? c.name) : T.now.uncategorized;
      // The category after it, unless it has the super-category's name
      detail = c?.superName && c.name !== c.superName ? c.name : "";
    }
    $("now-app").textContent = app;
    $("now-category").textContent = detail;
    $("now-category").hidden = !detail;

    // In the color of the main window when there is one
    const color = C.safeColor(f.category?.color);
    const chip = $("now-kind");
    chip.hidden = tag === null;
    chip.className = color ? "status colored" : `status kind-${f.kind}`;
    if (color) chip.style.setProperty("--c", color);
    else chip.style.removeProperty("--c");
    chip.textContent = tag ?? "";

    let time = "";
    if (f.seen) {
      time = clock(now - f.since);
      // Off task while working: how long until the timer stops
      if (f.kind === "slack" && view.phase === "working" && view.slackSince !== null) {
        time = `${clock(now - view.slackSince)} / ${clock(settings.rhythm.slackMinutes * C.MINUTE)}`;
      }
    }
    $("now-time").textContent = time;
  }

  // --- The timer -------------------------------------------------------------------------

  const COMMAND_ICONS = { start: "play", pause: "pause", resume: "play" };

  // The trail of the block: one cell a minute of the block, ROW cells a row, in the color of what
  // that minute went to most. Minutes still to come are empty
  const ROW = 15;

  // The cells now, and the one under the mouse, for the tooltip
  let cells = [];
  let hovered = null;

  const timeOf = (ms) => new Date(ms).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });

  /** The trail of the block, a cell for each of its minutes, see FocusCore.trail.
   *
   * It runs every second, so the cells are changed in place: new ones would lose the hover */
  function renderTrail(view, now) {
    const minutes = settings.rhythm.workMinutes;
    const trail = C.trail(view, now, minutes);
    cells = trail.cells;
    const { current } = trail;

    // A row starts with the minute it starts at. Built again only when the length changes
    const box = $("progress");
    if (box.dataset.minutes !== String(minutes)) {
      box.dataset.minutes = String(minutes);
      box.replaceChildren();
      for (let i = 0; i < minutes; i++) {
        if (i % ROW === 0) box.append(el("span", { class: "row-label" }, String(i)));
        box.append(el("div", { "data-i": i }));
      }
    }
    box.querySelectorAll("[data-i]").forEach((node) => {
      const i = Number(node.dataset.i);
      const top = cells[i];
      node.className = [
        "cell",
        !top ? "empty" : top.color ? "colored" : `kind-${top.kind}`,
        i === current ? "current" : "",
      ].join(" ");
      if (top?.color) node.style.setProperty("--c", top.color);
      else node.style.removeProperty("--c");
    });

    $("activity-caption").textContent = trail.start === null
      ? ""
      : I.format(T.ui.trailSince, { time: timeOf(trail.start) });
    renderTip();
  }

  /** The tooltip over the cell under the mouse: what the minute went to most, how long, and when */
  function renderTip() {
    const tip = $("progress-tip");
    const top = hovered === null ? null : cells[hovered];
    const node = top ? $("progress").querySelector(`[data-i="${hovered}"]`) : null;
    if (!node) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren(
      el("strong", {}, `${top.name ?? T.now.hidden} · ${clock(top.ms)}`),
      el("span", {}, `${timeOf(top.start)} – ${timeOf(top.end)}`),
    );
    tip.hidden = false;
    // Over the middle of the cell, but kept inside the trail so the window edge does not cut it
    const width = $("progress-wrap").offsetWidth;
    const center = node.offsetLeft + node.offsetWidth / 2;
    const half = tip.offsetWidth / 2;
    const x = Math.min(Math.max(center, half), width - half);
    tip.style.left = `${x}px`;
    tip.style.bottom = `calc(100% - ${node.offsetTop}px + 6px)`;
    tip.style.setProperty("--arrow", `${center - x + half}px`);
  }

  function watchBar() {
    const wrap = $("progress-wrap");
    wrap.addEventListener("mousemove", (e) => {
      const node = e.target.closest("[data-i]");
      hovered = node ? Number(node.dataset.i) : null;
      renderTip();
    });
    wrap.addEventListener("mouseleave", () => {
      hovered = null;
      renderTip();
    });
  }

  function renderNow() {
    if (!settings) return;
    const now = Date.now();
    // A tick that is not saved: the page shows a limit as soon as it passes, without waiting
    // for the background script
    const view = C.step(state, settings, { type: "tick" }, now, lang).state;
    renderFocus(view, now);
    const workday = C.isWorkday(settings, now);
    const key = view.phase === "idle" && !workday ? "offday" : view.phase;
    const { rhythm } = settings;
    renderDate();

    $("hero").dataset.phase = key;
    $("phase").textContent = T.phase[key];

    let shown = "–";
    let total = "";
    if (key === "resting") {
      const rest = rhythm.restMinutes * C.MINUTE;
      shown = clock(rest - (now - view.phaseSince));
      total = clock(rest);
    } else if (key !== "offday") {
      shown = clock(C.elapsed(view, now));
      total = clock(rhythm.workMinutes * C.MINUTE);
    }
    $("clock").textContent = shown;
    $("clock-total").textContent = total ? ` / ${total}` : "";
    $("timer-caption").textContent = key === "resting" ? T.ui.timerRest : T.ui.timerWork;
    const duration = (key === "resting" ? rhythm.restMinutes : rhythm.workMinutes) * C.MINUTE;
    const elapsed = key === "resting" ? now - view.phaseSince : C.elapsed(view, now);
    const percent = key === "offday" ? 0 : Math.max(0, Math.min(100, (elapsed / duration) * 100));
    $("session-fill").style.width = `${percent.toFixed(2)}%`;
    $("session-progress").setAttribute("aria-valuemin", "0");
    $("session-progress").setAttribute("aria-valuemax", "100");
    $("session-progress").setAttribute("aria-valuenow", String(Math.round(percent)));
    $("session-progress").setAttribute("aria-valuetext", `${clock(Math.max(0, Math.min(elapsed, duration)))} / ${clock(duration)}`);
    $("activity-section").hidden = key === "idle" || key === "offday";
    renderTrail(view, now);

    const running = view.runningSince !== null;
    $("hint").textContent =
      key === "working" ? (running ? T.hint.running : T.hint.stopped) : T.hint[key];

    const command =
      key === "idle"
        ? "start"
        : key === "working" || key === "slacking"
          ? "pause"
          : key === "paused"
            ? "resume"
            : null;
    const button = $("primary");
    button.hidden = command === null;
    // Only when it changes, so a hover or a click is not lost to a re-render every second
    if (command && button.dataset.command !== command) {
      button.dataset.command = command;
      button.className = command === "pause" ? "button secondary" : "button primary";
      button.replaceChildren(icon(COMMAND_ICONS[command]), T[command]);
    }
    $("rounds").textContent = I.format(T.rounds, { n: view.rounds });
  }

  async function runCommand() {
    const button = $("primary");
    button.disabled = true;
    try {
      state = await FocusStore.apply({ type: "command", name: button.dataset.command });
      renderNow();
    } catch (e) {
      showError(e);
    } finally {
      button.disabled = false;
    }
  }

  // --- Today's goals ---------------------------------------------------------------------

  function goalRow(goal) {
    const seconds = C.totalSeconds(items, goal.target);
    const level = C.goalLevel(goal, seconds);
    const rule = I.format(goal.rule === "atLeast" ? T.goals.atLeast : T.goals.atMost, {
      time: C.formatMinutes(goal.minutes, lang),
    });
    const ratio = Math.min(1, seconds / (goal.minutes * 60));
    const color = colorOf(goal.target);
    // The icon of the main window; the dot only when this Hindsight gives no icons
    const iconName = iconOf(goal.target);
    return el(
      "div",
      { class: `row block goal ${level ?? ""}` },
      el(
        "div",
        { class: "goal-line" },
        iconName ? iconTile(iconName, color) : null,
        el(
          "div",
          { class: "text" },
          el("span", { class: "label goal-name" }, iconName ? null : dot(color), nameOf(goal.target)),
          el("span", { class: "description" }, `${kindOf(goal.target)} · ${rule}`),
        ),
        el(
          "div",
          { class: "goal-side" },
          level ? el("span", { class: `status ${level}` }, T.goals[level]) : null,
          el("span", { class: "goal-value" }, C.formatMinutes(Math.floor(seconds / 60), lang)),
        ),
      ),
      el(
        "div",
        { class: "bar", role: "progressbar", "aria-label": I.format(T.ui.goalProgress, { name: nameOf(goal.target) }),
          "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(ratio * 100),
          "aria-valuetext": `${C.formatMinutes(Math.floor(seconds / 60), lang)} · ${rule}` },
        el("div", {
          class: color ? "bar-fill colored" : "bar-fill",
          style: `width: ${(ratio * 100).toFixed(2)}%;${color ? ` --c: ${color};` : ""}`,
        }),
      ),
    );
  }

  function renderGoals() {
    if (!settings) return;
    const box = $("goals");
    if (settings.goals.length === 0) {
      // Keep the empty-state action stable when statistics refresh in the background.
      const focused = box.contains(document.activeElement);
      box.replaceChildren(el("div", { class: "empty-state" },
        el("span", { class: "empty-title" }, T.ui.emptyTitle),
        el("p", { class: "description" }, T.ui.emptyDescription),
        el("button", { type: "button", class: "button secondary", onclick: openGoals }, icon("plus"), S.addGoal),
      ));
      if (focused) box.querySelector("button").focus({ preventScroll: true });
      return;
    }
    box.replaceChildren(...settings.goals.map(goalRow));
  }

  // --- Settings --------------------------------------------------------------------------

  let saving = Promise.resolve();
  let saveRevision = 0;
  let saveStatus = "automatic";

  function renderSaveStatus() {
    const box = $("settings-save");
    const keys = { automatic: "saveAutomatic", saving: "saveSaving", saved: "saveSaved", error: "saveError" };
    box.textContent = T.ui[keys[saveStatus]];
    box.dataset.state = saveStatus;
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
  }

  /** Saves the settings as they are now, in the order of the changes */
  function persist() {
    FocusReview.setGoals(settings, { nameOf, markOf });
    const value = JSON.parse(JSON.stringify(settings));
    const revision = ++saveRevision;
    saveStatus = "saving";
    renderSaveStatus();
    saving = saving.then(() => FocusStore.saveSettings(value)).then(() => {
      if (revision !== saveRevision) return;
      saveStatus = "saved";
      renderSaveStatus();
      if ($("error").dataset.source === "save") $("error").hidden = true;
    }).catch((e) => {
      if (revision === saveRevision) {
        saveStatus = "error";
        renderSaveStatus();
      }
      showError(e, "save");
    });
    renderNow();
    renderGoals();
  }

  function section(title, description, ...rows) {
    return el(
      "section",
      { class: "section" },
      el(
        "div",
        { class: "section-head" },
        el("h2", { class: "section-title", tabindex: -1 }, title),
        description ? el("p", { class: "section-desc" }, description) : null,
      ),
      el("div", { class: "card" }, ...rows),
    );
  }

  /** A row with its label on the left and `control` on the right */
  let controlLabelId = 0;
  function row(label, description, control) {
    const labelId = `control-label-${++controlLabelId}`;
    const descriptionId = `${labelId}-description`;
    const node = el(
      "div",
      { class: "row" },
      el(
        "div",
        { class: "text" },
        el("span", { class: "label", id: labelId }, label),
        description ? el("span", { class: "description", id: descriptionId }, description) : null,
      ),
      el("div", { class: "control" }, control),
    );
    for (const input of node.querySelectorAll("input, select")) {
      if (!input.hasAttribute("aria-label")) input.setAttribute("aria-labelledby", labelId);
      if (description) input.setAttribute("aria-describedby", descriptionId);
    }
    return node;
  }

  /** A select of every super-category and category. With `placeholder`, it starts on an empty
   * first option and leaves out `taken` */
  function targetSelect(selected, onchange, { placeholder, taken = [], className = "", ariaLabel, focusKey } = {}) {
    const skip = new Set(taken.map(encode));
    const option = (target, name) =>
      skip.has(encode(target))
        ? null
        : el(
            "option",
            { value: encode(target), selected: selected != null && encode(selected) === encode(target) },
            name,
          );
    return el(
      "select",
      { class: `select ${className}`, "aria-label": ariaLabel, "data-focus": focusKey,
        onchange: (e) => onchange(decode(e.target.value)) },
      placeholder ? el("option", { value: "", selected: true, disabled: true }, placeholder) : null,
      el("optgroup", { label: T.kind.super }, supers.map((s) => option({ type: "super", id: s.id }, s.name))),
      el(
        "optgroup",
        { label: T.kind.category },
        categories.map((c) => option({ type: "category", id: c.id }, c.name)),
      ),
    );
  }

  /** A number input that writes a whole number between `min` and `max` through `set` */
  function numberInput(value, min, max, set, { label, focusKey } = {}) {
    return el("input", {
      class: "number",
      type: "number",
      inputmode: "numeric",
      min,
      max,
      step: 1,
      value,
      "aria-label": label,
      "data-focus": focusKey,
      onchange: (e) => {
        const n = Math.round(Number(e.target.value));
        const clamped = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
        e.target.value = clamped;
        set(clamped);
        persist();
      },
    });
  }

  function minutesControl(value, max, set, focusKey, label) {
    const unit = unitWord(T.units.minutes);
    return [numberInput(value, 1, max, set, { focusKey, label: `${label} (${unit})` }), el("span", { class: "unit" }, unit)];
  }

  /** 只有开、关两项的下拉框 */
  function onOffSelect(on, set, focusKey) {
    return el(
      "select",
      {
        class: "select",
        "data-focus": focusKey,
        onchange: (e) => {
          set(e.target.value === "on");
          persist();
        },
      },
      el("option", { value: "off", selected: !on }, S.off),
      el("option", { value: "on", selected: on }, S.on),
    );
  }

  function iconButton(name, label, onclick) {
    return el("button", { type: "button", class: "icon-button", "aria-label": label, title: label, onclick }, icon(name));
  }

  /** 「界面」一节：界面语言和界面外观 */
  function interfaceSection() {
    const choice = settings.language ?? "system";
    const language = el(
      "select",
      {
        class: "select",
        "data-focus": "language",
        onchange: (e) => {
          settings.language = e.target.value;
          applyLanguage();
          persist();
          renderSettings();
        },
      },
      ["system", ...I.LOCALES].map((value) =>
        el("option", { value, selected: value === choice }, value === "system" ? S.system : I.NAMES[value]),
      ),
    );
    const look = settings.appearance ?? "system";
    const appearance = el(
      "select",
      {
        class: "select",
        "data-focus": "appearance",
        onchange: (e) => {
          settings.appearance = e.target.value;
          applyAppearance();
          persist();
        },
      },
      ["system", "light", "dark"].map((value) => el("option", { value, selected: value === look }, S[value])),
    );
    const toIsland = onOffSelect(
      settings.minimizeToIsland === true,
      (on) => (settings.minimizeToIsland = on),
      "minimize-to-island",
    );
    return section(
      S.interface,
      null,
      row(S.languageLabel, null, language),
      row(S.appearanceLabel, null, appearance),
      row(S.minimizeToIsland, S.minimizeToIslandHint, toIsland),
    );
  }

  function workdaysSection() {
    const day = (d) =>
      el(
        "button",
        {
          type: "button",
          class: "day",
          "aria-label": `${S.workdays}: ${new Intl.DateTimeFormat(lang, { weekday: "long" }).format(new Date(2024, 0, 7 + d))}`,
          "data-focus": `workday-${d}`,
          "aria-pressed": String(settings.workdays.includes(d)),
          onclick: (e) => {
            const on = !settings.workdays.includes(d);
            settings.workdays = on
              ? [...settings.workdays, d].sort()
              : settings.workdays.filter((x) => x !== d);
            e.currentTarget.setAttribute("aria-pressed", String(on));
            persist();
          },
        },
        T.weekdays[d],
      );
    return section(S.workdays, null, el("div", { class: "row" }, el("div", { class: "days", role: "group", "aria-label": S.workdays }, WEEK_ORDER.map(day))));
  }

  function goalEditRow(goal, i) {
    const hours = unitWord(T.units.hours);
    const minutes = unitWord(T.units.minutes);
    return el(
      "div",
      { class: "row block goal-edit", role: "group", "aria-label": nameOf(goal.target) },
      el(
        "div",
        { class: "goal-edit-line" },
        targetSelect(goal.target, (t) => {
          goal.target = t;
          persist();
          renderSettings(`goal-${i}-target`);
        }, { className: "grow", ariaLabel: T.ui.targetLabel, focusKey: `goal-${i}-target` }),
        iconButton("x", I.format(T.ui.removeGoal, { name: nameOf(goal.target) }), () => {
          settings.goals.splice(i, 1);
          persist();
          renderSettings(settings.goals.length ? `goal-${Math.min(i, settings.goals.length - 1)}-target` : "add-goal");
        }),
      ),
      el(
        "div",
        { class: "goal-edit-line" },
        el(
          "select",
          {
            class: "select",
            "aria-label": T.ui.ruleLabel,
            "data-focus": `goal-${i}-rule`,
            onchange: (e) => {
              goal.rule = e.target.value;
              persist();
            },
          },
          el("option", { value: "atLeast", selected: goal.rule === "atLeast" }, S.atLeast),
          el("option", { value: "atMost", selected: goal.rule === "atMost" }, S.atMost),
        ),
        numberInput(Math.floor(goal.minutes / 60), 0, 24, (h) => {
          goal.minutes = Math.max(1, h * 60 + (goal.minutes % 60));
          renderSettings(`goal-${i}-hours`);
        }, { label: T.ui.hoursLabel, focusKey: `goal-${i}-hours` }),
        el("span", { class: "unit" }, hours),
        numberInput(goal.minutes % 60, 0, 59, (m) => {
          goal.minutes = Math.max(1, Math.floor(goal.minutes / 60) * 60 + m);
          renderSettings(`goal-${i}-minutes`);
        }, { label: T.ui.minutesLabel, focusKey: `goal-${i}-minutes` }),
        el("span", { class: "unit" }, minutes),
      ),
    );
  }

  function goalsSection() {
    const add = el(
      "div",
      { class: "row" },
      el(
        "button",
        {
          type: "button",
          class: "button ghost",
          "data-focus": "add-goal",
          onclick: () => {
            settings.goals.push({ target: { type: "super", id: "work" }, rule: "atLeast", minutes: 60 });
            persist();
            renderSettings(`goal-${settings.goals.length - 1}-target`);
          },
        },
        icon("plus"),
        S.addGoal,
      ),
    );
    const node = section(S.goals, null, ...settings.goals.map(goalEditRow), add);
    node.id = "settings-goals";
    return node;
  }

  function rhythmSection() {
    const r = settings.rhythm;
    return section(
      S.rhythm,
      null,
      row(S.workFor, null, minutesControl(r.workMinutes, 240, (v) => (r.workMinutes = v), "rhythm-work", S.workFor)),
      row(S.restFor, null, minutesControl(r.restMinutes, 120, (v) => (r.restMinutes = v), "rhythm-rest", S.restFor)),
      row(S.slackFor, null, minutesControl(r.slackMinutes, 120, (v) => (r.slackMinutes = v), "rhythm-slack", S.slackFor)),
      row(
        S.timerSound,
        S.timerSoundHint,
        onOffSelect(settings.timerSound === true, (on) => (settings.timerSound = on), "timer-sound"),
      ),
    );
  }

  /** The categories and super-categories in `settings.rhythm[key]`, with a select to add more */
  function targetsRow(key, label) {
    const list = settings.rhythm[key];
    const chips = list.map((target, i) =>
      el(
        "span",
        { class: "chip" },
        dot(colorOf(target)),
        el("span", { class: "chip-kind" }, kindOf(target)),
        el("span", { class: "chip-name" }, nameOf(target)),
        iconButton("x", I.format(T.ui.removeCategory, { name: nameOf(target) }), () => {
          list.splice(i, 1);
          persist();
          renderSettings(`category-${key}-add`);
        }),
      ),
    );
    return el(
      "div",
      { class: "row block" },
      el("span", { class: "label" }, label),
      el(
        "div",
        { class: "chips" },
        chips.length ? chips : el("span", { class: "none" }, S.none),
        targetSelect(
          null,
          (target) => {
            list.push(target);
            persist();
            renderSettings(`category-${key}-add`);
          },
          { placeholder: S.add, taken: list, className: "add", ariaLabel: I.format(T.ui.categoryAdd, { name: label }),
            focusKey: `category-${key}-add` },
        ),
      ),
    );
  }

  function categoriesSection() {
    const r = settings.rhythm;
    // What the timer does in a category in neither list, said by the option itself
    const neutral = el(
      "select",
      {
        class: "select",
        "data-focus": "category-neutral",
        onchange: (e) => {
          r.neutral = e.target.value;
          persist();
        },
      },
      el("option", { value: "keep", selected: r.neutral === "keep" }, S.neutralKeep),
      el("option", { value: "pause", selected: r.neutral !== "keep" }, S.neutralPause),
    );
    return section(
      S.categories,
      null,
      targetsRow("work", S.work),
      targetsRow("slack", S.slack),
      row(S.neutral, S.neutralHint, neutral),
    );
  }

  function renderSettings(focusKey = null) {
    const box = $("view-settings");
    const restore = focusKey ?? (box.contains(document.activeElement) ? document.activeElement.dataset.focus : null);
    box.replaceChildren(
      rhythmSection(),
      categoriesSection(),
      workdaysSection(),
      goalsSection(),
      interfaceSection(),
    );
    if (restore) [...box.querySelectorAll("[data-focus]")].find((node) => node.dataset.focus === restore)?.focus({ preventScroll: !focusKey });
  }

  // --- Start -----------------------------------------------------------------------------

  async function refreshState() {
    try {
      state = (await FocusStore.read("state")).value;
      renderNow();
    } catch (e) {
      showError(e);
    }
  }

  async function refreshGoals() {
    try {
      items = await hindsight.call("stats.day_by_category", { date: C.localDate(Date.now()) });
      renderGoals();
    } catch (e) {
      showError(e);
    }
  }
  async function start() {
    FocusReview.init();
    applyAppearance();
    applyLanguage();
    watchTabs();
    $("goals-edit").addEventListener("click", openGoals);
    $("primary").addEventListener("click", runCommand);
    watchBar();
    try {
      settings = await FocusStore.settings();
      applyAppearance();
      applyLanguage();
      [categories, supers] = await Promise.all([
        hindsight.call("categories.list"),
        hindsight.call("super_categories.list"),
      ]);
      renderSettings();
      FocusReview.setGoals(settings, { nameOf, markOf });
      await refreshState();
      await refreshGoals();
    } catch (e) {
      showError(e);
    }
    setInterval(renderNow, 1000);
    // Often, so that the focus shows soon after a switch. Hindsight checks the focus every 5 s
    setInterval(refreshState, 2 * 1000);
    setInterval(refreshGoals, 30 * 1000);
  }

  start();
})();
