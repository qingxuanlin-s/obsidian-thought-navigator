import { App, SuggestModal, Notice, setIcon } from "obsidian";
import { WorkspaceNode } from "src/types/workspace";
import { WorkspaceStore } from "src/workspace/WorkspaceStore";
import { t } from "src/lang/helper";

interface PickItem {
    node: WorkspaceNode;
    mounted: boolean;
}

/**
 * 选择一个容器(Space / MOC),把指定文件挂上去 / 取消挂载。
 * - 行末已挂载显示 ✓;再次选中切换为取消挂载
 * - 容器全集来自 WorkspaceStore(替代旧 FolderMountModal 的 spaces.json 版本)
 */
export class ContainerMountModal extends SuggestModal<PickItem> {
    private store: WorkspaceStore;
    private filePath: string;

    constructor(app: App, store: WorkspaceStore, filePath: string) {
        super(app);
        this.store = store;
        this.filePath = filePath;
        this.setPlaceholder(t("Choose folder to mount placeholder"));
    }

    getSuggestions(query: string): PickItem[] {
        const q = query.trim().toLowerCase();
        const containers = this.store.getContainers();
        if (containers.length === 0) return [];

        const items: PickItem[] = containers.map(n => ({
            node: n,
            mounted: this.store.isFileMountedIn(this.filePath, n.id),
        }));

        const filtered = q
            ? items.filter(it => this.store.displayPath(it.node.id).toLowerCase().includes(q))
            : items;

        // 已挂载排前面,再按完整路径排序
        filtered.sort((a, b) => {
            if (a.mounted !== b.mounted) return a.mounted ? -1 : 1;
            return this.store.displayPath(a.node.id)
                .localeCompare(this.store.displayPath(b.node.id), 'zh');
        });

        return filtered;
    }

    renderSuggestion(item: PickItem, el: HTMLElement): void {
        el.setCssStyles({ display: 'flex', alignItems: 'center', gap: '8px' });

        const icon = el.createSpan();
        icon.setCssStyles({ flexShrink: '0', width: '16px', textAlign: 'center' });
        if (item.node.icon) {
            setIcon(icon, item.node.icon);
        } else {
            setIcon(icon, item.node.type === 'space' ? 'folder' : 'git-branch');
        }

        const path = el.createSpan();
        path.setCssStyles({ flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
        path.setText(this.store.displayPath(item.node.id));

        if (item.mounted) {
            const check = el.createSpan();
            check.setCssStyles({ color: 'var(--interactive-accent)', fontWeight: '700', flexShrink: '0' });
            check.setText('✓');
        }
    }

    async onChooseSuggestion(item: PickItem): Promise<void> {
        try {
            if (item.mounted) {
                await this.store.unmountFileFromContainer(this.filePath, item.node.id);
                new Notice(t("Unmounted from folder").replace("{name}", item.node.title));
            } else {
                await this.store.mountFilesToContainer(item.node.id, [this.filePath]);
                new Notice(t("Mounted to folder").replace("{name}", item.node.title));
            }
            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
        } catch (e) {
            new Notice(t("Operation failed").replace("{message}", String(e?.message || e)));
        }
    }
}
