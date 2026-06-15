# zk · 工作区重构设计文档

> 给 Claude Code 的实现规范。本文档定义 zk 知识管理插件的数据模型、信息架构、交互与视觉系统。配套可交互原型见 `zk_workspace.html`(及 `zkw-data.jsx` / `zkw-app.jsx` / `zkw-graph.jsx`)。

- **版本**: v1.0
- **平台**: Obsidian 风格本地优先插件(具体宿主按你现有技术栈)
- **配套原型**: `zk_workspace.html` — 完整三栏交互;`workspace_redesign.html` — 现状⇄重构对照;`mindmap_v2.html` — 图谱视图参考

---

## 0. 一句话设计哲学

> **框架是镜头,节点有类型,项目能追踪。**

三个推论,贯穿全文:

1. **节点是一等公民,有类型**(Space / MOC / Project / Note / Map),类型决定行为 —— 而不是"文件夹 + 图标贴纸"。
2. **PARA、总览·主题·局部 等"框架"只是套在同一份数据上的镜头**(分桶 + 命名 + 默认视图),可一键切换,不搬动任何节点。
3. **关系用 link 表达,不用文件夹嵌套**。一个 Project 可同时服务多个 MOC —— 文件夹做不到。

---

## 1. 为什么推翻"文件夹树"模型

### 现状问题(见 `workspace_redesign.html` 的"现状"模式)

当前实现把两套知识框架(空间 A 用 PARA、空间 B 用 总览·主题·局部)**做成了同质文件夹**:`Projects/`、`Areas/`、`总览/`、`主题/` 都是普通文件夹,框架只存在于文件夹"名字"里,没进数据模型。导致:

| 问题 | 根因 |
|---|---|
| 看不出项目状态/进度/停滞 | 文件夹只有"层级"一个维度,没有"状态/时间"维度 |
| `某跨域项目` 既服务主题 A 又服务主题 B,只能二选一塞进一个文件夹 | 文件夹是单亲容器,无法表达多对多 |
| 换个 Space 要重搓一套空文件夹 | 框架是手工骨架,不是可复用的声明 |
| 系统分不清谁是容器、谁是 MOC、谁是原子笔记 | 全是 folder,没有类型 |

### 关键洞察:两套框架底层是同一个原语

| | 入口/责任域 | 子主题 | 原子单元 | 行动单元 |
|---|---|---|---|---|
| **PARA** | Area | (Area 下分组) | Resource | **Project** |
| **总览-主题-局部** | 总览 (MOC) | 主题 (MOC) | 局部知识 (Note) | (隐含的实践) |

`Area` ≡ `主题` ≡ 一个聚合性 **MOC** 入口;`Resource` ≡ `局部知识` ≡ 一篇 **Note**。区别只是**叫法**和**有没有"项目"这一列**。所以底层只需要一套 typed 节点 + 一层"框架"皮。

---

## 2. 数据模型

### 2.1 核心原则:id 引用,不依赖 path

> 沿用现有 `folder_impl_doc` §9.5 的决策:**节点之间用稳定 id 引用,而非文件路径**。移动/改名/重组都不会断链。这是整个关系系统能成立的地基。

### 2.2 节点类型

```ts
type NodeType = 'space' | 'moc' | 'project' | 'note' | 'map';

interface BaseNode {
  id: string;            // 稳定唯一 id,生成后永不变(nanoid / uuid)
  type: NodeType;
  spaceId: string;       // 所属 Space
  title: string;
  createdAt: number;
  updatedAt: number;     // 任何编辑都刷新 —— "最近更新/停滞"全靠它,自动
  refs: string[];        // 出链:本节点指向的其他节点 id(typed link 见 2.4)
}
```

各类型的扩展字段:

