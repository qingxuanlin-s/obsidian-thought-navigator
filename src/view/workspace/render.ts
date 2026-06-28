import { App, TFile, setIcon } from "obsidian";
import { t, TKey } from "src/lang/helper";
import { WorkspaceStore, progressOf } from "src/workspace/WorkspaceStore";
import { ProjectTaskStore } from "src/workspace/projectTasks";
import { OpenTarget, WorkspaceNode, WSNodeType, WSProjectNode, ProjectStatus, FrameworkId } from "src/types/workspace";

/** 各视口渲染器拿到的上下文 */
export interface RenderCtx {
    app: App;
    store: WorkspaceStore;
    /** 项目 next action 任务(读自项目背书笔记的 `- [ ]`)缓存 */
    tasks: ProjectTaskStore;
    /** 工作区项目背书笔记所在文件夹(新建任务笔记落点) */
    projectFolderPath: string;
    /** 新建任务/子任务时自动插在 `[ ]` 后的前缀字符(如 "🎯 ");空则不加 */
    taskPrefix: string;
    /** 在中间视口打开一个目标(MOC 带图谱时会甩出面板切到图谱模式) */
    open(target: OpenTarget): void;
    /** 在中间视口打开目标,但始终留在面板内渲染(不甩去图谱) */
    openInline(target: OpenTarget): void;
    /** 右侧滑出详情 deck */
    openDeck(node: WorkspaceNode): void;
    /** 打开一个文件笔记。按宿主的「文件默认打开方式」设置打开,绝不覆盖思维树图谱;
     *  无宿主(独立工作区视图)时退化为在当前 leaf 打开。forceTab=true 时强制新标签页。 */
    openFile(file: TFile, forceTab?: boolean): void;
    /** 打开一个 wiki 链接(任务文本里的 [[..]] 等)。同样走宿主的默认打开方式,绝不覆盖图谱。 */
    openLink(linkText: string, sourcePath?: string, forceTab?: boolean): void;
    /** 删除条目(节点 + 容器子树):二次确认 → store.deleteSubtree → 必要时退回首页 */
    requestDelete(node: WorkspaceNode): void;
    /** 重渲染中间视口 + 侧栏(异步任务加载完成 / 文件外部变动后调用) */
    refresh(): void;
}

/**
 * 项目进度:手动 progress 覆盖 → 背书笔记 `- [ ]` 已勾/总数 → checklist 兜底。
 * 任务源是 markdown,需经 ctx.tasks 缓存读取(同步,缺失时后台加载并触发 refresh)。
 */
export function progressFor(ctx: RenderCtx, p: WSProjectNode): number | null {
    if (typeof p.progress === 'number') return Math.max(0, Math.min(100, p.progress));
    const counts = ctx.tasks.counts(p.filePath);
    if (counts && counts.total > 0) return Math.round(counts.done / counts.total * 100);
    return progressOf(p.checklist);
}

/** 卡片/Home/deck 上的「下一步」摘要:背书笔记首个未勾任务 → 兜底旧 nextAction */
export function nextActionText(ctx: RenderCtx, p: WSProjectNode): string | null {
    const first = ctx.tasks.firstUnchecked(p.filePath);
    if (first) return first.text;
    return p.nextAction || null;
}

/** 把含 `[[wikilink]]` 的任务正文渲染成可点链接 + 纯文本 */
export function renderTaskText(parent: HTMLElement, ctx: RenderCtx, text: string): void {
    const re = /\[\[([^\]]+)\]\]/g;
    let last = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) parent.appendText(text.slice(last, m.index));
        const target = m[1].split('|')[0].trim();
        const shown = (m[1].includes('|') ? m[1].split('|')[1] : m[1]).trim();
        const link = parent.createSpan({ cls: 'ws-tasklink', text: shown });
        link.onclick = (e) => { e.stopPropagation(); ctx.openLink(target, '', e.ctrlKey || e.metaKey); };
        last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendText(text.slice(last));
}

/** 节点类型 → 主题色变量 */
export const TYPE_COLOR: Record<WSNodeType, string> = {
    space: 'var(--ink)',
    moc: 'var(--violet)',
    project: 'var(--green)',
    note: 'var(--sand)',
    map: 'var(--cyan)',
};

/** 节点类型 → CSS 字形 class(原型 .g.*) */
export const GLYPH_CLASS: Record<WSNodeType, string> = {
    space: 'space', moc: 'moc', project: 'proj', note: 'note', map: 'map',
};

/** 节点类型 → lucide 图标名(与 Spaces 抽屉保持一致) */
export const GLYPH_ICON: Record<WSNodeType, string> = {
    space: 'diamond', moc: 'git-branch', project: 'target', note: 'file-text', map: 'git-fork',
};

export const STATUS_COLOR: Record<ProjectStatus, string> = {
    todo: 'var(--ink-dim)', active: 'var(--green)', blocked: 'var(--amber)', done: 'var(--blue)', archived: 'var(--ink-faint)',
};

/** 状态文案(i18n) */
export function statusLabel(s: ProjectStatus): string {
    return t(`ws status ${s}` as TKey);
}

/** 框架完整名 / 短标签 / 桶名(i18n) */
export function fwLabel(id: FrameworkId): string { return t(`ws fw label ${id}` as TKey); }
export function fwChip(id: FrameworkId): string { return t(`ws fw chip ${id}` as TKey); }
export function bucketLabel(bucketId: string): string { return t(`ws bucket ${bucketId}` as TKey); }

/** 相对时间(i18n) */
export function relTime(ts: number): string {
    const diff = Date.now() - ts;
    const day = 86400000;
    if (diff < day) return t('ws time today');
    if (diff < 2 * day) return t('ws time yesterday');
    if (diff < 7 * day) return t('ws time days').replace('{n}', String(Math.floor(diff / day)));
    if (diff < 30 * day) return t('ws time weeks').replace('{n}', String(Math.floor(diff / (7 * day))));
    if (diff < 365 * day) return t('ws time months').replace('{n}', String(Math.floor(diff / (30 * day))));
    return t('ws time years').replace('{n}', String(Math.floor(diff / (365 * day))));
}

/**
 * 可跳转面包屑:沿容器链(root Space → … → node)渲染每一段为可点击。
 * 点击 = 面板内导航到该段(openInline,不甩去图谱)。
 */
export function renderCrumb(parent: HTMLElement, ctx: RenderCtx, node: WorkspaceNode): HTMLElement {
    const cr = parent.createDiv({ cls: 'ck-crumb' });
    const chain: WorkspaceNode[] = [];
    const seen = new Set<string>();
    let cur: WorkspaceNode | undefined = node;
    while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        chain.unshift(cur);
        const pid = ctx.store.parentContainerOf(cur.id);
        cur = pid ? (ctx.store.getNode(pid) || undefined) : undefined;
    }
    chain.forEach((n, i) => {
        if (i > 0) cr.createSpan({ cls: 'cs', text: ' › ' });
        const seg = cr.createSpan({ cls: 'crumb-seg', text: n.title });
        seg.setCssStyles({ cursor: 'pointer' });
        seg.onclick = () => ctx.openInline(ctx.store.targetFor(n));
    });
    return cr;
}

/** 类型图标:<span class="g"> + lucide 图标(对齐 Spaces 抽屉),着色为类型色 */
export function glyph(parent: HTMLElement, type: WSNodeType, color?: string): HTMLElement {
    const g = parent.createSpan({ cls: 'g' });
    g.setCssStyles({ color: color || TYPE_COLOR[type] });
    setIcon(g, GLYPH_ICON[type]);
    return g;
}
