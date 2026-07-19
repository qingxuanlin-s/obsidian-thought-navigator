/**
 * 版本更新公告内容。
 * 在用户首次升级到新版本时,通过 ChangelogModal 展示。
 * 按版本号倒序维护;每个版本只列出"用户可感知的关键变更",不必照搬 git log。
 */

export interface ChangelogEntry {
    version: string;
    date: string;
    highlights: { zh: string; en: string }[];
}

export const CHANGELOG: ChangelogEntry[] = [
    {
        version: '0.3.0',
        date: '2026-07-19',
        highlights: [
            {
                zh: '新增「拖动换父」手势:把节点拖到目标侧边即成为它的子节点,拖到当前父节点正上方即升级为其兄弟(绿框=成子/红框=成兄弟);支持多选批量换父',
                en: 'New drag-to-reparent gesture: drag a node beside a target to nest it as a child, or drag it just above its current parent to promote it to a sibling (green = child / red = sibling); multi-select batch reparenting supported',
            },
            {
                zh: '换父只感知「同一水平行的横向近邻」:在纵向堆叠里上下拖动排序不再误触换父,只有真正沿生长方向靠到某节点侧边才会挂接',
                en: 'Reparenting now only senses horizontal neighbors on the same row: reordering nodes up/down within a vertical stack no longer misfires — attachment happens only when you approach a node from its growth side',
            },
            {
                zh: '未连线的自由节点(不再仅限占位符)拖近另一节点也能自动挂为子节点',
                en: 'Unconnected free nodes (no longer just placeholders) can also auto-attach as a child when dragged near another node',
            },
            {
                zh: '工作区新增「导入已有项目」:把库中已有的项目文件批量导入某个 Space 并自动归类',
                en: 'Workspace can now "import existing projects": batch-import existing project files into a Space with automatic classification',
            },
            {
                zh: '修复:拖动分支节点换到对侧时整棵子树跟随翻面生长;修复弱化态角标交互、焦点筛选与折叠联动,以及自动布局换侧后的残留',
                en: 'Fixes: flipping a branch to the opposite side now flips its whole subtree along with it; fixed muted-badge interaction, focus-filter/collapse coupling, and auto-layout side-flip residue',
            },
        ],
    },
    {
        version: '0.2.9',
        date: '2026-07-12',
        highlights: [
            {
                zh: '新建思维树时先输入文件名称，文件夹右键、Notebook Navigator 与编辑器入口行为一致',
                en: 'Creating a mind tree now asks for its file name, consistently across folder menus, Notebook Navigator, and the editor command',
            },
            {
                zh: '修复在深色 Obsidian 中选择插件浅色主题时设置页局部变白的问题',
                en: 'Fixed plugin light mode incorrectly whitening parts of Settings while Obsidian uses a dark theme',
            },
            {
                zh: '移除未使用的 Mermaid/SVG 旧渲染链，图谱统一使用 Cytoscape',
                en: 'Removed the unused legacy Mermaid/SVG rendering path; graphs now consistently use Cytoscape',
            },
        ],
    },
    {
        version: '0.2.5',
        date: '2026-06-28',
        highlights: [
            {
                zh: '全新「工作区」视图取代旧 Space:用 typed-node + link 数据模型,以 PARA / Overview 框架镜头组织多个 Space,内置项目追踪、跨 Space 待办与全库笔记关联;文件夹挂载与抽屉统一收敛到 WorkspaceStore',
                en: 'New "Workspace" view replaces the old Spaces: a typed-node + link data model that organizes multiple Spaces through PARA / Overview framework lenses, with built-in project tracking, cross-Space todos, and vault-wide note linking; folder mounting and drawers are unified into WorkspaceStore',
            },
            {
                zh: '任务首页:原「今日」改名「任务」,可在 今日 / 近7天 / 近30天 / 所有 之间切换时间窗(选择持久化);任务截止时间精确到秒,支持行内多行备注编辑,已开始未截止的区间任务自动进入今天',
                en: 'Task home: the old "Today" is now "Task" with a switchable time window — Today / 7 days / 30 days / All (persisted); task due times go down to the second, inline multi-line notes are editable, and in-progress interval tasks surface under today',
            },
            {
                zh: '侧边栏 Spaces 树的展开 / 折叠状态现在跨重载保留',
                en: 'The Spaces tree expand/collapse state in the sidebar now persists across reloads',
            },
            {
                zh: 'MOC 存储格式从 Mermaid 迁移到 JSON(.moc.md),解析更快更稳,往返一致性更可靠',
                en: 'MOC storage migrated from Mermaid to JSON (.moc.md) for faster, sturdier parsing and more reliable round-trips',
            },
            {
                zh: '跨领域链接改为源节点右下角出口角标(↗),不再物化成虚拟节点;hover 卡可跳转定位或删除',
                en: 'Cross-domain links now show as an outbound badge (↗) on the source node instead of materializing virtual nodes; the hover card can jump-to-locate or delete',
            },
            {
                zh: '节点支持录音嵌入;删除节点时自动回收无引用附件;新增「文件默认打开方式」配置,链接区点击不再误开详情侧栏',
                en: 'Nodes support audio-recording embeds; deleting a node reclaims unreferenced attachments; a new "default file open mode" setting, and clicking the link area no longer opens the detail panel by mistake',
            },
            {
                zh: '新增入门引导弹窗;修复 HTML 导出;感知 MOC 文件重命名并同步更新引用',
                en: 'New getting-started modal; fixed HTML export; MOC file renames are detected and references updated',
            },
            {
                zh: '性能:千节点图谱更顺 —— overlay 低 zoom 门控、文本 Markdown 懒渲染、几何缓存;修复屏外新增节点的 overlay 卡在画布原点',
                en: 'Performance: smoother thousand-node maps — low-zoom overlay gating, lazy text-Markdown rendering, geometry caching; fixed off-screen new-node overlays sticking to the canvas origin',
            },
        ],
    },
    {
        version: '0.1.8',
        date: '2026-06-13',
        highlights: [
            {
                zh: '新增草稿节点:AI/程序产出的节点先以「待审批草稿」形态注入画布,父级实时居中预览,确认后落地、丢弃则原样还原,不污染文件;草稿可直接选中并 Tab/Enter 续建子/兄弟节点',
                en: 'New draft nodes: AI/programmatic output is injected as "pending-approval drafts" with live parent-centered preview — commit to keep, discard to fully restore without touching the file; drafts are selectable and support Tab/Enter to keep building children/siblings',
            },
            {
                zh: '节点详情侧栏:单击节点即跟随展示,概念节点内联编辑富文本备注、文件节点预览正文;支持钉住常驻与拖拽调宽并持久化;标题按富文本渲染(加粗/颜色随主题),备注可划选局部复制并新增一键复制按钮',
                en: 'Node detail panel: single-click a node to follow it — edit rich-text remarks inline on concept nodes, preview note body on file nodes; pin it open and drag-resize with persistence; the title now renders rich text (bold/color follow your theme) and remarks are selectable with a one-click copy button',
            },
            {
                zh: '新增 Nebula 星云主题(暗色深空霓虹 / 浅色冷灰白卡两套),并设为默认风格',
                en: 'New Nebula theme (dark deep-space neon / light cool-grey white-card variants), now the default style',
            },
            {
                zh: '新增只读节点查询 API queryNodes:支持精确 / 模糊 / 取子树,便于脚本与外部工具检索导图',
                en: 'New read-only queryNodes API: exact / fuzzy / subtree lookups for scripting and external tools',
            },
            {
                zh: '搜索框 UI 增强,匹配结果高亮关键词',
                en: 'Search bar UI refresh with keyword highlighting in results',
            },
            {
                zh: '性能与稳定性:大图渲染/拖拽/缩放更顺(overlay 增量复用 + 视口剔除),修复跨 MOC 切换的内存泄露,删除节点不再缩回最小视图,贝塞尔曲线与连线显示优化',
                en: 'Performance & stability: smoother rendering/drag/zoom on large maps (incremental overlay reuse + viewport culling), fixed a memory leak when switching MOCs, deleting a node no longer collapses the viewport, plus bezier/edge rendering tweaks',
            },
            {
                zh: '多项布局与交互修复:收起手柄移出即消失、收起/展开位置错乱、连线小蓝点拖出节点消失、auto 布局新建节点尊重「智能连线」开关',
                en: 'Various layout & interaction fixes: collapse handle vanishing on hover-out, collapse/expand position glitches, the connection dot disappearing when dragged outside a node, and auto-layout new nodes now respecting the "smart connection" toggle',
            },
        ],
    },
    {
        version: '0.1.7',
        date: '2026-06-07',
        highlights: [
            {
                zh: 'Space 增强:支持向空间添加普通笔记(文件选择器),挂载文件夹抽屉的交互与展示同步优化',
                en: 'Spaces: add regular notes into a space via a file picker; the mounted-folder drawer gets matching interaction and display refinements',
            },
            {
                zh: '自动布局:把节点拖出一定距离即「分离」成独立分支自行生长,节点左右侧别固定不再被父级方向弹回;reflow 父级解析重构',
                en: 'Auto-layout: drag a node far enough to "detach" it into an independent branch that grows on its own; a node\'s left/right side stays pinned instead of snapping back to the parent direction; reflow parent resolution rewritten',
            },
            {
                zh: '性能:节点较多时新增/渲染更顺 —— badge overlay 定位去重、collapse 子节点判定改 O(N) 预计算、文本测宽加缓存',
                en: 'Performance: smoother adding/rendering with many nodes — deduped badge-overlay positioning, O(N) precomputed collapse-children check, and cached text width measurement',
            },
            {
                zh: '搜索框:MOC 搜索去掉「项目置顶」分组,统一按编辑时间倒序的单一列表',
                en: 'Search: the MOC search drops the pinned "projects" grouping for a single list sorted by edit time',
            },
            {
                zh: '面包屑:节点名含换行时只显示第一行,避免多行文本把面包屑撑高',
                en: 'Breadcrumb: only the first line of a node title is shown, so multi-line text no longer inflates the breadcrumb height',
            },
            {
                zh: '编辑:文本节点(根/一级)进入编辑时字号与展示态一致;双击不编辑再退出不会让节点逐次变大',
                en: 'Editing: text nodes (root / first-level) keep the same font size in edit and display; double-clicking without editing no longer grows the node each time',
            },
        ],
    },
    {
        version: '0.1.5',
        date: '2026-05-31',
        highlights: [
            {
                zh: '新增 obsidian:// URI 入口:?action=create 创建 .moc、?action=add-node 向父节点追加子节点,支持脚本化/批量生成',
                en: 'New obsidian:// URI: ?action=create makes a .moc, ?action=add-node appends a child to a parent — enabling scripted/batch generation',
            },
            {
                zh: '新增外部 API,可经 Obsidian CLI `obsidian eval` 调用(createMOC / addNode / addNodes),一条命令即可建出整棵关系树',
                en: 'New external API callable via Obsidian CLI `obsidian eval` (createMOC / addNode / addNodes) — build a whole relation tree in one command',
            },
            {
                zh: '自动布局:新建子节点后根节点相对子节点竖直居中;CLI/程序化创建时即算好居中坐标,打开无闪动、间距与手动创建一致',
                en: 'Auto-layout: root now centers vertically against its children after adding nodes; CLI/programmatic creation computes centered positions upfront — no flicker on open and spacing matches manual creation',
            },
        ],
    },
    {
        version: '0.1.4',
        date: '2026-05-25',
        highlights: [
            {
                zh: '修复 Cmd+V 误把 Scratchpad 顶部条目当外部内容粘出:统一调度到外部剪贴板 > 内部节点 > Scratchpad 的优先级',
                en: 'Fix Cmd+V pasting Scratchpad top entry instead of external clipboard: unified priority is now external clipboard > internal nodes > Scratchpad',
            },
            {
                zh: 'Cmd+V 现在支持从系统剪贴板粘贴: 自动识别 [[link]] / ![[embed]] / 纯文本并创建对应节点',
                en: 'Cmd+V now reads system clipboard: auto-detects [[link]] / ![[embed]] / plain text to create matching nodes',
            },
            {
                zh: '在任何文件管理器中右键文件夹(包括 Notebook Navigator)均可"新建 MOC 文件"',
                en: 'Folder right-click in any file manager (including Notebook Navigator) can now create a new MOC file',
            },
            {
                zh: '更新后弹出公告窗口,展示本次版本的关键变更',
                en: 'After plugin update, a changelog popup shows the key changes of this version',
            },
            {
                zh: '自动布局重构: 删除/新建/移动节点后统一走声明式 reflow,自动回收空缺并避免重叠',
                en: 'Auto-layout rewrite: deleting/creating/moving nodes now triggers declarative reflow that reclaims gaps and avoids overlaps',
            },
        ],
    },
    {
        version: '0.1.3',
        date: '2026-05-25',
        highlights: [
            {
                zh: 'Cmd+V 现在支持从系统剪贴板粘贴: 自动识别 [[link]] / ![[embed]] / 纯文本并创建对应节点',
                en: 'Cmd+V now reads system clipboard: auto-detects [[link]] / ![[embed]] / plain text to create matching nodes',
            },
            {
                zh: '在任何文件管理器中右键文件夹(包括 Notebook Navigator)均可"新建 MOC 文件"',
                en: 'Folder right-click in any file manager (including Notebook Navigator) can now create a new MOC file',
            },
            {
                zh: '更新后弹出公告窗口,展示本次版本的关键变更',
                en: 'After plugin update, a changelog popup shows the key changes of this version',
            },
        ],
    },
    {
        version: '0.1.2',
        date: '2026-05-25',
        highlights: [
            {
                zh: '自动布局重构: 删除/新建/移动节点后统一走声明式 reflow,自动回收空缺并避免重叠',
                en: 'Auto-layout rewrite: deleting/creating/moving nodes now triggers declarative reflow that reclaims gaps and avoids overlaps',
            },
        ],
    },
    {
        version: '0.1.1',
        date: '2026-04-12',
        highlights: [
            { zh: '修复旧文本节点高度压缩问题', en: 'Fix legacy text node height compression issue' },
        ],
    },
];

/**
 * 比较两个版本号 (semver-lite): 返回 a < b 时 -1, a === b 时 0, a > b 时 1
 */
export function compareVersion(a: string, b: string): number {
    const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
    const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const av = pa[i] ?? 0;
        const bv = pb[i] ?? 0;
        if (av < bv) return -1;
        if (av > bv) return 1;
    }
    return 0;
}

/**
 * 取出 lastShown 之后(不含)到 current(含)之间的所有 changelog 条目,按倒序返回。
 * lastShown 为空字符串(新安装 / 老用户首次升级到带 changelog 字段的版本)时,
 * 只返回当前版本对应的那一条,让用户也能看到新版的关键变更。
 */
export function getUnreadEntries(lastShown: string, current: string): ChangelogEntry[] {
    if (!lastShown) {
        return CHANGELOG.filter((entry) => entry.version === current);
    }
    return CHANGELOG.filter(
        (entry) => compareVersion(entry.version, lastShown) > 0
            && compareVersion(entry.version, current) <= 0
    );
}
