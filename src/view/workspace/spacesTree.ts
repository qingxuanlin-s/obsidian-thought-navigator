import { Menu, TFile, setIcon } from "obsidian";
import { WSSpaceNode, WorkspaceNode, WSProjectNode, FRAMEWORKS, OpenTarget, isWorkspaceNodeArchived } from "src/types/workspace";
import { t } from "src/lang/helper";
import { RenderCtx, glyph, fwChip, bucketLabel, STATUS_COLOR, progressFor } from "./render";

function displayNodeTitle(n: WorkspaceNode): string {
    const path = (n as { filePath?: string }).filePath;
    if (!path || n.type !== 'note') return n.title;
    const fileName = path.split('/').pop() || path;
    const isMocPreview = /\.moc(?:\.md)?\.png$/i.test(fileName);
    return isMocPreview && n.title === fileName.replace(/\.[^.]+$/, '') ? fileName : n.title;
}

const FW_CLASS: Record<string, string> = { para: 'para', overview: 'overview', custom: 'custom' };
const LS_COLLAPSED = "zkw.tree.collapsed";

/**
 * 左侧 rail 的 Spaces 导航树。
 * 结构:Space(可折叠)→ 框架桶 → 节点;节点若有子节点(partOf/childMoc 指向它)
 * 则带 chevron 递归嵌套缩进,形成大纲树。
 */
export class SpacesTree {
    private collapsed = new Set<string>();
    private current: OpenTarget | null = null;

    constructor(private container: HTMLElement, private ctx: RenderCtx) {
        this.load();
    }

    /** 折叠状态持久化:跨面板重建 / 重载存活(对应 LS_OPEN/LS_RAIL 同机制) */
    private load() {
        try {
            const raw = this.ctx.app.loadLocalStorage(LS_COLLAPSED) as string | null;
            if (raw) {
                const arr = JSON.parse(raw) as string[];
                if (Array.isArray(arr)) this.collapsed = new Set(arr);
            }
        } catch {}
    }

    private save() {
        try { this.ctx.app.saveLocalStorage(LS_COLLAPSED, JSON.stringify([...this.collapsed])); } catch {}
    }

    setCurrent(t: OpenTarget | null) { this.current = t; }

    /** 展开到目标:沿 Space → 桶 → 结构父链逐级展开,使目标节点在树里可见(只展开不折叠) */
    revealTarget(t: OpenTarget | null) {
        if (!t || t.kind === 'home' || !('id' in t)) return;
        if (t.kind === 'space') { this.collapsed.delete('space:' + t.id); this.save(); return; }
        const node = this.ctx.store.getNode(t.id);
        if (!node || node.type === 'space') return;
        const spaceId = node.spaceId;
        this.collapsed.delete('space:' + spaceId);
        const space = this.ctx.store.getNode(spaceId);
        const fw = space?.type === 'space' ? FRAMEWORKS[(space as WSSpaceNode).framework] : null;
        const bucket = fw?.buckets.find(b => b.match(node));

        // 沿同一桶内的结构父链向上展开；父节点属于别的桶时，当前节点就是本桶根。
        // 归档资源仍保留 partOf 关系，但会在 Archive 根部显示，不能继续展开原 Areas 桶。
        const inSpace = new Set(this.ctx.store.nodesInSpace(spaceId).map(n => n.id));
        const parentOf = (id: string): string | null => {
            const link = this.ctx.store.linksFrom(id)
                .find(l => (l.type === 'partOf' || l.type === 'childMoc') && inSpace.has(l.to));
            return link ? link.to : null;
        };
        let cur: string | null = node.id;
        let root = node.id;
        const guard = new Set<string>();
        while (cur && !guard.has(cur)) {
            guard.add(cur);
            root = cur;
            const p = parentOf(cur);
            const parentNode = p ? this.ctx.store.getNode(p) : null;
            if (!p || !parentNode || (bucket && !bucket.match(parentNode))) break;
            this.collapsed.delete('node:' + p);
            cur = p;
        }

        // 根节点所属的框架桶
        const rootNode = this.ctx.store.getNode(root);
        const rootBucket = bucket || (rootNode ? fw?.buckets.find(b => b.match(rootNode)) : undefined);
        if (rootBucket) {
            this.collapsed.delete(`bucket:${spaceId}:${rootBucket.id}`);
        }
        this.save();
    }

