importScripts("i18n.js", "core.js", "history.js", "island.js", "store.js");

const TICK_MS = 15 * 1000;
const GOALS_EVERY = 4;
// 岛上的按钮，id 就是命令名
const COMMANDS = ["start", "pause", "resume"];

let queue = Promise.resolve();
function later(job) {
  queue = queue.then(job).catch((e) => console.error(e));
}

// 下一个时限到时走一次规则：岛上的计时器到 0 时马上换成休息，提醒也不会晚到 15 秒
let deadline = null;
async function schedule() {
  const at = await FocusStore.nextLimit();
  clearTimeout(deadline);
  if (at !== null) {
    deadline = setTimeout(() => run({ type: "tick" }), Math.max(0, at - Date.now()) + 100);
  }
}

/** 走一次规则，再按新的状态定下一个时限 */
function run(input) {
  later(async () => {
    await FocusStore.apply(input);
    await schedule();
  });
}

// A worker restart closes the observed stretch. Wait for a fresh focus.changed event.
later(() => FocusStore.startHistory());

hindsight.on("focus.changed", (event) => {
  run({ type: "focus", at: Date.parse(event.at), event });
});

hindsight.on("island.clicked", ({ button }) => {
  if (COMMANDS.includes(button)) run({ type: "command", name: button });
});

let ticks = 0;
setInterval(() => {
  run({ type: "tick" });
  ticks += 1;
  if (ticks % GOALS_EVERY === 0) later(() => FocusStore.checkGoals());
}, TICK_MS);

run({ type: "tick" });
later(() => FocusStore.checkGoals());
