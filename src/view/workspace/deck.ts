import { Component, MarkdownRenderer, TFile } from "obsidian";
import { WorkspaceNode, WSProjectNode, WSMocNode } from "src/types/workspace";
import { projectProgress } from "src/workspace/WorkspaceStore";
import { pickVaultFile } from "./notePicker";
import { t } from "src/lang/helper";
import { RenderCtx, TYPE_COLOR, statusLabel, STATUS_COLOR, relTime } from "./render";

const TYPE_LABEL: Record<string, string> = { space: 'SPACE', moc: 'MOC', project: 'PROJECT', note: 'NOTE', map: 'MAP' };

/** 右侧滑出详情 deck(原型 .deck)。覆盖 center,Esc / scrim / close 关闭,pin 后不关。 */
export class Deck {
    private scrim: HTMLElement;
    private panel: HTMLElement;
    private head: HTMLElement;
    private body: HTMLElement;
    private foot: HTMLElement;
    private pinned = false;
    private isOpen = false;

    constructor(parent: HTMLElement, private ctx: RenderCtx, private owner: Component) {
        this.scrim = parent.createDiv({ cls: 'scrim' });
        this.scrim.onclick = () => { if (!this.pinned) this.close(); };
        this.panel = parent.createDiv({ cls: 'deck' });
        this.head = this.panel.createDiv({ cls: 'deck-head' });
        this.body = this.panel.createDiv({ cls: 'deck-body' });
        this.foot = this.panel.createDiv({ cls: 'deck-foot' });
    }

    open(node: WorkspaceNode) {
        this.head.empty(); this.body.empty(); this.foot.empty();

        // head
        const top = this.head.createDiv({ cls: 'deck-top' });
        const badge = top.createSpan({ cls: 'deck-badge' });
        badge.setCssStyles({
            color: `${TYPE_COLOR[node.type]}`,
            background: 'rgba(255,255,255,0.05)',
        });
        badge.createSpan({ cls: 'bd' }).setCssStyles({ background: TYPE_COLOR[node.type] });
        badge.appendText(TYPE_LABEL[node.type] || node.type);
        top.createSpan({ cls: 'sp' });
        const pin = top.createSpan({ cls: 'deck-icon', text: '📌' });
        pin.onclick = () => { this.pinned = !this.pinned; pin.toggleClass('pinned', this.pinned); };
        const close = top.createSpan({ cls: 'deck-icon', text: '✕' });
        close.onclick = () => this.close();

        this.head.createEl('h2', { cls: 'deck-h2', text: node.title });
        const space = this.ctx.store.getNode(node.spaceId);
        const crumb = this.head.createDiv({ cls: 'deck-crumb' });
        crumb.appendText(space?.title || '');
        crumb.createSpan({ cls: 's', text: '›' });
        crumb.appendText(node.title);

        this.renderBody(node);

        // foot
        const closeBtn = this.foot.createEl('button', { cls: 'close', text: t('ws close esc') });
        closeBtn.onclick = () => this.close();
        const filePath = (node as any).filePath as string | undefined;
        if ((node.type === 'moc' || node.type === 'map') && filePath) {
            const openMap = this.foot.createEl('button', { cls: 'open-map', text: t('ws open graph') });
            openMap.onclick = () => { this.ctx.open({ kind: 'moc', id: node.id }); this.close(); };
        }

        this.isOpen = true;
        this.scrim.addClass('show');
        this.panel.addClass('open');
    }

