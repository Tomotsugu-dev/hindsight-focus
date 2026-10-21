// ui/icons.js 的测试。跑法：node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import "../ui/icons.js";

const { ICONS } = globalThis.FocusIcons;
const SHAPES = ["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"];

// 主界面不认识的图标名都画成 Tag，所以 Tag 必须在
test("有回退用的 Tag", () => {
  assert.ok(ICONS.Tag);
});

// 默认大类和分类的图标都在：工作、娱乐、社交、浏览，编程、设计、其他
test("默认分类的图标都在", () => {
  for (const name of ["Briefcase", "Gamepad2", "MessageCircle", "Globe", "Code", "Brush", "MoreHorizontal"]) {
    assert.ok(ICONS[name], name);
  }
});

// 每个图标都是 [元素名, 属性] 的列表，只用 SVG 的基本图形，属性都是字符串
test("每个图标只有 SVG 基本图形", () => {
  for (const [name, shapes] of Object.entries(ICONS)) {
    assert.ok(shapes.length > 0, name);
    for (const [tag, attrs] of shapes) {
      assert.ok(SHAPES.includes(tag), `${name}: ${tag}`);
      for (const value of Object.values(attrs)) assert.equal(typeof value, "string", name);
    }
  }
});
