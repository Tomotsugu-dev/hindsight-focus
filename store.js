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
    for (const body of notes) await call("notifications.send", { body });
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
    await historyJob;
    return value;
  }

  /** Reads today's statistics and sends the goal notifications that are due */
  async function checkGoals() {
    const s = await settings();
    const now = Date.now();
    if (!FocusCore.isWorkday(s, now)) return;
    const items = await call("stats.day_by_category", { date: FocusCore.localDate(now) });
    const lang = FocusI18n.pick(s.language);
    const { notes } = await update("state", (prev) => {
      const r = FocusCore.checkGoals(prev, s, items, now, lang);
      return { value: r.state, notes: r.notes };
    });
    await send(notes);
  }

  globalThis.FocusStore = { init, read, settings, saveSettings, history, startHistory, apply, checkGoals };
})();