```ts
// 领域 —— 顶层组织单元。本身是可被"打开"的节点(打开后显示概览页)
interface SpaceNode extends BaseNode {
  type: 'space';
  framework: FrameworkId;   // 当前镜头,可切换,默认 'custom'
}

// MOC —— 聚合入口(= PARA 的 Area = 总览体系的 总览/主题)
interface MocNode extends BaseNode {
  type: 'moc';
  isTop?: boolean;          // 是否"总览"级(framework=overview 时区分总览 vs 主题)
  parentMocId?: string;     // 可选:主题挂在总览下
  description?: string;
}

// 项目 —— 唯一带"追踪"语义的类型
interface ProjectNode extends BaseNode {
  type: 'project';
  status: ProjectStatus;    // 手动,见 §6
  nextAction?: string;      // 下一步,见 §6.3 —— 单行,收尾即写
  // progress 不存死值,从 checklist 算,见 §6.2
  checklist?: ChecklistItem[];
  // refs 里指向的 MOC = "服务于哪些责任域"(可多个 → 跨域)
}

interface ChecklistItem { id: string; text: string; done: boolean; }

// 笔记 —— 原子知识单元(= PARA 的 Resource = 局部知识)
interface NoteNode extends BaseNode {
  type: 'note';
  body: string;             // markdown 正文
}

// 图谱 —— 思维导图/知识网络(可视为一种特殊的、内容是 graph 的 note)
interface MapNode extends BaseNode {
  type: 'map';
  graph: GraphData;         // 见 §5.3
}

type ProjectStatus = 'active' | 'blocked' | 'done' | 'archived';
```

### 2.3 框架(镜头)定义

框架**不存数据**,是纯渲染规则。每个框架把节点分到若干"桶":

```ts
type FrameworkId = 'para' | 'overview' | 'custom';

interface Bucket {
  id: string;
  label: string;
  match: (n: Node) => boolean;   // 纯函数,决定节点落入哪个桶
}

interface Framework {
  id: FrameworkId;
  label: string;        // 完整名,如 "总览·主题·局部"
  chip: string;         // 短标签,如 "总览体系"
  buckets: Bucket[];
}
```

三套内置框架(直接照抄,见 `zkw-data.jsx` 的 `FRAMEWORKS`):

```ts
const FRAMEWORKS = {
  para: {
    label: 'PARA', chip: 'PARA',
    buckets: [
      { id: 'projects',  label: 'Projects',  match: n => n.type==='project' && n.status!=='archived' },
      { id: 'areas',     label: 'Areas',     match: n => n.type==='moc' },
      { id: 'resources', label: 'Resources', match: n => n.type==='note' || n.type==='map' },
      { id: 'archive',   label: 'Archive',   match: n => n.status==='archived' },
    ],
  },
  overview: {
    label: '总览·主题·局部', chip: '总览体系',
    buckets: [
      { id: 'overview', label: '总览',     match: n => n.type==='moc' && n.isTop },
      { id: 'theme',    label: '主题',     match: n => n.type==='moc' && !n.isTop },
      { id: 'local',    label: '局部知识', match: n => n.type==='note' || n.type==='map' },
      { id: 'action',   label: '行动·项目', match: n => n.type==='project' && n.status!=='archived' },
    ],
  },
  custom: {
    label: '自定义', chip: '自定义',
    buckets: [ { id: 'all', label: '全部', match: n => n.status!=='archived' } ],
  },
};
```

**切换框架 = 换一组 `buckets` 重新分组同一批节点。零数据迁移。** 这是整个设计最重要的一条,务必让它在 Space 概览页和右侧导航树里同时生效。

### 2.4 链接(typed link)

节点间关系用有向、带类型的边表达(你图谱里已有 typed link,延伸到所有节点):

```ts
interface Link {
  from: string;       // 源节点 id
  to: string;         // 目标节点 id
  type: LinkType;
}

type LinkType =
  | 'serves'     // Project --serves--> MOC   "服务于责任域"
  | 'partOf'     // Note/Map --partOf--> MOC   "归属于"
  | 'childMoc'   // MOC --childMoc--> MOC      "主题挂总览下"
  | 'related'    // 通用关联(图谱里的跨主题引用,带 label)
  | ...;          // 你现有的其他 typed link 继续沿用
```

> 实现上 `refs` 可以是 `Link[]` 的反范式缓存,或直接用 `Link[]`。关键是:**MOC 的聚合 = 反查"谁 serves/partOf 我",实时算出,不维护双向冗余。**

### 2.5 聚合查询(MOC 的核心能力)

```ts
// 一个 MOC 实时聚合所有指向它的节点 —— 不靠文件夹嵌套
function servedBy(mocId: string, allNodes: Node[]): Node[] {
  return allNodes.filter(n => n.refs.includes(mocId));
}
```

打开一个 MOC、或在 Space 概览里渲染 MOC 卡片上的"聚合 N",都走这个查询。

---

## 3. 信息架构:三栏壳

