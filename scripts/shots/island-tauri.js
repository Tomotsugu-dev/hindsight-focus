// 截图时代替 @tauri-apps/api 的 core 和 event，和 Hindsight 岛的页面打包在一起。岛的页面从截图页
// （父页面，见 island-host.js）拿内容和位置，Rust 那边的事都由截图页做。
const host = window.parent.islandHost;
const handlers = new Map();

// 岛上的时间和截图页一样，停在假装的那一刻
Date.now = () => window.parent.Date.now();

// 截到的是动画的终点
const style = document.createElement("style");
style.textContent = "*, *::before, *::after { transition: none !important; animation: none !important }";
document.head.append(style);

function emit(event, payload) {
  for (const handler of handlers.get(event) ?? []) handler({ event, payload });
}

export async function listen(event, handler) {
  handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  return () => {};
}

export async function invoke(command, args) {
  if (command === "island_content") return host.content;
  if (command === "island_measured") return host.measured(args);
  if (command === "island_ready") host.ready(emit);
  return null;
}
