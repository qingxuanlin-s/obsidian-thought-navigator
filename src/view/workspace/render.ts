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
    /** 是否在新建/编辑任务时自动补任务前缀;关闭时任务行显示手动打标动作 */
    taskPrefixAuto: boolean;
    /** 新建项目背书笔记时自动写入的 tag;空则不加 */
    taskFileTag: string;
    /** 打开一个目标。文件节点交给 Obsidian 原生视图，工作区节点留在中间视口。 */
    open(target: OpenTarget, forceTab?: boolean): void;
    /** 在中间视口打开目标,但始终留在面板内渲染(不甩去图谱) */
    openInline(target: OpenTarget): void;
    /** 右侧滑出详情 deck */
    openDeck(node: WorkspaceNode): void;
    /** 打开一个文件笔记。按宿主的「文件默认打开方式」设置打开,绝不覆盖思维树图谱;
     *  无宿主(独立工作区视图)时退化为在当前 leaf 打开。forceTab=true 时强制新标签页。 */
    openFile(file: TFile, forceTab?: boolean): void;
    /** 打开一个 wiki 链接(任务文本里的 [[..]] 等)。同样走宿主的默认打开方式,绝不覆盖图谱。 */
    openLink(linkText: string, sourcePath?: string, forceTab?: boolean): void;
    /** 删除条目；共享节点传入当前 Space 时仅解除该 Space 绑定。 */
    requestDelete(node: WorkspaceNode, spaceId?: string): void;
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

type TaskTextToken =
    | { kind: 'wiki'; raw: string; target: string; label: string }
    | { kind: 'url'; raw: string; href: string; label: string };

const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;
const MARKDOWN_LINK_RE = /\[([^\]\n]+)\]\(((?:https?:\/\/|obsidian:\/\/|mailto:)[^\s)]+)\)/gi;
const URL_RE = /\b(?:https?:\/\/|obsidian:\/\/|mailto:)[^\s<>"')\]]+/gi;
const TRAILING_URL_PUNCT_RE = /[.,;:!?]+$/;

function trimUrlToken(raw: string): { href: string; trailing: string } {
    let href = raw;
    let trailing = '';
    while (href.length > 0) {
        const last = href[href.length - 1];
        if (TRAILING_URL_PUNCT_RE.test(last)) {
            trailing = last + trailing;
            href = href.slice(0, -1);
            continue;
        }
        if (last === ')' && (href.match(/\(/g)?.length ?? 0) < (href.match(/\)/g)?.length ?? 0)) {
            trailing = last + trailing;
            href = href.slice(0, -1);
            continue;
        }
        break;
    }
    return { href, trailing };
}

function nextTaskTextToken(text: string, start: number): TaskTextToken | null {
    WIKI_LINK_RE.lastIndex = start;
    MARKDOWN_LINK_RE.lastIndex = start;
    URL_RE.lastIndex = start;

    const wm = WIKI_LINK_RE.exec(text);
    const mm = MARKDOWN_LINK_RE.exec(text);
    const um = URL_RE.exec(text);
    let bestIndex = Number.POSITIVE_INFINITY;
    let bestToken: TaskTextToken | null = null;

    if (wm) {
        const parts = wm[1].split('|');
        const target = (parts[0] || '').trim();
        const label = (parts[1] || target).trim();
        bestIndex = wm.index;
        bestToken = { kind: 'wiki', raw: wm[0], target, label: label || target };
    }
    if (mm && mm.index < bestIndex) {
        bestIndex = mm.index;
        bestToken = { kind: 'url', raw: mm[0], href: mm[2], label: mm[1].trim() || mm[2] };
    }
    if (um && um.index < bestIndex) {
        const { href, trailing } = trimUrlToken(um[0]);
        bestToken = { kind: 'url', raw: href, href, label: href };
        if (trailing) {
            // Keep punctuation outside the clickable span.
            URL_RE.lastIndex -= trailing.length;
        }
    }
    return bestToken;
}

/** 把含 `[[wikilink]]` / URL 的任务正文渲染成可点链接 + 纯文本 */
export function renderTaskText(parent: HTMLElement, ctx: RenderCtx, text: string): void {
    let pos = 0;
    while (pos < text.length) {
        const token = nextTaskTextToken(text, pos);
        if (!token) break;
        const index = text.indexOf(token.raw, pos);
        if (index < 0) break;
        if (index > pos) parent.appendText(text.slice(pos, index));
        const link = parent.createSpan({
            cls: 'ws-tasklink',
            text: token.label,
        });
        if (token.kind === 'wiki') {
            link.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (token.target) ctx.openLink(token.target, '', e.ctrlKey || e.metaKey);
            };
        } else {
            link.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.open(token.href, '_blank');
            };
        }
        pos = index + token.raw.length;
    }
    if (pos < text.length) parent.appendText(text.slice(pos));
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

export function renderWorkspaceFileSummary(parent: HTMLElement, file: TFile): HTMLElement {
    const path = file.path.toLowerCase();
    const kind = path.endsWith('.canvas')
        ? 'Canvas'
        : path.endsWith('.excalidraw.md') || path.endsWith('.excalidraw')
            ? 'Excalidraw'
            : path.endsWith('.moc.md') || path.endsWith('.moc')
                ? 'MOC'
                : file.extension.toUpperCase() || t('ws file');
    const summary = parent.createDiv({ cls: 'ws-file-summary' });
    const addRow = (label: string, value: string) => {
        const row = summary.createDiv({ cls: 'ws-file-row' });
        row.createSpan({ cls: 'ws-file-label', text: label });
        row.createSpan({ cls: 'ws-file-value', text: value });
    };
    addRow(t('ws file type'), kind);
    addRow(t('ws file path'), file.path);
    addRow(t('ws updated'), relTime(file.stat.mtime));
    summary.createDiv({ cls: 'ws-file-hint', text: t('ws native view hint') });
    return summary;
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
