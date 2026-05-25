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
