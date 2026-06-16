import { App } from "obsidian";
import { t } from "src/lang/helper";
import { WorkspaceStore } from "src/workspace/WorkspaceStore";
import { OpenTarget, WorkspaceNode, WSNodeType, ProjectStatus, FrameworkId } from "src/types/workspace";

/** 各视口渲染器拿到的上下文 */
export interface RenderCtx {
    app: App;
    store: WorkspaceStore;
    /** 在中间视口打开一个目标 */
    open(target: OpenTarget): void;
    /** 右侧滑出详情 deck */
    openDeck(node: WorkspaceNode): void;
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

export const STATUS_COLOR: Record<ProjectStatus, string> = {
    todo: 'var(--ink-dim)', active: 'var(--green)', blocked: 'var(--amber)', done: 'var(--blue)', archived: 'var(--ink-faint)',
};

/** 状态文案(i18n) */
export function statusLabel(s: ProjectStatus): string {
    return t(`ws status ${s}` as any);
}

/** 框架完整名 / 短标签 / 桶名(i18n) */
export function fwLabel(id: FrameworkId): string { return t(`ws fw label ${id}` as any); }
export function fwChip(id: FrameworkId): string { return t(`ws fw chip ${id}` as any); }
export function bucketLabel(bucketId: string): string { return t(`ws bucket ${bucketId}` as any); }

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

/** CSS 类型字形:<span class="g {glyph}"> 着色为类型色 */
export function glyph(parent: HTMLElement, type: WSNodeType, color?: string): HTMLElement {
    const g = parent.createSpan({ cls: `g ${GLYPH_CLASS[type]}` });
    g.style.color = color || TYPE_COLOR[type];
    return g;
}
