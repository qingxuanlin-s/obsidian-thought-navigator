---
name: thought-llm-wiki
version: 0.1.0
description: llm-wiki 应用层 · 维护一个 LLM 知识库的三种操作 —— ingest(摄取一篇新源)、query(针对库提问并把好答案回填)、lint(全库体检找问题)。先定位 wiki 根、读其 schema,再按意图分流。仅在用户显式点名调用(输入 /thought-llm-wiki,或明确说"把这篇 ingest 进库 / 在库里查 / 体检一下知识库")时触发;不要在普通对话中自动触发。
---

# thought-llm-wiki —— llm-wiki 知识库维护

架在基建 [`thought-navigator-map`](../thought-navigator-map/SKILL.md) 之上。一个库(raw 源 + wiki 页 + 综合 MOC)的三种操作共享同一前置,按意图翻对应参考文件。

> **触发约束**:必须用户主动点名(`/thought-llm-wiki` 或"ingest 这篇 / 在库里查 / 体检库")才执行,不自动感知。

## 前置(三条路通用)

1. **定位 wiki 根目录** = 含 `index.md` / `log.md` / `raw/` / `wiki/` / `CLAUDE.md` 的目录。
   优先用用户指明的;否则从当前文件向上找最近含 `index.md` 的目录;找不到就问。
2. **先读该目录的 `CLAUDE.md`(schema)** —— 命名规则、提升规则(复现 / 首要类型+实质)、谁写永久笔记(满血 llm-wiki=LLM 写;Zettelkasten 变体=实体/概念页用户手写、本 skill 只写摘要+连接)、矛盾怎么标、MOC 入图范围。**一切细节以它为准**,本 skill 只给骨架。

## 选哪条路(先决策,再翻参考文件)

| 用户想 | 操作 | 详细步骤 |
|------|------|----------|
| 把一篇新源加进库 | **ingest** | [`reference/ingest.md`](reference/ingest.md) |
| 针对库提问、要答案 | **query** | [`reference/query.md`](reference/query.md) |
| 体检 / 找库里的问题 | **lint** | [`reference/lint.md`](reference/lint.md) |

> 三者会交织:query 出好答案要回填(走 ingest 的入页/入图);lint 的修复项转交 ingest。按当前主诉选主路,需要时跨用。

## 全局原则(各路通用)

- **人在环中**:ingest / query 全程在**主对话**里跑,你和用户来回拍板,**不要 spawn agent**(够不到用户)。只有 lint 的全库扫描派给 `wiki-lint` 子代理。
- **MOC 是两张图,各司其职**(详见 [`reference/moc-layer.md`](reference/moc-layer.md)):`综合.moc.md`=目录树(实体/概念/关系三类内容,无横向关系),`关系图.moc.md`=关系网(根=核心实体、父子边带 `relationText`、跨链走反向关系、事件用 `①②③` 编号、自由布局)。两张都**只画实体/概念,raw/摘要不入图**(溯源走 `sources:`);ingest 时**两张都更新**。
- **找关系的分工**:**机械关系**(综合→新实体/概念、同名实体、缺失回链)直接落盘;**创造性关系**(实体/概念之间跨主题、结构同构)走 thought-navigator-map 的 `addDraftNodes` 注入草稿,由用户在画布确认。LLM 大胆提,用户快速判。
- **冲突不覆盖**:新数据和旧页打架 → `⚠️ 矛盾` 块并列两来源,不擅自取一个。
- **区分事实与推断**:库里写明的是事实,LLM 的判断标明是推断。
