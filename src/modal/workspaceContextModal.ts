import { App, Modal, Notice, SuggestModal, setIcon } from "obsidian";
import { t } from "src/lang/helper";
import {
    MocWorkspaceBridge,
    MocWorkspaceBridgeRole,
    OpenTarget,
    WorkspaceNode,
    WorkspacePlacement,
} from "src/types/workspace";
import { WorkspaceStore } from "src/workspace/WorkspaceStore";

interface WorkspaceContextModalDeps {
    store: WorkspaceStore;
    mocPath: string;
    mocNodeId?: string | null;
    nodeTitle?: string;
    onOpenTarget: (target: OpenTarget) => void;
    onMountMoc: () => void;
    onChanged?: () => void;
}

interface BridgeTarget {
    node: WorkspaceNode;
    placement: WorkspacePlacement;
    path: string;
}

class BridgeTargetModal extends SuggestModal<BridgeTarget> {
    constructor(
        app: App,
        private store: WorkspaceStore,
        private role: MocWorkspaceBridgeRole,
        private onChoose: (target: BridgeTarget) => void,
    ) {
        super(app);
        this.setPlaceholder(t(role === 'project' ? 'ws bridge choose project' : 'ws bridge choose resource target'));
    }

    getSuggestions(query: string): BridgeTarget[] {
        const q = query.trim().toLowerCase();
        const candidates = this.store.getAllPlacements()
            .map(placement => {
                const node = this.store.getNode(placement.nodeId);
                return node ? { node, placement, path: this.store.displayPath(node.id, placement.spaceId) } : null;
            })
            .filter((item): item is BridgeTarget => !!item)
            .filter(item => this.role === 'project' ? item.node.type === 'project' : item.node.type === 'project');
        return candidates
            .filter(item => !q || `${item.node.title} ${item.path}`.toLowerCase().includes(q))
            .sort((a, b) => a.path.localeCompare(b.path, 'zh'));
    }

    renderSuggestion(item: BridgeTarget, el: HTMLElement): void {
        el.addClass('zk-ws-context-suggestion');
        const icon = el.createSpan({ cls: 'zk-ws-context-icon' });
        setIcon(icon, item.node.type === 'project' ? 'target' : 'file-text');
        const text = el.createDiv({ cls: 'zk-ws-context-suggestion-text' });
        text.createDiv({ cls: 'zk-ws-context-suggestion-title', text: item.node.title });
        text.createDiv({ cls: 'zk-ws-context-suggestion-path', text: item.path });
    }

    onChooseSuggestion(item: BridgeTarget): void {
        this.onChoose(item);
    }
}