```
┌──────────────────────────────────────────────────────────────┐
│  顶栏: zk logo · [⌂ 今日] · 面包屑(可点回退) ·····  提示    │
├────────────┬──────────────────────────────┬──────────────────┤
│            │                              │                  │
│  左:暂存区  │       中:万能视口             │   右:Spaces 树    │
│ Scratchpad │   (按打开的节点变内容)         │   (常驻导航)      │
│  = 捕获     │       = 工作                 │   = 导航          │
│            │                              │                  │
│ 可收起 ◀    │                              │      ▶ 可收起     │
└────────────┴──────────────────────────────┴──────────────────┘
                              ▲
              详情 deck 从右侧滑出,覆盖在 Spaces 树之上
```

### 3.1 三个区的职责(不可混淆)

| 区 | 职责 | 是否常驻 |
|---|---|---|
| **左 Scratchpad** | **捕获** —— 暂存草稿、待归档卡片,拖到 MOC/Note 归档 | 常驻(可收起为竖条) |
| **中 视口** | **工作** —— 渲染当前打开的任意节点 | 始终 |
| **右 Spaces 树** | **导航** —— 浏览所有 Space 与其下节点 | 常驻(可收起为竖条) |

> **关键决策:不存在"切换 MOC 区 / Space 区"。** 导航永远在两侧;"打开一个 Space"和"打开一篇笔记""打开一个 MOC"是**同一个动作** —— 都在中间视口换内容。这一点直接回答了"进来先进主页还是 MOC 视图"的纠结:**两者都不强制,启动恢复上次打开的视口**。

### 3.2 万能视口路由

中间视口是一个按"当前打开对象"分发的路由器:

```ts
type OpenTarget =
  | { kind: 'home' }                    // 今日/工作台
  | { kind: 'space';   id: string }     // → Space 概览(cockpit)
  | { kind: 'moc';     id: string }     // → 有 graph 显示图谱,否则显示 MOC 概览
  | { kind: 'project'; id: string }     // → 项目页(追踪)
  | { kind: 'note';    id: string };    // → 笔记页

// 节点 → 默认打开目标
function targetFor(n: Node): OpenTarget {
  if (n.type === 'moc')     return { kind: 'moc', id: n.id };
  if (n.type === 'map')     return { kind: 'moc', id: n.id }; // map 走图谱视口
  if (n.type === 'project') return { kind: 'project', id: n.id };
  return { kind: 'note', id: n.id };
}
```

### 3.3 启动 & 会话恢复

- **启动**:读 `localStorage['zkw.open']`,恢复上次打开的视口;无记录则默认打开第一个 Space 概览。
- **每次切换视口**:写回 `zkw.open`;非 home 的目标额外写 `zkw.last`(供"今日"页的"继续上次")。
- **Home 是可选目的地,不是闸门** —— 顶栏 `⌂ 今日` 按钮随时可去,但绝不强制开屏。

---

## 4. 各视口详细规格

### 4.1 Home / 今日 (`kind: 'home'`)

跨所有 Space 的聚合工作台。**只读聚合,不是新数据**。

- **继续上次** 卡片:读 `zkw.last`,一键跳回上次视口。
- **下一步 · 跨 Space 待办**:列出所有 `status ∈ {active, blocked}` 的项目,每行显示 `status 药丸 + nextAction + 项目名·Space·更新时间`,点击进项目页。**阻塞项排在最前**(最需要处理)。
- **暂存区待整理**:提示左侧 Scratchpad 有 N 张草稿未归档。

### 4.2 Space 概览 / cockpit (`kind: 'space'`)

打开一个 Space 的默认内容。这是"项目级维护和追踪"的主场。

- **Hero**:Space 名 + 框架 chip + 统计(N 进行中 · M MOC · K 笔记)。
- **框架切换条**:`PARA | 总览·主题·局部 | 自定义` 三个 segmented 按钮。切换立即重分组(下方分区 + 右侧导航树同步)。旁注"同一份数据 · 只换桶和标签"。
- **镜头 tab**:`全部` + 当前框架的各桶,作过滤。
- **三个分区**(按当前镜头过滤后显示):
  - **项目追踪** → 项目卡网格(§4.5)
  - **责任域 / 总览·主题 (MOC)** → MOC 卡(显示聚合数 + 前 5 个被聚合节点)
  - **素材 / 局部知识** → 笔记卡网格

### 4.3 MOC 图谱 (`kind: 'moc'` 且节点含 graph)

