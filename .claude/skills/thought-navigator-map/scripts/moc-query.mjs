#!/usr/bin/env node
// moc-query.mjs — 只读查询 / 读回 .moc.md(纯 Node,不经 obsidian eval)。
// .moc.md 是纯 JSON(见插件 mocJsonCodec),查询只需 fs 读 + JS 过滤,无需渲染进程。
//
// 用法:
//   node moc-query.mjs <mocAbsPath> [选项]
//     --node <id>       精确按 nodeID 定位该节点(连同后代),单元素数组
//     --query <text>    模糊匹配 nodeID/target/alias(大小写不敏感),返回所有命中(各带子树)
//     --no-recursive    只到直接子节点(不含孙级);默认带全部后代
//     --ids-only        只打印 {path,title,ids}(建图后读回 ID 列表用)
//   <mocAbsPath> 为 .moc.md 绝对路径;vault 内相对路径需自行拼 basePath:
//     BASE=$(obsidian eval code="(()=>app.vault.adapter.basePath)()" | sed 's/^=> //')
//     node moc-query.mjs "$BASE/animals1.moc.md" --query 哺乳
//
// 输出:JSON(可回显),作为最终结果反馈给用户。

import fs from 'node:fs';

const argv = process.argv.slice(2);
const mocPath = argv[0];
if (!mocPath) {
  console.error('usage: node moc-query.mjs <mocAbsPath> [--node id] [--query text] [--no-recursive] [--ids-only]');
  process.exit(1);
}
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const nodeId = opt('--node');
const query = opt('--query');
const recursive = !argv.includes('--no-recursive');
const idsOnly = argv.includes('--ids-only');

const d = JSON.parse(fs.readFileSync(mocPath, 'utf8'));
const roots = d.nodes || [];
const pos = d.nodePositions || {};

// --ids-only:建图后读回,打印 {path,title,ids}
if (idsOnly) {
  const ids = [];
  const walk = (n) => { ids.push(n.nodeID); (n.children || []).forEach(walk); };
  roots.forEach(walk);
  const rel = mocPath.split('/').pop();
  console.log(JSON.stringify({ path: rel, title: roots[0] && roots[0].target, ids }));
  process.exit(0);
}

const slim = (n, lv) => {
  const v = { nodeID: n.nodeID, nodeType: n.nodeType, target: n.target };
  if (n.alias) v.alias = n.alias;
  v.depth = n.depth;
  const p = pos[n.nodeID];
  if (p && typeof p.x === 'number' && typeof p.y === 'number') { v.x = p.x; v.y = p.y; }
  v.children = lv > 0 ? (n.children || []).map((c) => slim(c, lv - 1)) : [];
  return v;
};
const lv = recursive ? Infinity : 1;

const flat = [];
(function w(list) { for (const n of list) { flat.push(n); w(n.children || []); } })(roots);

let out;
if (nodeId) {
  const hit = flat.find((n) => String(n.nodeID) === String(nodeId));
  out = hit ? [slim(hit, lv)] : [];
} else if (query) {
  const q = String(query).toLowerCase();
  out = flat
    .filter((n) => (n.nodeID + '\n' + (n.target || '') + '\n' + (n.alias || '')).toLowerCase().includes(q))
    .map((n) => slim(n, lv));
} else {
  out = roots.map((n) => slim(n, lv));
}
console.log(JSON.stringify(out));
