importScripts("i18n.js", "core.js", "history.js", "store.js");

const TICK_MS = 15 * 1000;
const GOALS_EVERY = 4;

let queue = Promise.resolve();
function later(job) {
  queue = queue.then(job).catch((e) => console.error(e));
}

// A worker restart closes the observed stretch. Wait for a fresh focus.changed event.
later(() => FocusStore.startHistory());

hindsight.on("focus.changed", (event) => {
  later(() => FocusStore.apply({ type: "focus", at: Date.parse(event.at), event }));
});

let ticks = 0;
setInterval(() => {
  later(() => FocusStore.apply({ type: "tick" }));
  ticks += 1;
  if (ticks % GOALS_EVERY === 0) later(() => FocusStore.checkGoals());
}, TICK_MS);

later(() => FocusStore.apply({ type: "tick" }));
later(() => FocusStore.checkGoals());