    private renderBody(node: WorkspaceNode) {
        if (node.type === 'project') {
            const p = node as WSProjectNode;
            const meta = this.body.createDiv({ cls: 'dmeta' });
            const mi = (k: string, v: string, color?: string) => {
                const cell = meta.createDiv({ cls: 'mi' });
                cell.createDiv({ cls: 'k', text: k });
                const val = cell.createDiv({ cls: 'v', text: v });
                if (color) val.setCssStyles({ color: color });
                return cell;
            };
            mi(t('ws status'), statusLabel(p.status), STATUS_COLOR[p.status]);
            const pct = projectProgress(p);
            const progCell = mi(t('ws progress'), pct === null ? '—' : `${pct}%`);
            if (pct !== null) {
                const bar = progCell.createDiv({ cls: 'dbar' });
                bar.createEl('i').setCssStyles({
                    width: `${pct}%`,
                    background: `${STATUS_COLOR[p.status]}`,
                });
            }
            mi(t('ws updated'), relTime(p.updatedAt));
            mi(t('ws next'), p.nextAction || '—');

            if (p.checklist?.length) {
                this.body.createDiv({ cls: 'dsec', text: t('ws checklist') });
                const prose = this.body.createDiv({ cls: 'prose' });
                p.checklist.forEach(it => prose.createEl('p', { text: (it.done ? '✓ ' : '○ ') + it.text }));
            }

            const serveLinks = this.ctx.store.linksFrom(p.id).filter(l => l.type === 'serves');
            if (serveLinks.length) {
                this.body.createDiv({ cls: 'dsec', text: t('ws serves areas') });
                const chips = this.body.createDiv({ cls: 'dchips' });
                serveLinks.forEach(l => {
                    const m = this.ctx.store.getNode(l.to);
                    if (!m) return;
                    const chip = chips.createSpan({ cls: 'dchip' });
                    chip.createSpan({ cls: 'a', text: '◎' });
                    chip.appendText(m.title);
                    chip.onclick = () => { this.ctx.open({ kind: 'moc', id: m.id }); this.close(); };
                });
            }
            return;
        }

        // MOC / 图谱:存储格式是 .moc.md(JSON),不能当正文渲染。只展示描述 + 聚合成员(关联)
        if (node.type === 'moc' || node.type === 'map') {
            const desc = (node as WSMocNode).description;
            if (desc) {
                this.body.createDiv({ cls: 'dsec', text: t('ws body') });
                this.body.createDiv({ cls: 'prose' }).createEl('p', { text: desc });
            }
            if (node.type === 'moc') {
                const moc = node;
                const members = this.ctx.store.servedBy(moc.id);
                const sec = this.body.createDiv({ cls: 'dsec row' });
                sec.appendText(t('ws agg').replace('{n}', String(members.length)));
                const addBtn = sec.createSpan({ cls: 'dsec-add', text: '+ ' + t('ws assoc node') });
                addBtn.onclick = () => this.pickAssoc(moc);
                if (members.length) {
                    const chips = this.body.createDiv({ cls: 'dchips' });
                    members.forEach(m => {
                        const chip = chips.createSpan({ cls: 'dchip' });
                        chip.appendText(m.title);
                        chip.onclick = () => { this.ctx.open(this.ctx.store.targetFor(m)); this.close(); };
                        const x = chip.createSpan({ cls: 'dchip-x', text: '✕' });
                        x.setAttribute('title', t('ws assoc remove'));
                        x.onclick = async (e) => { e.stopPropagation(); await this.ctx.store.removeRelation(m.id, moc.id); this.open(moc); };
                    });
                } else {
                    this.body.createDiv({ cls: 'empty', text: t('ws no members') });
                }
            }
            return;
        }

        // note → 真实 markdown 笔记正文
        this.body.createDiv({ cls: 'dsec', text: t('ws body') });
        const prose = this.body.createDiv({ cls: 'prose' });
        const filePath = (node as any).filePath as string | undefined;
        const file = filePath ? this.ctx.app.vault.getAbstractFileByPath(filePath) : null;
        if (file instanceof TFile) {
            this.ctx.app.vault.cachedRead(file).then(md => {
                MarkdownRenderer.render(this.ctx.app, md, prose, filePath || '', this.owner);
            });
        } else if ((node as any).body) {
            MarkdownRenderer.render(this.ctx.app, (node as any).body, prose, '', this.owner);
        } else if ((node as any).description) {
            prose.createEl('p', { text: (node as any).description });
        } else {
            prose.createEl('p', { cls: 'muted', text: t('ws no detail') });
        }
    }

    /** 从整个 vault 选一篇笔记关联到此 MOC(就地建 note 节点 + partOf 链),完成后刷新面板 */
    private pickAssoc(moc: WSMocNode) {
        pickVaultFile(this.ctx.app, async (file) => {
            await this.ctx.store.associateFileToMoc(moc.id, file);
            this.open(moc);
        });
    }

    close() {
        this.isOpen = false;
        this.scrim.removeClass('show');
        this.panel.removeClass('open');
    }

    handleEsc(): boolean {
        if (this.isOpen && !this.pinned) { this.close(); return true; }
        return false;
    }
}