思维导图视口。设计规范见 §5,实现参考 `zkw-graph.jsx` 和 `mindmap_v2.html`。

### 4.4 MOC 概览 (`kind: 'moc'` 无 graph)

不带图谱的 MOC:Hero(名 + description + 聚合数)+ "指向此 MOC 的节点"网格(`servedBy` 查询结果),点任意节点跳转。

### 4.5 项目页 (`kind: 'project'`)

完整追踪页。

- **Hero**:项目名 + **可点击的 status 药丸**(点击循环切换状态,见 §6.1)+ 进度% + 更新时间 + 大进度条。
- **下一步 · NEXT ACTION**:醒目卡片(左侧 3px 强调边),展示 `nextAction`。
- **服务于责任域**:`refs` 里的 MOC 列为可点 chip。
- (可扩展)**checklist**:勾选项,进度自动从这里算。

### 4.6 笔记页 (`kind: 'note'`)

笔记正文 + 面包屑(Space › 所属MOC › 笔记)+ "所属责任域" chip。

---

## 5. 图谱视口规格(重点,已迭代多版)

> 这块踩过坑、改过 3 版。务必遵守下列规则,否则会回到"字读不出、层级扁平、连线乱"的老问题。参考 `mindmap_v2.html`。

### 5.1 三档字号/体量层级(强制)

| 层级 | 角色 | 字号 | 视觉 |
|---|---|---|---|
| `lvl 0` | 中心主干 | 21px / 800 / mono | 最大,带微光 box-shadow |
| `lvl 1` | 一级主题 | 15px / 700 | 彩色实底(按 group 着色) |
| `lvl 2` | 二级主题 | 13px / 600 | 深底 + 左侧色条 |
| `lvl 3` | 叶子知识点 | 12px / 500 | 最轻,灰字 + 色条 |

- **画布上只放短标签**,长内容(全文、代码、Read View 四字段等)进**详情 deck**(§7)。这是"贴脸才能读"问题的根治。
- 节点标签 `white-space: nowrap`(避免中文被窄框挤成竖排单字 —— 这是实测过的 bug)。

### 5.2 连线语义(强制统一,配图例)

| 线型 | 含义 | 是否带标签 |
|---|---|---|
| **实线**(按 group 着色) | 层级归属(父→子) | 否 |
| **虚线紫** | 跨主题引用 | 是(药丸标签,如"支撑""解决") |
| **点线琥珀** | 特殊挂载(如面试题) | 否 |

线宽随层级递减(lvl1 ≈ 2.2 / lvl2 ≈ 1.6 / lvl3 ≈ 1.1)。

### 5.3 GraphData 结构

```ts
interface GraphData {
  nodes: GraphNode[];
  xrefs: { from: string; to: string; label: string }[]; // 跨主题引用
}
interface GraphNode {
  id: string;
  label: string;          // 短标签
  sub?: string;           // 小注(如编号/缩写)
  lvl: 0 | 1 | 2 | 3;
  group?: 'g' | 'a' | 'b'; // 着色分组
  x: number; y: number;   // 布局坐标(初版手摆,后续可接力导向布局)
  parent?: string;
  star?: boolean;         // 高亮(如面试题)
  deck?: { title: string; body: string };  // 点击展开的详情
  deckRef?: string;       // 或引用富文本详情库
}
```

### 5.4 图谱交互

- **拖拽平移 + 滚轮缩放**(缩放以光标为锚点)+ 缩放控件 + 复位。
- **点击带详情的节点** → 详情 deck 从右侧滑出。
- (可选,见 `mindmap_v2`)**选中节点高亮整条相关链,其余压暗** —— 一眼看清上下文。
- **深色/浅色主题**:不要反色,建两套平行 token,见 §8.4。

---

## 6. 状态 / 进度 / 下一步 —— 数据来源(关键)

这一节定义"追踪"字段从哪来。**别让机器猜它猜不出的东西。**

| 字段 | 来源 | 自动? |
|---|---|---|
| **status** | 手动 | ❌ 永远手动 |
| **progress** | checklist 完成度 | ✅ 算出 |
| **更新/停滞** | `updatedAt` 时间戳 | ✅ 全自动 |

### 6.1 status —— 手动状态机

`active → blocked → done → archived → (回到 active)`,**点击 status 药丸循环切换**。不要自动推断状态:"阻塞""暂停"是意图,机器推不出,硬猜只会得到不可信的状态。

### 6.2 progress —— 半自动

