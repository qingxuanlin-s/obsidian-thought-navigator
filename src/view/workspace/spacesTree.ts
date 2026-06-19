import { Menu } from "obsidian";
import { WSSpaceNode, WorkspaceNode, WSProjectNode, FRAMEWORKS, OpenTarget } from "src/types/workspace";
import { t } from "src/lang/helper";
import { RenderCtx, glyph, fwChip, bucketLabel, STATUS_COLOR, progressFor } from "./render";

const FW_CLASS: Record<string, string> = { para: 'para', overview: 'overview', custom: 'custom' };

/**
 * 左侧 rail 的 Spaces 导航树。
 * 结构:Space(可折叠)→ 框架桶 → 节点;节点若有子节点(partOf/childMoc 指向它)
 * 则带 chevron 递归嵌套缩进,形成大纲树。
 */
export class SpacesTree {
    private collapsed = new Set<string>();
    private current: OpenTarget | null = null;

    constructor(private container: HTMLElement, private ctx: RenderCtx) {}

    setCurrent(t: OpenTarget | null) { this.current = t; }

    private isCurrent(id: string): boolean {
        return !!this.current && 'id' in this.current && this.current.id === id;
    }

    private toggle(key: string) {
        this.collapsed.has(key) ? this.collapsed.delete(key) : this.collapsed.add(key);
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
                const roots = nodes.filter(n => bucket.match(n) && parentMap.get(n.id) == null);
                if (roots.length) keys.push(`bucket:${space.id}:${bucket.id}`);
            }
            for (const n of nodes) {
                if (nodes.some(c => parentMap.get(c.id) === n.id)) keys.push('node:' + n.id);
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

    /** 某 Space 内:nodeId → 结构父 id(partOf / childMoc 的目标),无则为 null(根) */
    private buildParentMap(spaceId: string): Map<string, string | null> {
        const inSpace = new Set(this.ctx.store.nodesInSpace(spaceId).map(n => n.id));
        const parent = new Map<string, string | null>();
        for (const id of inSpace) {
            const link = this.ctx.store.linksFrom(id).find(l => (l.type === 'partOf' || l.type === 'childMoc') && inSpace.has(l.to));
            parent.set(id, link ? link.to : null);
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
        const childrenOf = (id: string) => nodes.filter(n => parentMap.get(n.id) === id);
        const fw = FRAMEWORKS[space.framework];

        for (const bucket of fw.buckets) {
            // 桶里只放「根节点」(结构上无父),后代由递归嵌套渲染
            const roots = nodes.filter(n => bucket.match(n) && parentMap.get(n.id) == null);
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
            roots.forEach(n => this.renderNode(n, 2, childrenOf));
        }
    }

    private renderNode(n: WorkspaceNode, depth: number, childrenOf: (id: string) => WorkspaceNode[]) {
        const kids = childrenOf(n.id);
        const nkey = 'node:' + n.id;
        const open = this.isOpen(nkey);

        const row = this.container.createDiv({ cls: 'nrow' + (this.isCurrent(n.id) ? ' sel' : '') });
        row.setCssStyles({ paddingLeft: `${16 + depth * 14}px` });

        // 嵌套层级的 1px 竖向缩进引导线(桶根节点 depth=2 不画)
        if (depth > 2) {
            const guide = row.createSpan({ cls: 'nguide' });
            guide.setCssStyles({ left: `${10 + depth * 14}px` });
        }

        const caret = row.createSpan({ cls: 'caret' + (open ? ' open' : '') + (kids.length ? '' : ' leaf') });
        caret.setText('▶');
        caret.onclick = (e) => { e.stopPropagation(); if (kids.length) this.toggle(nkey); };

        glyph(row, n.type);
        // 名字 = 跳转(MOC→图谱 / project→项目页 / note→笔记页 / space→cockpit);行其余 = 开详情 deck
        const nm = row.createSpan({ cls: 'nm link' + (n.type === 'note' || n.type === 'map' ? ' dim' : '') });
        nm.setText(n.title);
        // 名字只占文字宽度(否则 flex:1 撑满整行,右侧空白也成了"名字",点了照样跳转)
        nm.setCssStyles({ cursor: 'pointer', flex: '0 1 auto' });
        nm.onclick = (e) => { e.stopPropagation(); this.ctx.open(this.ctx.store.targetFor(n)); };
        // 撑满剩余宽度、与行同高的空白:点它冒泡到 row → 开 deck
        row.createSpan().setCssStyles({ flex: '1 1 auto', alignSelf: 'stretch' });

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

        // 行空白:面板内预览(中间主区渲染该节点页面 + 侧栏选中),和打开普通 MOC 一致,不跳图谱、不弹 deck
        row.onclick = () => this.ctx.openInline(this.ctx.store.targetFor(n));
        row.oncontextmenu = (e) => this.showMenu(e, n);

        if (open && kids.length) kids.forEach(k => this.renderNode(k, depth + 1, childrenOf));
    }

    /** 行右键菜单:打开 / (容器内节点)移出容器 / 删除 */
    private showMenu(e: MouseEvent, n: WorkspaceNode) {
        e.preventDefault();
        e.stopPropagation();
        const menu = new Menu();
        menu.addItem(i => i.setTitle(t('ws open')).setIcon('panel-right-open')
            .onClick(() => this.ctx.open(this.ctx.store.targetFor(n))));
        // 挂在某 MOC 容器下的节点:提供「移出容器」浮回所在 Space 顶层(非删除)
        if (n.type !== 'space' && this.ctx.store.linksFrom(n.id)
            .some(l => (l.type === 'partOf' || l.type === 'childMoc' || l.type === 'serves'))) {
            menu.addItem(i => i.setTitle(t('ws unmount')).setIcon('log-out')
                .onClick(async () => { await this.ctx.store.unmountFromContainer(n.id); }));
        }
        menu.addSeparator();
        menu.addItem(i => { (i as any).setWarning?.(true); i.setTitle(t('ws delete')).setIcon('trash-2')
            .onClick(() => this.ctx.requestDelete(n)); });
        menu.showAtMouseEvent(e);
    }
}
