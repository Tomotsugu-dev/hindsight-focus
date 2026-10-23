#!/usr/bin/env node
/**
 * 给 README 截介绍图，以 2 倍像素存到 intro/<语言目录>/<图名>.png：
 * - 插件页面：用假数据打开，画成 macOS 上的插件窗口（带红绿灯）；
 * - 岛：用 Hindsight 仓库里岛的页面画，内容是插件的 island.js 从同一份假数据算出的。
 *
 * node scripts/shots/shoot.mjs
 * node scripts/shots/shoot.mjs --lang zh-CN,en --only review --theme dark
 *
 * 假数据见 mock.js，岛见 island-host.js。需要 Google Chrome，别处的 Chrome 用环境变量 CHROME
 * 指定。截岛还要 Hindsight 仓库（默认在旁边的 ../Hindsight）装好依赖。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 要截的图。页面：打开哪一页。岛：收起还是展开，截屏幕最上面正中多大的一块 */
const SHOTS = [
  { name: "today", tab: "today" },
  { name: "review", tab: "history" },
  { name: "island", island: "closed", size: [600, 72] },
  { name: "island-open", island: "open", size: [600, 152] },
];

/** 插件的语言和 intro 下的目录名，目录名和 Hindsight 的 docs/intro 一样 */
const LANGS = { "zh-CN": "zh", "zh-TW": "zh-TW", en: "en", ja: "ja", "pt-BR": "pt", es: "es" };

// 默认假装是这一天，时间停住，每次截出来都一样。月中偏后，月历里有足够多的日子
const DATE = "2026-10-20";

const CHROMES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
].filter(Boolean);

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function options() {
  const { values } = parseArgs({
    options: {
      lang: { type: "string", default: Object.keys(LANGS).join(",") },
      only: { type: "string", default: SHOTS.map((s) => s.name).join(",") },
      theme: { type: "string", default: "light" },
      date: { type: "string", default: DATE },
      hindsight: { type: "string", default: path.join(root, "../Hindsight") },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(`用法：node scripts/shots/shoot.mjs [--lang ${Object.keys(LANGS).join(",")}] [--only ${SHOTS.map((s) => s.name).join(",")}] [--theme light|dark] [--date YYYY-MM-DD] [--hindsight Hindsight 仓库]`);
    process.exit(0);
  }
  const langs = values.lang.split(",");
  const shots = values.only.split(",").map((name) => SHOTS.find((s) => s.name === name) ?? name);
  const bad = [...langs.filter((l) => !LANGS[l]), ...shots.filter((s) => typeof s === "string")];
  if (bad.length > 0) throw new Error(`不认识：${bad.join(", ")}，见 --help`);
  if (!["light", "dark"].includes(values.theme)) throw new Error("--theme 只能是 light 或 dark");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) throw new Error("--date 的格式是 YYYY-MM-DD");
  return { langs, shots, theme: values.theme, date: values.date, hindsight: path.resolve(values.hindsight) };
}

// macOS 窗口的标题栏。红绿灯的大小和位置和 Hindsight 的 web/demo-src/TrafficLights 一样，
// 是在 macOS 27 上量的
const TITLE_BAR = 32;
const BAR_COLORS = {
  light: { bg: "#ebebed", text: "#4d4d50", line: "#d9d9dc" },
  dark: { bg: "#2c2c30", text: "#d5d5d8", line: "#111114" },
};

/** 插件窗口：标题栏，下面是窗口大小的 iframe 里的页面。页面直接开的话，无头 Chrome 的窗口
 * 太窄时会按更宽的尺寸排版 */
function frame(manifest, theme) {
  const { width, height } = manifest.window;
  const c = BAR_COLORS[theme];
  return `<!doctype html><meta charset="utf-8">
<style>
body { margin: 0; overflow: hidden }
.bar { position: relative; display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  width: ${width}px; height: ${TITLE_BAR}px; border-bottom: 1px solid ${c.line}; background: ${c.bg}; color: ${c.text};
  font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif }
.lights { position: absolute; top: 9px; left: 9px; display: flex; gap: 9px }
.lights span { width: 14px; height: 14px; border-radius: 50%; box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.15) }
iframe { display: block; border: 0; width: ${width}px; height: ${height}px }
</style>
<div class="bar"><div class="lights"><span style="background: #ff5f57"></span><span style="background: #febc2e"></span><span style="background: #28c840"></span></div>${manifest.name}</div>
<iframe></iframe><script>document.querySelector("iframe").src = "ui/index.html" + location.search</script>`;
}

/** Hindsight 装好的一个包，按它的 ES 模块入口加载 */
async function load(hindsight, name) {
  const dir = path.join(hindsight, "node_modules", name);
  if (!existsSync(dir)) throw new Error(`${hindsight} 里没有 ${name}，先在那里 npm install`);
  const entry = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")).exports["."];
  const file = typeof entry === "string" ? entry : entry.import?.default ?? entry.import;
  return import(pathToFileURL(path.join(dir, file)).href);
}

/** 把 Hindsight 岛的页面打包到 `outDir`，Tauri 换成 island-tauri.js */
async function buildIsland(hindsight, outDir) {
  const page = path.join(hindsight, "src/island/index.html");
  if (!existsSync(page)) throw new Error(`${hindsight} 里没有岛的页面，用 --hindsight 指定 Hindsight 仓库`);
  const vite = await load(hindsight, "vite");
  const { default: react } = await load(hindsight, "@vitejs/plugin-react");
  await vite.build({
    configFile: false,
    root: hindsight,
    base: "./",
    logLevel: "warn",
    plugins: [react()],
    resolve: {
      alias: [{ find: /^@tauri-apps\/api\/(core|event)$/, replacement: path.join(root, "scripts/shots/island-tauri.js") }],
    },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: page } },
  });
}