```ts
function progressOf(p: ProjectNode): number | null {
  if (!p.checklist?.length) return null;  // 没 checklist 就不显示进度条
  return Math.round(p.checklist.filter(i => i.done).length / p.checklist.length * 100);
}
```

**没有 checklist 时不显示进度条** —— 手动拖的百分比没人维护,很快变假数据。

### 6.3 nextAction —— 下一步(最重要的追踪字段)

概念 = GTD 的 **Next Action**:此刻能立即上手的、最具体的一个动作(不是目标,不是清单)。

- **维护成本极低**:每次停下手时顺手写一句"下次从这继续"。唯一需要的纪律。
- **可从 checklist 借**:默认 = 第一个未勾项,允许手动覆盖。
- **完成即清空** → 空 `nextAction` 本身是"该想下一步了"的信号。
- **与 blocked 联动**:阻塞项目的 `nextAction` 应写"解除阻塞的动作"(等什么/找谁要),让阻塞带可执行信息。
- **跨项目扫描**:Home 页把所有项目的 `nextAction` 聚成一份待办 —— 这是把"知识库"变"工作台"的关键一跳。

### 6.4 停滞提醒(可选增强)

`status==='active'` 但 `now - updatedAt > 14d` → 飘一个"是不是该标暂停?"。**机器提醒、人决策**,绝不自动改状态。

---

## 7. 详情 deck(右侧滑出层)

复用现有交互(点节点展开备注/详情),统一到所有视口。

- 从右侧滑入,**覆盖在 Spaces 树之上**,带半透明 scrim。
- 结构:**typed badge**(类型 + 颜色圆点)· 标题 · **面包屑路径** · 富文本正文(支持 `<pre>` 代码块)· pin(钉住)· `关闭 · Esc`。
- `Esc` 关闭;点 scrim 关闭;pin 后点外部不关。
- 富文本来源:节点的 `deck` 字段,或 `deckRef` 指向的富文本库(见 `zkw-data.jsx` 的 `DECK_RICH`)。

> 实现注意:deck 用 `transform: translateX()` 做进出动画。**不要**在动画期间用 `getComputedStyle` 断言位置(会读到中间值);静止态应为 `translateX(0)`。

---

## 8. 视觉系统

### 8.1 设计 token(深色,直接用)

```css
--bg:#08090d; --bg2:#0b0d13; --panel:#0e1018; --panel-2:#13161f; --panel-3:#1a1e2a;
--ink:#eceef3; --ink-dim:#969bab; --ink-faint:#565c6b; --ink-ghost:#363b48;
--rule:rgba(255,255,255,0.07); --rule-2:rgba(255,255,255,0.12); --rule-3:rgba(255,255,255,0.2);
/* 语义色(深色主题:亮变体,在黑底上"发光") */
--violet:#b79dff; --violet-d:#8b6df0;  /* MOC / 品牌 */
--green:#6fce93;   /* project active / 事务组 */
--amber:#f0a857;   /* blocked / 索引组 */
--blue:#6ba3ff;    /* done / 日志组 */
--cyan:#5fd0dd;    /* map / resume */
--sand:#e3c38a;    /* note */
--rose:#ff8a8a;    /* 警示 */
```

字体:`Inter` + `Noto Sans SC`(正文)/ `JetBrains Mono`(编号、元信息、代码)。

### 8.2 类型 → 颜色 → 字形

| 类型 | 颜色 | 字形(CSS 几何,非 emoji) |
|---|---|---|
| space | `--ink` | 旋转 45° 的圆角方块 |
| moc | `--violet` | 空心圆 + 圆心点(◎) |
| project | `--green` | 状态点(实心圆,按 status 着色) |
| note | `--sand` | 小实心圆 |
| map | `--cyan` | 方框 + 横线(地图感) |

> **不用 emoji**(除非品牌明确要求)。字形用 CSS 伪元素画,见 `zk_workspace.html` 的 `.g.*` 类。

### 8.3 类型尺度下限

- 视口正文 ≥ 13px;图谱叶子 ≥ 12px;mono 元信息 ≥ 9px(仅限编号/标签等弱信息)。
- 状态药丸、chip 等小元件统一 `white-space: nowrap`。

### 8.4 浅色主题(若做):平行 token,不反色

颜色在深色里是"发光"、浅色里是"颜料",直接 invert 必丑。规则:

