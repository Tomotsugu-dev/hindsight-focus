// The settings and the state, kept in the plugin's own database. The background script and the
// page both change the state, so a write goes through only if nobody wrote in between.
(() => {
  const call = (method, params) => globalThis.hindsight.call(method, params);

  let ready = null;
  function init() {
    ready ??= call("db.execute", {
      sql: "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL)",
    });
    return ready;
  }

  /** The value under `key` and its version. Both are null if nothing was saved yet */
  async function read(key) {
    await init();
    const rows = await call("db.query", {
      sql: "SELECT value, version FROM kv WHERE key = ?",
      params: [key],
    });
    if (rows.length === 0) return { value: null, version: null };
    return { value: JSON.parse(rows[0].value), version: rows[0].version };
  }

  /** Saves `value` if the row still has `version`. Returns whether it did */
  async function write(key, value, version) {
    const json = JSON.stringify(value);
    const result =
      version === null
        ? await call("db.execute", {
            sql: "INSERT OR IGNORE INTO kv (key, value, version) VALUES (?, ?, 0)",
            params: [key, json],
          })
        : await call("db.execute", {
            sql: "UPDATE kv SET value = ?, version = version + 1 WHERE key = ? AND version = ?",
            params: [json, key, version],
          });
    return result.changes === 1;
  }

  /** Reads, changes and saves. `change` gets the saved value and returns { value, ... }; it runs
   * again if the other side wrote in between */
  async function update(key, change) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { value, version } = await read(key);
      const result = change(value);
      if (await write(key, result.value, version)) return result;
    }
    throw new Error(`${key}: the other side kept writing`);
  }

  async function settings() {
    return FocusCore.withDefaults((await read("settings")).value);
  }

  function saveSettings(value) {
    return update("settings", () => ({ value }));
  }

  // Each worker gets its own identity. Page commands do not record or assume a foreground app.
  const historySession = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  async function history() {
    return (await read("history")).value;
  }

  async function recordHistory(input, now = Date.now()) {
    try {
      await update("history", (prev) => ({
        value: FocusHistory.reduce(prev, { ...input, sessionId: historySession }, now),
      }));
    } catch (e) {
      // Recording is independent: a full history store must not stop the timer or notifications.
      console.error("focus history:", e);
    }
  }

  function startHistory() {
    return recordHistory({ type: "boot" });
  }

  async function send(notes) {
    for (const body of notes) await call("notifications.send", { body, sound: true });
  }

  /** checkGoals 存下的今天的统计：后台和页面交给岛的今日目标都从这里算，两边才一样。不是今天的
   * 返回 null */
  async function todayStats(now) {
    const { value } = await read("stats");
    return value?.date === FocusCore.localDate(now) ? value.items : null;
  }

  /** 插件窗口现在的样子："open"、"minimized" 或 "closed"。后台按 Hindsight 的 window.changed 存，
   * 两边交给岛的内容都看它 */
  async function windowState() {
    return (await read("window")).value ?? "closed";
  }

  function setWindow(state) {
    return update("window", () => ({ value: state }));
  }

  // 这一边上次交给岛的内容：一样的就不再交
  let lastIsland;

  /** 把 `state` 放到岛上，不该放时撤下 */
  async function showIsland(state, s, now) {
    const [items, window] = await Promise.all([todayStats(now), windowState()]);
    const lang = FocusI18n.pick(s.language);
    const content = FocusIsland.wanted(s, window)
      ? FocusIsland.content(state, s, now, lang, items)
      : null;
    const json = JSON.stringify(content);
    if (json === lastIsland) return;
    lastIsland = json;
    try {
      if (content) await call("island.show", content);
      else await call("island.hide");
    } catch (e) {
      // 旧版 Hindsight 没有岛：计时和提醒照常。内容变了才再试，不每次都报错
      console.error("focus island:", e);
    }
  }

  /** Runs one input through the rules, saves the state and sends the notifications. A focus
   * input carries the event, and its kind is found with the current settings */
  async function apply(input) {
    const s = await settings();
    const now = Date.now();
    const { event } = input;
    const resolved =
      input.type === "focus"
        ? {
            type: "focus",
            at: input.at,
            kind: FocusCore.kindOf(event, s),
            app: event.app ?? null,
            category: event.category
              ? {
                  name: event.category.name,
                  superName: event.category.superCategory?.name ?? null,
                  // The color the page shows: the super-category's, or the category's if it has none
                  color: FocusCore.safeColor(event.category.superCategory?.color ?? event.category.color),
                  // 岛上的图标：小类自己的，编程就是编程的图标
                  icon: event.category.icon ?? null,
                }
              : null,
          }
        : input;
    // Record all observed foreground states, including while the rhythm is idle or paused.
    // Use the original category IDs; the timer's compact focus only keeps display fields.
    const historyJob = input.type === "focus"
      ? recordHistory({ ...resolved, category: event.category ?? null }, now)
      : input.type === "tick" ? recordHistory({ type: "tick" }, now) : null;
    const lang = FocusI18n.pick(s.language);
    const { value, notes } = await update("state", (prev) => {
      const r = FocusCore.step(prev, s, resolved, now, lang);
      return { value: r.state, notes: r.notes };
    });
    await send(notes);
    await showIsland(value, s, now);
    await historyJob;
    return value;
  }

  /** Reads today's statistics and sends the goal notifications that are due. 岛上的今日目标也跟着
   * 更新 */
  async function checkGoals() {
    const s = await settings();
    const now = Date.now();
    if (!FocusCore.isWorkday(s, now)) return;
    const date = FocusCore.localDate(now);
    const items = await call("stats.day_by_category", { date });
    await update("stats", () => ({ value: { date, items } }));
    const lang = FocusI18n.pick(s.language);
    const { value, notes } = await update("state", (prev) => {
      const r = FocusCore.checkGoals(prev, s, items, now, lang);
      return { value: r.state, notes: r.notes };
    });
    await send(notes);
    await showIsland(value, s, now);
  }

  /** 下一个时限几点到，见 FocusCore.nextLimit。null：没有时限在走 */
  async function nextLimit() {
    const [s, { value }] = await Promise.all([settings(), read("state")]);
    return value ? FocusCore.nextLimit(value, s.rhythm) : null;
  }

  globalThis.FocusStore = {
    init, read, settings, saveSettings, history, startHistory, apply, checkGoals, nextLimit,
    setWindow,
  };
})();
