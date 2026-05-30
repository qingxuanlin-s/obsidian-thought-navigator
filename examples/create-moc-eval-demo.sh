#!/usr/bin/env bash
# Demo: 用 Obsidian 内置 CLI 的 `eval` 直接调用插件 API 建整棵关系树。
# 不依赖 open/URI。需 Obsidian 正在运行并加载 thought-navigator 插件。
#
# 关键:obsidian eval 是「发射后不管」(立即返回、异步结果不打印),
# 所以用 addNodes 一次性建整棵树(单次读改写,最可靠),而不是逐个 addNode。

set -euo pipefail

OBS="${OBSIDIAN_BIN:-/Applications/Obsidian.app/Contents/MacOS/obsidian}"
[ -x "$OBS" ] || { echo "找不到 Obsidian CLI: $OBS (用 OBSIDIAN_BIN 覆盖)"; exit 1; }

API="app.plugins.plugins['thought-navigator'].api"

echo "== 一条 eval 建整棵树:动物 → 哺乳动物 →(人类)、鸟类 =="
"$OBS" eval code="(async()=>{
  const a = $API;
  await a.createMOC({name:'eval-animals', rootId:'1', title:'动物', layout:'auto'});
  return await a.addNodes('eval-animals.moc.md', [
    {parent:'1',   title:'哺乳动物'},
    {parent:'1.1', title:'人类'},
    {parent:'1',   title:'鸟类'},
  ]);
})()"

echo
echo "已创建 eval-animals.moc.md(异步落盘可能有几秒延迟)。"
echo "用插件视图打开查看,或:  $OBS eval code=\"app.workspace.openLinkText('eval-animals.moc.md','')\""
echo
cat <<'NOTE'
结果树:
  1   动物
  ├─ 1.1   哺乳动物
  │   └─ 1.1.1  人类
  └─ 1.2   鸟类

API:
  createMOC({name,folder,title,layout,overwrite,rootId})  -> 文件路径
  addNode(file, parent, title, kind?)                     -> 新节点 ID
  addNodes(file, [{parent,title,kind?}, ...])             -> 新 ID 数组(推荐,一次建树)
  version()                                               -> 版本号

改了插件、重新构建后,先重载再用:
  obsidian eval code="(async()=>{await app.plugins.disablePlugin('thought-navigator');await app.plugins.enablePlugin('thought-navigator');return 'reloaded';})()"
NOTE