1. **每个语义色存深/浅两个变体**,按主题取值(浅色用暗变体,如 `--green` → `#1f9d57`)。
2. **高光 ↔ 投影对调**:深色用彩色辉光 + inset 白边;浅色用柔和黑投影。
3. **连线/压暗逻辑反转**:深色白线 → 浅色深灰线;压暗时浅色降饱和(opacity ~0.32),不能往白里沉到消失。

参考 `mindmap_v2.html` 的 `.app.light` 实现。

---

## 9. 迁移路径(从现有文件夹结构)

> 核心建议(已与用户确认):**集成进现有底座,不要做成"另一个插件去联动"**。理由:Project→MOC 的关联是指向图谱节点的 link,必须住在图谱住的地方;跨插件引用会把刚用 id 引用解决的"移动失效"问题重新制造一遍。集成 ≠ 全塞核心 —— 用 feature flag 把"追踪视图"做成可开关模块。

### 9.1 一次性迁移脚本(把文件夹 → typed 节点)

1. 每个顶层文件夹 → `SpaceNode`。按其内部结构猜 `framework`(有 Projects/Areas/Resources/Archive → `para`;有 总览/主题/局部 → `overview`;否则 `custom`)。
2. **删除框架骨架空文件夹**(Projects/Areas/… 本身)—— 它们的语义改由 `framework.buckets` 承担。
3. 文件夹里的 MOC 文档 → `MocNode`;`总览` 这类设 `isTop=true`。
4. 原子笔记 → `NoteNode`;思维导图 → `MapNode`。
5. **关系重建**:原来"放在 Areas/X 下"的项目 → 建 `serves` link 指向对应 MOC,而非物理归属。允许一个项目指多个 MOC。
6. `Archive/` 内容 → 对应节点 `status='archived'`(状态翻转,不搬家)。

### 9.2 兼容期

迁移后保留一个"按文件夹查看"的回退视图(= `workspace_redesign.html` 的"现状"模式),让用户对照适应。

---

## 10. 实现里程碑

> 建议顺序,每步可独立验收。

**M1 · 数据层**
- [ ] 定义节点类型 + Link + Framework(§2),落地存储(读写 + id 生成 + `updatedAt` 自动刷新)。
- [ ] `servedBy` 聚合查询 + `targetFor` 路由映射。
- [ ] 迁移脚本(§9.1),含回滚。

**M2 · 三栏壳 + 路由**
- [ ] 三栏布局(左/中/右,可收起为竖条)。
- [ ] 万能视口路由器(§3.2)+ 会话恢复(§3.3)。
- [ ] 顶栏面包屑(可点回退)+ `⌂ 今日` 入口。

**M3 · 导航树 + 框架镜头**
- [ ] 右侧 Spaces 树:Space 行 + 框架 chip + 桶分组 + 节点行(状态点/进度/聚合数)。
- [ ] Space 概览页 + **框架切换条**(切换即重分组,树与概览同步)。

**M4 · 项目追踪**
- [ ] 项目卡 + 项目页 + **可点击 status 状态机**(§6.1)。
- [ ] checklist → 自动 progress(§6.2);nextAction 就地编辑(§6.3)。
- [ ] Home / 今日:跨 Space 待办聚合 + 继续上次。

**M5 · MOC 图谱 + 详情 deck**
- [ ] 图谱视口(三档层级 + 连线语义 + 平移缩放,§5)。
- [ ] 详情 deck(typed badge + 面包屑 + 富文本 + pin + Esc,§7)。
- [ ] (可选)选中高亮链路、浅色主题。

**M6 · 捕获回路**
- [ ] Scratchpad 草稿卡 + 拖拽归档到 MOC/Note。

---

## 附:配套原型文件对照

| 原型文件 | 对应本文档 | 用途 |
|---|---|---|
| `zk_workspace.html` (+ `zkw-*.jsx`) | §3 §4 §7 全部 | **主参考** —— 三栏壳 + 所有视口 + deck,可交互 |
| `workspace_redesign.html` (+ `ws-*.jsx`) | §1 §2.3 | 现状⇄重构对照 + 框架镜头切换 |
| `mindmap_v2.html` | §5 §8.4 | 图谱视口规范 + 深浅主题 token |
| `area_view_v1.html` | §2.5 §6 | MOC 聚合 + 项目状态 早期探索 |

> 原型用 React + inline JSX(CDN)快速验证交互;正式实现按你现有技术栈,数据模型与交互规则以本文档为准。
