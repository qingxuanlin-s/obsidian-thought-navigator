# query —— 针对库提问并让探索沉淀

关键洞察:**好答案应回填进库,像 ingest 的源一样复利**,而不是消失在对话里。
前置(定位 wiki + 读 schema)见 [`../SKILL.md`](../SKILL.md)。

## 工作流

1. **先读 `index.md`** 找相关页(内容目录就是为此存在,避免盲搜)→ 钻进去读具体页。
   - 库大到 index 不够用时,才退而用 Grep / thought-navigator-map 的 `scripts/moc-query.mjs` 搜。
2. **带引用作答**:每个论断指向来源页(`[[实体-曹操]]`)或 raw 源。区分**库里的事实** vs **LLM 的推断**。
3. **回填(关键)**:答案若是有价值的对比 / 新连接 / 分析 →
   - 写成新页:对比 → `wiki/比较-AvsB.md`;新综合 → 更新 `wiki/综合.md`;新概念 → `wiki/概念-X.md`。
   - 更新 `index.md`。
   - 产生新的跨页关系 → 按 [`ingest.md`](ingest.md) 的"机械直接落 / 创造性走草稿"规则入图。
4. **记 log**:`## [YYYY-MM-DD] query | <问题>`,注明回填了哪页。

## 答案形态

按问题选:markdown 段落、对比表、要点清单;要图就更新对应 `.moc.md`(走 thought-navigator-map)。
不是每个 query 都回填 —— 只有**值得复用**的才落页,随口一问不必。