    private isCurrent(id: string): boolean {
        return !!this.current && 'id' in this.current && this.current.id === id;
    }

    private toggle(key: string) {
        if (this.collapsed.has(key)) this.collapsed.delete(key);
        else this.collapsed.add(key);
        this.save();
        this.render();
    }
    private isOpen(key: string) { return !this.collapsed.has(key); }

    ensureDefaultExpanded() { /* collapsed 为空 = 全部展开 */ }

    /** 枚举当前所有可折叠的 key(Space / 桶 / 有子节点的节点) */
    private allCollapsibleKeys(): string[] {
        const keys: string[] = [];
        for (const space of this.ctx.store.getSpaces()) {
            keys.push('space:' + space.id);
            const nodes = this.ctx.store.nodesInSpace(space.id);
            const parentMap = this.buildParentMap(space.id);
            const fw = FRAMEWORKS[space.framework];
            for (const bucket of fw.buckets) {
                const bucketNodes = nodes.filter(bucket.match);
                const bucketIds = new Set(bucketNodes.map(n => n.id));
                const roots = bucketNodes.filter(n => {
                    const parentIds = parentMap.get(n.id) ?? [];
                    return parentIds.every(id => !bucketIds.has(id));
                });
                if (roots.length) keys.push(`bucket:${space.id}:${bucket.id}`);
                for (const n of bucketNodes) {
                    if (bucketNodes.some(c => parentMap.get(c.id)?.includes(n.id))) keys.push('node:' + n.id);
                }
            }
        }
        return keys;
    }

    /** 一键:全部已折叠则展开,否则折叠全部 */
    toggleCollapseAll() {
        const keys = this.allCollapsibleKeys();
        const allCollapsed = keys.length > 0 && keys.every(k => this.collapsed.has(k));
        if (allCollapsed) this.collapsed.clear();
        else this.collapsed = new Set(keys);
        this.save();
        this.render();
    }

    /** 当前是否处于"全部折叠"态(给按钮图标用) */
    isAllCollapsed(): boolean {
        const keys = this.allCollapsibleKeys();
        return keys.length > 0 && keys.every(k => this.collapsed.has(k));
    }

    render() {
        this.container.empty();
        const spaces = this.ctx.store.getSpaces();
        if (!spaces.length) {
            this.container.createDiv({ cls: 'empty', text: t('ws no members') }).setCssStyles({ padding: '10px 14px' });
            return;
        }
        for (const space of spaces) this.renderSpace(space);
    }

    /** 某 Space 内:nodeId → 全部结构父 id(partOf / childMoc 的目标)。 */
    private buildParentMap(spaceId: string): Map<string, string[]> {
        const inSpace = new Set(this.ctx.store.nodesInSpace(spaceId).map(n => n.id));
        const parent = new Map<string, string[]>();
        for (const id of inSpace) {
            const parentIds = this.ctx.store.linksFrom(id)
                .filter(l => (l.type === 'partOf' || l.type === 'childMoc') && inSpace.has(l.to))
                .map(l => l.to);
            parent.set(id, parentIds);
        }
        return parent;
    }

