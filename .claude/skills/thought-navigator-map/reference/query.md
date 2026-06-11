# 查询已有导图(精确 / 模糊 / 取子树 / 坐标)

查询不建图、只读现有 `.moc.md`。`.moc.md` 是纯 JSON,**用 `scripts/moc-query.mjs`(纯 node 读 + 过滤)**,
脱离 `obsidian eval`,直接回显——逻辑与插件 `api.queryNodes` 等价。

## 脚本用法

```
node scripts/moc-query.mjs <mocAbsPath> [选项]
  --node <id>       精确按 nodeID 定位该节点(连同后代),返回单元素数组
  --query <text>    模糊匹配 nodeID/target/alias(大小写不敏感),返回所有命中(各带子树)
  --no-recursive    只到直接子节点(不含孙级);默认带全部后代
  --ids-only        只打印 {path,title,ids}(建图后读回用,见 build.md)
```

返回精简嵌套节点:`{nodeID, nodeType, target, alias?, depth, x?, y?, children[]}`。
不传 `--node`/`--query` → 整棵树;两者都传时 `--node` 优先(脚本里 node 分支先判)。

## 一行命令

`<mocAbsPath>` 须是 `.moc.md` 绝对路径;vault 内相对路径要拼 basePath:

```bash
OBS=/Applications/Obsidian.app/Contents/MacOS/obsidian
SKILL_DIR="<skill 目录绝对路径>"
BASE=$("$OBS" eval code="(()=>app.vault.adapter.basePath)()" | sed 's/^=> //')   # 裸属性不回显,必须函数包裹
Q="$SKILL_DIR/scripts/moc-query.mjs"
F="$BASE/animals1.moc.md"

node "$Q" "$F"                  # 1) 整棵树
node "$Q" "$F" --node 1.1       # 2) 精确按 ID(连同后代)
node "$Q" "$F" --query 哺乳      # 3) 模糊按文本
node "$Q" "$F" --node 1 --no-recursive   # 4) 只要直接子(不含孙级)
```

## 关于 x,y 坐标

- `x,y` = 节点 model 坐标。脚本读到的是**存档坐标**(`.moc.md` 的 `nodePositions`);
  auto 布局未排布过的节点可能没有坐标(字段缺省)。
- 要画布**实时**坐标(视图已打开、用户拖动过),改用能 `await` 的 `api.queryNodes`——它在视图打开时
  用实时 cy 位置覆盖存档坐标。但 `api.queryNodes` 是 async、经 `obsidian eval` 不回显,只适合
  能真正 `await` 的程序化调用方(其他插件、in-process 脚本),不适合 CLI 取结果。

## 程序化调用(其他插件 / in-process)

```js
const r = await app.plugins.plugins['thought-navigator'].api.queryNodes('animals1.moc.md', { nodeID: '1.1' });
// opts: {nodeID?, query?, recursive?};nodeID 与 query 同传时 nodeID 优先。
// 视图打开时返回的 x,y 取自实时 cy 位置,并会并入当前未落地的草稿节点(带 isDraft 标记)。
```