/** 当前 MOC / 图节点在知识工作台中的位置与显式桥接管理。 */
export class WorkspaceContextModal extends Modal {
    constructor(app: App, private deps: WorkspaceContextModalDeps) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass('zk-ws-context-modal');
        this.render();
    }

    private render(): void {
        const { contentEl, titleEl } = this;
        contentEl.empty();
        titleEl.setText(t('ws context title'));

        const mocNode = this.deps.store.getNodeByPath(this.deps.mocPath);
        const locations = mocNode ? this.deps.store.placementsOfNode(mocNode.id) : [];
        this.sectionTitle(contentEl, t('ws context locations'), locations.length);
        if (mocNode && locations.length) {
            for (const placement of locations) {
                this.renderTargetRow(contentEl, mocNode, placement, 'git-branch');
            }
        } else {
            const empty = contentEl.createDiv({ cls: 'zk-ws-context-empty' });
            empty.createDiv({ cls: 'zk-ws-context-empty-title', text: t('ws context no location') });
            const mount = empty.createEl('button', { cls: 'mod-cta', text: t('ws context add moc') });
            mount.onclick = () => { this.close(); this.deps.onMountMoc(); };
        }

        if (!this.deps.mocNodeId) return;
        const bridges = this.deps.store.bridgesForGraphNode(this.deps.mocPath, this.deps.mocNodeId);
        this.sectionTitle(contentEl, t('ws context node links'), bridges.length);
        if (this.deps.nodeTitle) {
            contentEl.createDiv({ cls: 'zk-ws-context-current-node', text: this.deps.nodeTitle });
        }
        if (bridges.length) {
            for (const bridge of bridges) this.renderBridgeRow(contentEl, bridge);
        } else {
            contentEl.createDiv({ cls: 'zk-ws-context-muted', text: t('ws context no node links') });
        }

        const actions = contentEl.createDiv({ cls: 'zk-ws-context-actions' });
        this.actionButton(actions, 'target', t('ws bridge project'), () => this.pickBridgeTarget('project'));
        this.actionButton(actions, 'library', t('ws bridge resource'), () => this.pickBridgeTarget('resource'));
    }

    private sectionTitle(parent: HTMLElement, label: string, count: number): void {
        const row = parent.createDiv({ cls: 'zk-ws-context-section-title' });
        row.createSpan({ text: label });
        row.createSpan({ cls: 'zk-ws-context-count', text: String(count) });
    }

    private renderTargetRow(parent: HTMLElement, node: WorkspaceNode, placement: WorkspacePlacement, iconName: string): void {
        const row = parent.createDiv({ cls: 'zk-ws-context-row' });
        const icon = row.createSpan({ cls: 'zk-ws-context-icon' });
        setIcon(icon, iconName);
        const text = row.createDiv({ cls: 'zk-ws-context-row-text' });
        text.createDiv({ cls: 'zk-ws-context-row-title', text: node.title });
        text.createDiv({ cls: 'zk-ws-context-row-path', text: this.deps.store.displayPath(node.id, placement.spaceId) });
        const open = row.createEl('button', { text: t('ws view workbench') });
        open.onclick = () => {
            this.close();
            this.deps.onOpenTarget(this.deps.store.targetFor(node, placement));
        };
    }

    private renderBridgeRow(parent: HTMLElement, bridge: MocWorkspaceBridge): void {
        const node = this.deps.store.getNode(bridge.workspaceNodeId);
        if (!node) return;
        const placement = bridge.placementId ? this.deps.store.getPlacement(bridge.placementId) : undefined;
        const row = parent.createDiv({ cls: 'zk-ws-context-row' });
        const icon = row.createSpan({ cls: 'zk-ws-context-icon' });
        setIcon(icon, bridge.role === 'project' ? 'target' : bridge.role === 'resource' ? 'library' : 'layout-grid');
        const text = row.createDiv({ cls: 'zk-ws-context-row-text' });
        text.createDiv({ cls: 'zk-ws-context-row-title', text: node.title });
        const roleKey = bridge.role === 'project' ? 'ws bridge role project'
            : bridge.role === 'resource' ? 'ws bridge role resource' : 'ws bridge role workbench';
        text.createDiv({ cls: 'zk-ws-context-row-path', text: placement
            ? `${t(roleKey)} · ${this.deps.store.displayPath(node.id, placement.spaceId)}`
            : t('ws bridge invalid placement') });
        const open = row.createEl('button', { text: t('ws view workbench') });
        open.onclick = () => {
            const targetPlacement = placement ?? this.deps.store.placementsOfNode(node.id)[0];
            if (!targetPlacement) return;
            this.close();
            this.deps.onOpenTarget(this.deps.store.targetFor(node, targetPlacement));
        };
        const remove = row.createEl('button', { cls: 'clickable-icon mod-warning', attr: { 'aria-label': t('ws bridge remove') } });
        setIcon(remove, 'x');
        remove.onclick = () => { void (async () => {
            await this.deps.store.removeBridge(bridge.id);
            this.deps.onChanged?.();
            this.render();
        })(); };
    }

    private actionButton(parent: HTMLElement, iconName: string, label: string, callback: () => void): void {
        const button = parent.createEl('button');
        const icon = button.createSpan();
        setIcon(icon, iconName);
        button.createSpan({ text: label });
        button.onclick = callback;
    }

    private pickBridgeTarget(role: MocWorkspaceBridgeRole): void {
        new BridgeTargetModal(this.app, this.deps.store, role, target => { void (async () => {
            const bridge = await this.deps.store.addBridge({
                mocPath: this.deps.mocPath,
                mocNodeId: this.deps.mocNodeId!,
                workspaceNodeId: target.node.id,
                placementId: target.placement.id,
                role,
            });
            if (!bridge) {
                new Notice(t('ws bridge failed'));
                return;
            }
            this.deps.onChanged?.();
            this.render();
        })(); }).open();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