    private renderSpace(space: WSSpaceNode) {
        const skey = 'space:' + space.id;
        const open = this.isOpen(skey);

        const sel = this.isCurrent(space.id);
        const srow = this.container.createDiv({ cls: 'srow' + (open ? ' open' : '') + (sel ? ' sel' : '') });
        const caret = srow.createSpan({ cls: 'caret', text: '▶' });
        caret.onclick = (e) => { e.stopPropagation(); this.toggle(skey); };
        // 仅当前选中的 Space 用主题紫,其余走灰,避免满屏紫菱形抢视线
        glyph(srow, 'space', sel ? (space.color || 'var(--violet)') : 'var(--ink-faint)');
        srow.createSpan({ cls: 'nm', text: space.title });
        srow.createSpan({ cls: `fwchip fw ${FW_CLASS[space.framework]}`, text: fwChip(space.framework) });
        // 点 Space 名 → 打开 cockpit 并确保展开
        srow.onclick = () => { this.collapsed.delete(skey); this.ctx.open({ kind: 'space', id: space.id }); };
        srow.oncontextmenu = (e) => this.showMenu(e, space);
        if (!open) return;

        const nodes = this.ctx.store.nodesInSpace(space.id);
        const parentMap = this.buildParentMap(space.id);
        const fw = FRAMEWORKS[space.framework];

        for (const bucket of fw.buckets) {
            // 桶内按同类父子关系递归；父节点落在别的桶时，当前节点提升为本桶根节点。
            // 这样资源归档后不会继续显示在原 Area 下，也不会因仍保留 partOf 关系而从 Archive 消失。
            const bucketNodes = nodes.filter(bucket.match);
            const bucketIds = new Set(bucketNodes.map(n => n.id));
            const childrenOf = (id: string) => bucketNodes.filter(n => parentMap.get(n.id)?.includes(id));
            const roots = bucketNodes.filter(n => {
                const parentIds = parentMap.get(n.id) ?? [];
                return parentIds.every(id => !bucketIds.has(id));
            });
            if (!roots.length) continue;
            const bkey = `bucket:${space.id}:${bucket.id}`;
            const bopen = this.isOpen(bkey);
            const cur = this.current;
            const lensSel = !!cur && cur.kind === 'space' && cur.id === space.id && cur.lens === bucket.id;
            const b = this.container.createDiv({ cls: 'bucket' + (lensSel ? ' sel' : '') });
            const bcaret = b.createSpan({ cls: 'caret' + (bopen ? ' open' : '') });
            bcaret.setText('▶');
            bcaret.onclick = (e) => { e.stopPropagation(); this.toggle(bkey); };
            b.createSpan({ cls: 'bl', text: bucketLabel(bucket.id) });
            b.createSpan({ cls: 'bc', text: String(roots.length) });
            b.createSpan({ cls: 'bline' });
            // 点桶标签 → 打开 cockpit 并聚焦该桶(lens)
            b.onclick = () => this.ctx.open({ kind: 'space', id: space.id, lens: bucket.id });
            if (!bopen) continue;
            roots.forEach(n => this.renderNode(n, 2, childrenOf, null, space.id));
        }
    }

    private renderNode(n: WorkspaceNode, depth: number, childrenOf: (id: string) => WorkspaceNode[], parentContainerId: string | null, spaceId: string) {
        const kids = childrenOf(n.id);
        const nkey = 'node:' + n.id;
        const open = this.isOpen(nkey);

        const row = this.container.createDiv({
            cls: `nrow depth-${Math.min(depth, 6)}${kids.length ? ' has-children' : ''}${this.isCurrent(n.id) ? ' sel' : ''}`
        });
        row.setCssStyles({ paddingLeft: `${14 + depth * 16}px` });
        row.dataset.depth = String(depth);

        // 嵌套层级的 1px 竖向缩进引导线(桶根节点 depth=2 不画)
        if (depth > 2) {
            const guide = row.createSpan({ cls: 'nguide' });
            guide.setCssStyles({ left: `${7 + depth * 16}px` });
        }

        const caret = row.createSpan({ cls: 'caret' + (open ? ' open' : '') + (kids.length ? '' : ' leaf') });
        caret.setText('▶');
        caret.onclick = (e) => { e.stopPropagation(); if (kids.length) this.toggle(nkey); };

        glyph(row, n.type);
        const nm = row.createSpan({ cls: 'nm' + (n.type === 'note' || n.type === 'map' ? ' dim' : '') });
        nm.setText(displayNodeTitle(n));

        if (n.type === 'project') {
            const p = n as WSProjectNode;
            row.createSpan({ cls: `sd ${p.status}` });
            const pct = progressFor(this.ctx, p);
            if (pct !== null) {
                const pg = row.createDiv({ cls: 'npg' });
                pg.createEl('i').setCssStyles({
                    width: `${pct}%`,
                    background: `${STATUS_COLOR[p.status]}`,
                });
            }
        } else if (n.type === 'moc') {
            const agg = this.ctx.store.servedBy(n.id).length;
            if (agg) row.createSpan({ cls: 'mcount', text: String(agg) });
        }

        const sourceAction = this.sourceAction(n);
        if (sourceAction) {
            const openSource = row.createEl('button', { cls: 'nrow-source', attr: { 'aria-label': sourceAction.title } });
            setIcon(openSource, sourceAction.icon);
            openSource.setAttribute('title', sourceAction.title);
            openSource.onclick = (event) => {
                event.stopPropagation();
                this.ctx.openInline(this.ctx.store.targetFor(n));
                this.openSource(n, event.metaKey || event.ctrlKey);
            };
        }

        // 树行用于工作区内导航；打开源文件 / 图谱由右侧动作或 Cmd/Ctrl 点击完成。
        row.onclick = (event) => {
            this.ctx.openInline(this.ctx.store.targetFor(n));
            if (event.metaKey || event.ctrlKey) this.openSource(n, true);
        };
        row.oncontextmenu = (e) => this.showMenu(e, n, parentContainerId, spaceId);

        if (open && kids.length) kids.forEach(k => this.renderNode(k, depth + 1, childrenOf, n.id, spaceId));
    }

