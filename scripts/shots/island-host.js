// 岛的截图页：用插件的 island.js 从假数据算出岛上放什么，交给 Hindsight 岛的页面去画。Rust 在
// macOS 上做的事这里照着做：排两边的位置，窗口只露出岛的形状。数字和 Hindsight 的
// src-tauri/src/island/geometry.rs 一样。网址参数 open=1：鼠标移上去，岛展开了。
(() => {
  const C = FocusCore;
  const EAR = 90;
  const MAX_OPEN_WIDTH = 520;
  const MAX_PANEL_HEIGHT = 200;
  const NOTCH_RADIUS = 10;
  const OPEN_RADIUS = 16;
  // 14 寸 MacBook 的刘海，和 geometry.rs 测试里的一样
  const NOTCH = { width: 200, height: 32 };

  const wantOpen = new URLSearchParams(location.search).get("open") === "1";
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  // 插件交给 island.show 的内容，补上 Rust 读进来时补的默认值
  const run = (r) =>
    typeof r === "string"
      ? { text: r, color: null, dim: false, bold: false }
      : { text: r.text, color: r.color ?? null, dim: r.dim ?? false, bold: r.bold ?? false };
  const text = (t) => ({
    text: (typeof t.text === "string" ? [t.text] : t.text).map(run),
    sub: t.sub ?? null,
    size: t.size ?? "small",
  });
  function component(c) {
    switch (c.type) {
      case "icon":
        return { type: "icon", name: c.name, color: c.color ?? null };
      case "text":
        return { type: "text", ...text(c) };
      case "timer":
        return { type: "timer", start: c.start, end: c.end, pausedAt: c.pausedAt ?? null, color: c.color ?? null };
      case "ring":
        return { type: "ring", value: c.value, text: c.text ?? null, color: c.color ?? null };
      case "cells":
        return { type: "cells", colors: c.colors, columns: c.columns, current: c.current ?? null };
      case "button":
        return { type: "button", id: c.id, icon: c.icon, text: c.text ?? null };
    }
  }

  const { lang, state, settings, today } = globalThis.FocusShots;
  const s = C.withDefaults(settings);
  const now = Date.now();
  const raw = FocusIsland.content(C.step(state, s, { type: "tick" }, now, lang).state, s, now, lang, today);
  const content = {
    closed: {
      left: raw.closed.left ? component(raw.closed.left) : null,
      right: raw.closed.right ? component(raw.closed.right) : null,
    },
    open: raw.open && {
      topRight: raw.open.topRight ? text(raw.open.topRight) : null,
      left: (raw.open.left ?? []).map(component),
      right: (raw.open.right ?? []).map(component),
      bottomRight: raw.open.bottomRight ? text(raw.open.bottomRight) : null,
    },
  };

  // 岛的窗口：和展开到最宽、最高时一样大，贴着屏幕顶边居中。下面的位置都从窗口左上角算
  const W = Math.max(MAX_OPEN_WIDTH, NOTCH.width + 2 * EAR);
  const H = Math.ceil(NOTCH.height + MAX_PANEL_HEIGHT);
  const center = W / 2;
  const frame = document.getElementById("island");
  frame.style.left = `calc(50% - ${W / 2}px)`;
  frame.style.width = `${W}px`;
  frame.style.height = `${H}px`;

  let closed = null;
  let panel = { width: 0, height: 0, topRight: null };
  let opened = false;

  /** 展开的岛：最上面一条加面板，放得下面板、右上角的字和收起时的形状 */
  function openRect() {
    const start = closed.x + closed.width - closed.right;
    const topRight = panel.topRight != null ? 2 * (start - center + panel.topRight) : 0;
    const closedWidth = 2 * Math.max(center - closed.x, closed.x + closed.width - center);
    const width = clamp(Math.max(panel.width, topRight, closedWidth), 2 * OPEN_RADIUS, W);
    const height = NOTCH.height + clamp(panel.height, 2 * OPEN_RADIUS, MAX_PANEL_HEIGHT);
    return { x: center - width / 2, y: 0, width, height };
  }

  /** 上面两个角是方的，贴着屏幕顶边；下面两个角是圆的 */
  function shape({ x, y, width, height }, r) {
    const right = x + width;
    const bottom = y + height;
    return `M ${x} ${y} H ${right} V ${bottom - r} A ${r} ${r} 0 0 1 ${right - r} ${bottom} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${bottom - r} Z`;
  }

  /** 窗口只露出岛：收起时是刘海加两边的耳朵，展开时是整个面板 */
  function draw() {
    const d = opened
      ? shape(openRect(), OPEN_RADIUS)
      : shape({ x: closed.x, y: 0, width: closed.width, height: NOTCH.height }, NOTCH_RADIUS);
    frame.style.clipPath = `path("${d}")`;
  }

  globalThis.islandHost = {
    content,
    /** 页面量出两边和面板多大，返回各放在哪 */
    measured({ left, right, panel: measuredPanel }) {
      // 耳朵最窄是圆，最宽 EAR；没东西的一边不伸出去
      const ear = (width) => (width == null ? 0 : Math.min(Math.max(width, NOTCH.height), EAR));
      const l = ear(left);
      const r = ear(right);
      closed = { x: center - NOTCH.width / 2 - l, width: l + NOTCH.width + r, right: r };
      panel = measuredPanel ?? panel;
      const open = openRect();
      const start = closed.x + closed.width - r;
      const strip = (x, width) => ({ x, y: 0, width, height: NOTCH.height });
      draw();
      return {
        notch: true,
        left: l > 0 ? strip(closed.x, l) : null,
        right: r > 0 ? strip(start, r) : null,
        topRight: strip(start, open.x + open.width - start),
        open,
      };
    },
    /** 内容放好了。要截展开的岛时，这时候鼠标移上去 */
    ready(emit) {
      if (!wantOpen || opened) return;
      opened = true;
      draw();
      emit("island-open", true);
    },
  };

  frame.src = "island/src/island/index.html";
})();
