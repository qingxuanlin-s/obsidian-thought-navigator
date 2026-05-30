#!/usr/bin/env bash
# Demo: 通过 obsidian:// URI 脚本化创建 .moc 文件并搭建父子关系
# 前提:Obsidian 正在运行,且已加载 thought-navigator 插件(本分支版本)。
# 用法: ./create-moc-demo.sh

set -euo pipefail

# 跨平台打开 URI
open_uri() {
  local uri="$1"
  if command -v open >/dev/null 2>&1; then open "$uri"            # macOS
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$uri"  # Linux
  elif command -v cmd.exe >/dev/null 2>&1; then cmd.exe /c start "" "$uri"  # WSL/Windows
  else echo "no opener found"; return 1; fi
}

BASE="obsidian://zk-navigation"

echo "== A. 创建新 .moc(单根节点)=="
echo "1) 最小:vault 根,默认名/标题/布局"
open_uri "$BASE?action=create"
sleep 1

echo "2) 指定名称/目录/标题/布局(目录 MOC 须已存在)"
open_uri "$BASE?action=create&name=read-notes&folder=MOC&title=%E9%98%85%E8%AF%BB%E7%AC%94%E8%AE%B0&layout=auto"
sleep 1

echo "3) 错误演示:目录不存在 -> Notice 报错,不写文件"
open_uri "$BASE?action=create&name=x&folder=NoSuchFolder"
sleep 1

echo
echo "== B. 创建关系树:动物 -> 哺乳动物 -> 人类 / 鸟类 =="
# 用 rootId=1 让根节点 ID 确定,后续 add-node 才能稳定引用
echo "1) 建文件 animals.moc.md,根节点 id=1 '动物'"
open_uri "$BASE?action=create&name=animals&rootId=1&title=%E5%8A%A8%E7%89%A9&layout=auto&open=false"
sleep 1
FILE="animals${MOC_SUFFIX:-.moc.md}"   # 若放在子目录,把 FILE 改成 MOC/animals.moc.md

echo "2) 在 1 下加 '哺乳动物' -> 1.1"
open_uri "$BASE?action=add-node&file=$FILE&parent=1&title=%E5%93%BA%E4%B9%B3%E5%8A%A8%E7%89%A9&open=false"
sleep 1
echo "3) 在 1.1 下加 '人类' -> 1.1.1"
open_uri "$BASE?action=add-node&file=$FILE&parent=1.1&title=%E4%BA%BA%E7%B1%BB&open=false"
sleep 1
echo "4) 在 1 下加 '鸟类' -> 1.2(最后一个 open 打开视图查看)"
open_uri "$BASE?action=add-node&file=$FILE&parent=1&title=%E9%B8%9F%E7%B1%BB"

cat <<'NOTE'

结果树:
  1   动物
  ├─ 1.1   哺乳动物
  │   └─ 1.1.1  人类
  └─ 1.2   鸟类

提示:
- 含中文/空格/斜杠的参数需 URL 编码。
- 子节点 ID 自动按 parentID.N 生成(边由层级自动渲染,无需手填关系)。
- 节点不写坐标,交给自动布局;layout 仅 free|auto。
- add-node 的 file 必须是已存在的 .moc / .moc.md;parent 不存在会 Notice 报错。
- 想在根层加平级节点用 parent=__root__。
NOTE
