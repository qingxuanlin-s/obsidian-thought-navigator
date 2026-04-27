import { App, SuggestModal, TFile, Notice } from "obsidian";
import { FolderNode } from "src/types/folder";
import { VaultIndex } from "src/index/VaultIndex";
import { SpaceService } from "src/services/SpaceService";

interface PickItem {
    node: FolderNode;
    mounted: boolean;
}

/**
 * 选择一个文件夹,把当前 MOC 挂上去 / 取消挂载。
 * - 行末尾若已挂载,显示 ✓ 标记;选中再次切换为取消挂载
 * - 若 VaultIndex 为空,提示先去抽屉里建 Space
 */
export class FolderMountModal extends SuggestModal<PickItem> {
    private index: VaultIndex;
    private service: SpaceService;
    private mocFile: TFile;

    constructor(app: App, index: VaultIndex, service: SpaceService, mocFile: TFile) {
        super(app);
        this.index = index;
        this.service = service;
        this.mocFile = mocFile;
        this.setPlaceholder("选择要挂载到的文件夹(再次选中已挂载项可取消)...");
    }

    getSuggestions(query: string): PickItem[] {
        const q = query.trim().toLowerCase();
        const all = this.index.getAllNodes();
        if (all.length === 0) return [];

        const items: PickItem[] = all.map(n => ({
            node: n,
            mounted: !!n.mocRefs?.includes(this.mocFile.path),
        }));

        const filtered = q
            ? items.filter(it => {
                const path = this.index.getDisplayPath(it.node.id).toLowerCase();
                return path.includes(q);
            })
            : items;

        // 已挂载排前面,然后按完整路径排序
        filtered.sort((a, b) => {
            if (a.mounted !== b.mounted) return a.mounted ? -1 : 1;
            return this.index.getDisplayPath(a.node.id)
                .localeCompare(this.index.getDisplayPath(b.node.id), 'zh');
        });

        return filtered;
    }

    renderSuggestion(item: PickItem, el: HTMLElement): void {
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.gap = '8px';

        const icon = el.createSpan();
        icon.style.cssText = 'flex-shrink: 0; font-size: 14px; width: 16px; text-align: center;';
        icon.setText(item.node.icon || '📁');

        const path = el.createSpan();
        path.style.cssText = 'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        path.setText(this.index.getDisplayPath(item.node.id));

        if (item.mounted) {
            const check = el.createSpan();
            check.style.cssText = 'color: var(--interactive-accent); font-weight: 700; flex-shrink: 0;';
            check.setText('✓');
        }
    }

    async onChooseSuggestion(item: PickItem): Promise<void> {
        try {
            if (item.mounted) {
                await this.service.unmountMoc(item.node.id, this.mocFile.path);
                new Notice(`已从「${item.node.name}」取消挂载`);
            } else {
                await this.service.mountMoc(item.node.id, this.mocFile.path);
                new Notice(`已挂载到「${item.node.name}」`);
            }
            this.app.workspace.trigger("zk-navigation:refresh-index-graph");
        } catch (e: any) {
            new Notice(`操作失败: ${e?.message || e}`);
        }
    }

    onNoSuggestion(): void {
        // 没有任何文件夹时给一个提示项
    }
}