    /** 节点在左树中的显式“打开源内容”动作；没有可打开文件时不显示。 */
    private sourceAction(n: WorkspaceNode): { icon: string; title: string } | null {
        const filePath = (n as { filePath?: string }).filePath;
        if (!filePath) return null;
        if (n.type === 'moc' || n.type === 'map') return { icon: 'git-fork', title: t('ws open graph') };
        const file = this.ctx.app.vault.getAbstractFileByPath(filePath);
        return file instanceof TFile ? { icon: 'external-link', title: t('ws open file') } : null;
    }

    private openSource(n: WorkspaceNode, forceTab = false) {
        const filePath = (n as { filePath?: string }).filePath;
        if (!filePath) return;
        if (n.type === 'moc' || n.type === 'map') {
            this.ctx.open({ kind: 'moc', id: n.id }, forceTab);
            return;
        }
        const file = this.ctx.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) this.ctx.openFile(file, forceTab);
    }

    /** 行右键菜单:打开 / (容器内节点)移出容器 / 删除 */
    private showMenu(e: MouseEvent, n: WorkspaceNode, parentContainerId: string | null = null, spaceId?: string) {
        e.preventDefault();
        e.stopPropagation();
        const menu = new Menu();
        menu.addItem(i => i.setTitle(t('ws view workspace')).setIcon('panel-right-open')
            .onClick(() => this.ctx.openInline(this.ctx.store.targetFor(n))));
        const sourceAction = this.sourceAction(n);
        if (sourceAction) {
            menu.addItem(i => i.setTitle(sourceAction.title).setIcon(sourceAction.icon)
                .onClick(() => this.openSource(n)));
        }
        if (n.type !== 'space') {
            const archived = isWorkspaceNodeArchived(n);
            menu.addItem(i => i.setTitle(t(archived ? 'ws restore archive' : 'ws archive'))
                .setIcon(archived ? 'archive-restore' : 'archive')
                .onClick(() => { void this.ctx.store.setArchived(n.id, !archived); }));
        }
        // 挂在某 MOC 容器下的节点:提供「移出容器」浮回所在 Space 顶层(非删除)
        if (n.type !== 'space' && this.ctx.store.linksFrom(n.id)
            .some(l => (l.type === 'partOf' || l.type === 'childMoc' || l.type === 'serves'))) {
            menu.addItem(i => i.setTitle(t('ws unmount')).setIcon('log-out')
                .onClick(async () => { await this.ctx.store.unmountFromContainer(n.id, parentContainerId ?? undefined); }));
        }
        menu.addSeparator();
        menu.addItem(i => { (i as { setWarning?(warning: boolean): void }).setWarning?.(true); i.setTitle(t('ws delete')).setIcon('trash-2')
            .onClick(() => this.ctx.requestDelete(n, spaceId)); });
        menu.showAtMouseEvent(e);
    }
}
