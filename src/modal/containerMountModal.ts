import { App, SuggestModal, Notice, setIcon } from "obsidian";
import { WorkspaceNode } from "src/types/workspace";
import { WorkspaceStore } from "src/workspace/WorkspaceStore";
import { t } from "src/lang/helper";

interface PickItem {
    node: WorkspaceNode;
    spaceId: string;
    placementId?: string;
    path: string;
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

        const hosted = this.store.locationsHostingFile(this.filePath);
        const items: PickItem[] = containers.flatMap((node): PickItem[] => {
            if (node.type === 'space') {
                return [{
                    node,
                    spaceId: node.id,
                    path: this.store.displayPath(node.id),
                    mounted: hosted.some(location => location.container.id === node.id
                        && location.placement.parentPlacementId === null),
                }];
            }
            return this.store.placementsOfNode(node.id).map(placement => ({
                node,
                spaceId: placement.spaceId,
                placementId: placement.id,
                path: this.store.displayPath(node.id, placement.spaceId),
                mounted: hosted.some(location => location.container.id === node.id
                    && location.placement.spaceId === placement.spaceId),
            }));
        });

        const filtered = q
            ? items.filter(it => it.path.toLowerCase().includes(q))
            : items;

        // 已挂载排前面,再按完整路径排序
        filtered.sort((a, b) => {
            if (a.mounted !== b.mounted) return a.mounted ? -1 : 1;
            return a.path.localeCompare(b.path, 'zh');
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
        path.setText(item.path);

        if (item.mounted) {
            const check = el.createSpan();
            check.setCssStyles({ color: 'var(--interactive-accent)', fontWeight: '700', flexShrink: '0' });
            check.setText('✓');
        }
    }

    async onChooseSuggestion(item: PickItem): Promise<void> {
        try {
            if (item.mounted) {
                await this.store.unmountFileFromContainer(this.filePath, item.node.id, item.spaceId);
                new Notice(t("Unmounted from folder").replace("{name}", item.node.title));
            } else {
                await this.store.mountFilesToContainer(item.node.id, [this.filePath], { spaceId: item.spaceId });
                new Notice(t("Mounted to folder").replace("{name}", item.node.title));
            }
            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
        } catch (e) {
            new Notice(t("Operation failed").replace("{message}", String(e?.message || e)));
        }
    }
}
