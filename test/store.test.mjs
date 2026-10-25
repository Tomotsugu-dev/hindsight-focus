// store.js 的测试：交给岛的内容看设置和插件窗口。跑法：node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";

/** 在一个假的 Hindsight 里加载后台用的脚本。岛收到的调用按顺序记在 `island` 里，发出的通知记在
 * `sent` 里 */
function load() {
  const rows = new Map();
  const island = [];
  const sent = [];
  // 2026-10-21 是周三
  let now = new Date(2026, 9, 21, 9, 0).getTime();
  const ctx = {
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    Math,
    console,
    navigator: { language: "zh-CN" },
    hindsight: {
      async call(method, args = {}) {
        const { sql, params = [] } = args;
        if (method.startsWith("island.")) {
          island.push(method);
          return;
        }
        if (method === "notifications.send") {
          sent.push({ ...args });
          return;
        }
        if (method === "db.query") return rows.has(params[0]) ? [rows.get(params[0])] : [];
        if (sql.startsWith("CREATE")) return { changes: 0 };
        const key = sql.startsWith("INSERT") ? params[0] : params[1];
        if (sql.startsWith("INSERT")) {
          if (rows.has(key)) return { changes: 0 };
          rows.set(key, { value: params[1], version: 0 });
        } else {
          const previous = rows.get(key);
          if (!previous || previous.version !== params[2]) return { changes: 0 };
          rows.set(key, { value: params[0], version: previous.version + 1 });
        }
        return { changes: 1 };
      },
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const file of ["i18n.js", "core.js", "history.js", "island.js", "store.js"]) {
    vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), ctx);
  }
  return {
    C: ctx.FocusCore,
    store: ctx.FocusStore,
    island,
    sent,
    now: () => now,
    wait: (ms) => {
      now += ms;
    },
  };
}

const code = { id: "code", name: "编程", superCategory: { id: "work", name: "工作" } };

test("开了「最小化到灵动岛」，窗口最小化或者关着，计时才上岛", async () => {
  const { C, store, island, now, wait } = load();
  await store.saveSettings(C.withDefaults({ minimizeToIsland: true }));
  await store.setWindow("open");
  await store.apply({ type: "focus", at: now(), event: { app: "Code", category: code } });
  await store.apply({ type: "command", name: "start" });
  // 窗口开着：不上岛
  assert.equal(island.at(-1), "island.hide");

  const tick = async (window) => {
    await store.setWindow(window);
    wait(1000);
    await store.apply({ type: "tick" });
    return island.at(-1);
  };
  assert.equal(await tick("minimized"), "island.show");
  assert.equal(await tick("open"), "island.hide");
  assert.equal(await tick("closed"), "island.show");

  // 关掉设置：窗口关着也不上岛
  await store.saveSettings(C.withDefaults({ minimizeToIsland: false }));
  assert.equal(await tick("closed"), "island.hide");
});

test("通知带着 sound 交给 Hindsight：计时提示音关着不响，打开了休息提醒响", async () => {
  for (const timerSound of [false, true]) {
    const { C, store, sent, now, wait } = load();
    await store.saveSettings(C.withDefaults({ timerSound }));
    await store.apply({ type: "focus", at: now(), event: { app: "Code", category: code } });
    await store.apply({ type: "command", name: "start" });
    wait(45 * C.MINUTE);
    await store.apply({ type: "tick" });
    assert.deepEqual(sent, [{ body: "已经专注 45 分钟了，休息 15 分钟吧。", sound: timerSound }]);
  }
});
