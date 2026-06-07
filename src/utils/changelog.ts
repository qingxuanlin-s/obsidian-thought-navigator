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
