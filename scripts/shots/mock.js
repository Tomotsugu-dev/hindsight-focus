// 截图用的假 Hindsight：代替插件页面的 ../_page.js，岛的截图页也用它。分类用 Hindsight 新装时的
// 默认分类，统计和计时都是编的。网址参数：lang 语言，theme 深浅色，tab 打开哪一页，date 假装是哪天。
{
  const query = new URLSearchParams(location.search);
  const lang = query.get("lang") ?? "zh-CN";

  // 时间停在 date 那天的 15:30，每次截出来一秒不差
  const RealDate = Date;
  const now = new RealDate(`${query.get("date")}T15:30:00`).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  };
  const M = 60 * 1000;
  const H = 60 * M;

  // Hindsight 各语言的默认大类和分类名
  const NAMES = {
    "zh-CN": { work: "工作", play: "娱乐", social: "社交", browse: "浏览", code: "编程", office: "办公", video: "影音", game: "游戏", talk: "社交" },
    "zh-TW": { work: "工作", play: "娛樂", social: "社交", browse: "瀏覽", code: "程式設計", office: "辦公", video: "影音", game: "遊戲", talk: "社交" },
    en: { work: "Work", play: "Entertainment", social: "Social", browse: "Browsing", code: "Coding", office: "Office", video: "Media", game: "Games", talk: "Social" },
    ja: { work: "仕事", play: "娯楽", social: "ソーシャル", browse: "ブラウジング", code: "コーディング", office: "事務", video: "メディア", game: "ゲーム", talk: "コミュニケーション" },
    "pt-BR": { work: "Trabalho", play: "Entretenimento", social: "Social", browse: "Navegação", code: "Programação", office: "Escritório", video: "Mídia", game: "Jogos", talk: "Social" },
    es: { work: "Trabajo", play: "Ocio", social: "Social", browse: "Navegación", code: "Programación", office: "Oficina", video: "Multimedia", game: "Juegos", talk: "Social" },
  }[lang];

  // 颜色和图标也和 Hindsight 的默认一样
  const supers = [
    { id: "work", color: "#8b5cf6", icon: "Briefcase" },
    { id: "play", color: "#ec4899", icon: "Sparkles" },
    { id: "social", color: "#34d399", icon: "MessageCircle" },
    { id: "browse", color: "#60a5fa", icon: "Globe" },
  ].map((s) => ({ ...s, name: NAMES[s.id] }));
  const superOf = (id) => supers.find((s) => s.id === id);
  const categories = [
    { id: "code", color: "#a78bfa", icon: "Code", super: "work" },
    { id: "office", color: "#0ea5e9", icon: "Briefcase", super: "work" },
    { id: "video", color: "#a855f7", icon: "Film", super: "play" },
    { id: "game", color: "#fb7185", icon: "Gamepad2", super: "play" },
    { id: "talk", color: "#34d399", icon: "MessageCircle", super: "social" },
    { id: "browse", color: "#60a5fa", icon: "Globe", super: "browse" },
  ].map(({ super: s, ...c }) => ({ ...c, name: NAMES[c.id], superCategory: superOf(s) }));
  const categoryOf = (id) => categories.find((c) => c.id === id);
  const usage = (id, hours) => ({ ...categoryOf(id), seconds: Math.round(hours * H / 1000) });

  // 今天：工作 4 小时，娱乐 1 小时 50 分钟，快到 2 小时的上限
  const today = [usage("code", 3 + 1 / 3), usage("office", 2 / 3), usage("video", 1 + 5 / 6), usage("talk", 0.4)];

  // 本月以前的每个工作日：工作和娱乐的小时数，有达成的，也有差一点和差很多的
  const WORK = [6.5, 4, 7, 2, 6.2, 5.5, 3, 6.8, 1, 6.1, 5, 7.5, 4.5, 6.3, 2.5];
  const PLAY = [1, 0.5, 3, 1.5, 2.5, 1, 0.8, 1.2, 2.1, 1, 1.7, 0.5, 4, 1.1, 1.9];
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date(now);
  const todayDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function statsOn(date) {
    if (date === todayDate) return today;
    const n = Number(date.slice(8)) % WORK.length;
    return [usage("code", WORK[n]), usage("video", PLAY[n])];
  }

  // 本段已经 25 分半：工作、摸鱼一会儿、工作、聊天，最近 5 分半在写代码。不取整分：一分钟刚开始
  // 时，轨迹里当前那格还是空的
  const work = superOf("work");
  const play = superOf("play");
  const social = superOf("social");
  const running = 5.5 * M;
  const start = now - 20 * M - running;
  const state = {
    date: todayDate,
    phase: "working",
    blockMs: 20 * M,
    segments: [
      { kind: "work", color: work.color, name: work.name, start, ms: 10 * M },
      { kind: "slack", color: play.color, name: play.name, start: start + 10 * M, ms: 3 * M },
      { kind: "work", color: work.color, name: work.name, start: start + 13 * M, ms: 5 * M },
      { kind: "neutral", color: social.color, name: social.name, start: start + 18 * M, ms: 2 * M },
    ],
    runningSince: now - running,
    runKind: "work",
    runColor: work.color,
    runName: work.name,
    slackSince: null,
    phaseSince: start,
    rounds: 2,
    distractions: 1,
    focus: {
      kind: "work",
      since: now - running,
      seen: true,
      app: "Visual Studio Code",
      category: { name: NAMES.code, superName: work.name, color: work.color, icon: "Code" },
    },
    notified: {},
  };
  // 周一到周五上班，其他用默认设置
  const settings = { language: lang, appearance: query.get("theme") ?? "light", workdays: [1, 2, 3, 4, 5] };
  // 岛的截图用同一份假数据，见 island-host.js
  globalThis.FocusShots = { lang, state, settings, today };

  // 插件的 kv 表，存在内存里
  const kv = new Map([
    ["state", { value: JSON.stringify(state), version: 0 }],
    ["settings", { value: JSON.stringify(settings), version: 0 }],
  ]);
  function db(sql, params = []) {
    if (sql.startsWith("CREATE")) return { changes: 0, lastInsertRowid: 0 };
    if (sql.startsWith("SELECT")) {
      const row = kv.get(params[0]);
      return row ? [row] : [];
    }
    if (sql.startsWith("INSERT")) {
      if (kv.has(params[0])) return { changes: 0 };
      kv.set(params[0], { value: params[1], version: 0 });
      return { changes: 1 };
    }
    if (sql.startsWith("UPDATE")) {
      const [value, key, version] = params;
      const row = kv.get(key);
      if (!row || row.version !== version) return { changes: 0 };
      kv.set(key, { value, version: version + 1 });
      return { changes: 1 };
    }
    throw new Error(`mock: ${sql}`);
  }

  window.hindsight = {
    async call(method, params) {
      switch (method) {
        case "categories.list":
          return categories;
        case "super_categories.list":
          return supers;
        case "stats.day_by_category":
          return statsOn(params.date);
        case "db.query":
        case "db.execute":
          return db(params.sql, params.params);
        default:
          throw new Error(`mock: ${method}`);
      }
    },
  };

  // 页面准备好以后切到要截的那一页
  const tab = query.get("tab");
  if (tab && tab !== "today") {
    addEventListener("load", () => setTimeout(() => document.getElementById(`tab-${tab}`).click(), 300));
  }
  // 截到的是动画的终点
  addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = "*, *::before, *::after { transition: none !important; animation: none !important }";
    document.head.append(style);
  });
}