/** 在本机开一个只读的网站：插件的文件原样给，../_page.js 换成假的 Hindsight。/frame.html 是插件
 * 窗口，/island.html 是岛的截图页，/island/ 下是打包好的岛的页面 */
async function serve(manifest, islandDir) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/frame.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(frame(manifest, url.searchParams.get("theme")));
      return;
    }
    const name = decodeURIComponent(url.pathname);
    const [base, file] =
      name === "/_page.js" ? [root, path.join(root, "scripts/shots/mock.js")]
      : name === "/island.html" ? [root, path.join(root, "scripts/shots/island.html")]
      : islandDir && name.startsWith("/island/") ? [islandDir, path.join(islandDir, name.slice("/island/".length))]
      : [root, path.join(root, name)];
    try {
      if (!file.startsWith(base + path.sep)) throw new Error("outside");
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

/** 一张图打开哪个网址，窗口多大 */
function target(shot, manifest, params) {
  if (shot.island) {
    return { url: `island.html?${params}&open=${shot.island === "open" ? 1 : 0}`, size: shot.size };
  }
  // 和 Hindsight 打开的插件窗口一样大，上面加标题栏
  return {
    url: `frame.html?${params}&tab=${shot.tab}`,
    size: [manifest.window.width, manifest.window.height + TITLE_BAR],
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (d) => (errors += d));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Chrome 退出码 ${code}\n${errors}`))));
  });
}

async function main() {
  const { langs, shots, theme, date, hindsight } = options();
  const chrome = CHROMES.find((p) => existsSync(p));
  if (!chrome) throw new Error("找不到 Chrome，用环境变量 CHROME 指定");
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const temp = await mkdtemp(path.join(tmpdir(), "focus-shots-"));
  const islandDir = shots.some((s) => s.island) ? path.join(temp, "island") : null;
  let server = null;
  try {
    if (islandDir) await buildIsland(hindsight, islandDir);
    server = await serve(manifest, islandDir);
    for (const lang of langs) {
      const dir = path.join(root, "intro", LANGS[lang]);
      await mkdir(dir, { recursive: true });
      for (const shot of shots) {
        const out = path.join(dir, `${shot.name}.png`);
        const { url, size } = target(shot, manifest, new URLSearchParams({ lang, theme, date }));
        await run(chrome, [
          "--headless=new",
          "--disable-gpu",
          "--hide-scrollbars",
          `--user-data-dir=${path.join(temp, "profile")}`,
          "--force-device-scale-factor=2",
          `--window-size=${size.join(",")}`,
          "--virtual-time-budget=5000",
          `--screenshot=${out}`,
          `http://127.0.0.1:${server.address().port}/${url}`,
        ]);
        console.log(path.relative(root, out));
      }
    }
  } finally {
    server?.close();
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
