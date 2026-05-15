import { App, Notice } from "obsidian";
import { FolderNode, SpaceTemplate, TemplateNode } from "src/types/folder";
import { genFolderId } from "src/services/folderJson";
import { VaultIndex } from "src/index/VaultIndex";
import { t } from "src/lang/helper";

/**
 * 业务层:UI 不直接读写文件/索引,通过 SpaceService 触发原子操作。
 * 所有写操作都走 index.commit(),后者会重建派生字段、写盘并通知监听者。
 */
export class SpaceService {
    private app: App;
    private index: VaultIndex;

    constructor(app: App, index: VaultIndex) {
        this.app = app;
        this.index = index;
    }

    /** 创建顶层 Space */
    async createSpace(name: string, opts?: { icon?: string; color?: string }): Promise<FolderNode> {
        const trimmed = name.trim();
        assertValidName(trimmed);
        this.assertNoSiblingConflict(null, trimmed);

        const now = Date.now();
        const node: FolderNode = {
            id: genFolderId(),
            name: trimmed,
            parentId: null,
            childIds: [],
            depth: 0,
            isProject: false,
            order: this.index.getRoots().length,
            collapsed: false,
            mocRefs: [],
            createdAt: now,
            updatedAt: now,
            ...(opts || {}),
        };
        await this.index.commit((nodes) => { nodes.set(node.id, node); });
        return node;
    }

    /** 在指定父节点下创建子文件夹 */
    async createFolder(parentId: string, name: string, opts?: { icon?: string; color?: string }): Promise<FolderNode> {
        const parent = this.index.getNode(parentId);
        if (!parent) throw new Error(t('Parent folder does not exist'));
        const trimmed = name.trim();
        assertValidName(trimmed);
        this.assertNoSiblingConflict(parent.id, trimmed);

        const now = Date.now();
        const node: FolderNode = {
            id: genFolderId(),
            name: trimmed,
            parentId: parent.id,
            childIds: [],
            depth: parent.depth + 1,
            isProject: false,
            order: this.index.getChildren(parent.id).length,
            collapsed: false,
            mocRefs: [],
            createdAt: now,
            updatedAt: now,
            ...(opts || {}),
        };
        await this.index.commit((nodes) => { nodes.set(node.id, node); });
        return node;
    }

    /** 把一个 MOC 文件挂载到指定文件夹下(添加 mocRefs 记录) */
    async mountMoc(folderId: string, mocPath: string): Promise<boolean> {
        const node = this.index.getNode(folderId);
        if (!node) throw new Error(t('Folder does not exist'));
        if ((node.mocRefs ?? []).includes(mocPath)) return false;
        await this.index.commit(() => {
            const refs = node.mocRefs ?? (node.mocRefs = []);
            refs.push(mocPath);
            node.updatedAt = Date.now();
        });
        return true;
    }

    /** 取消挂载 */
    async unmountMoc(folderId: string, mocPath: string): Promise<boolean> {
        const node = this.index.getNode(folderId);
        if (!node || !node.mocRefs?.includes(mocPath)) return false;
        await this.index.commit(() => {
            node.mocRefs = (node.mocRefs ?? []).filter(p => p !== mocPath);
            node.updatedAt = Date.now();
        });
        return true;
    }

    /**
     * 把 MOC 从一个文件夹移动到另一个文件夹(原子操作:一次 commit)
     * - 同一文件夹内拖动 → 直接返回 false
     * - 目标文件夹已挂载该 MOC → 仅从源解挂(等价于"取消挂载");返回 true
     */
    async moveMoc(fromFolderId: string, toFolderId: string, mocPath: string): Promise<boolean> {
        if (fromFolderId === toFolderId) return false;
        const fromNode = this.index.getNode(fromFolderId);
        const toNode = this.index.getNode(toFolderId);
        if (!fromNode || !toNode) throw new Error(t('Source or target folder does not exist'));
        if (!(fromNode.mocRefs ?? []).includes(mocPath)) return false;

        await this.index.commit(() => {
            const now = Date.now();
            fromNode.mocRefs = (fromNode.mocRefs ?? []).filter(p => p !== mocPath);
            fromNode.updatedAt = now;
            const toRefs = toNode.mocRefs ?? (toNode.mocRefs = []);
            if (!toRefs.includes(mocPath)) {
                toRefs.push(mocPath);
                toNode.updatedAt = now;
            }
        });
        return true;
    }

    /** MOC 文件被重命名:更新所有引用了它的文件夹 */
    async handleMocRename(oldPath: string, newPath: string): Promise<void> {
        const folders = this.index.getFoldersHostingMoc(oldPath);
        if (folders.length === 0) return;
        await this.index.commit(() => {
            const now = Date.now();
            for (const node of folders) {
                if (!node.mocRefs) continue;
                node.mocRefs = node.mocRefs.map(p => p === oldPath ? newPath : p);
                node.updatedAt = now;
            }
        });
    }

    /** MOC 文件被删除:清理所有挂载 */
    async handleMocDelete(path: string): Promise<void> {
        const folders = this.index.getFoldersHostingMoc(path);
        if (folders.length === 0) return;
        await this.index.commit(() => {
            const now = Date.now();
            for (const node of folders) {
                if (!node.mocRefs) continue;
                node.mocRefs = node.mocRefs.filter(p => p !== path);
                node.updatedAt = now;
            }
        });
    }

    /** 删除 Space / Folder 及其所有后代(只清 JSON 内的虚拟节点,不动 vault 文件) */
    async delete(folderId: string): Promise<void> {
        if (!this.index.getNode(folderId)) return;
        const ids = this.index.collectSubtreeIds(folderId);
        await this.index.commit((nodes) => {
            for (const id of ids) nodes.delete(id);
        });
    }

    /** 切换折叠状态(持久化) */
    async setCollapsed(folderId: string, collapsed: boolean): Promise<void> {
        const node = this.index.getNode(folderId);
        if (!node || node.collapsed === collapsed) return;
        await this.index.commit(() => {
            node.collapsed = collapsed;
            node.updatedAt = Date.now();
        });
    }

    /** 同上,但跳过 emit/写盘节流(用于自动展开祖先链时合并多次更新) */
    async expandAncestors(folderIds: string[]): Promise<void> {
        const targets = folderIds
            .map(id => this.index.getNode(id))
            .filter((n): n is FolderNode => !!n && n.collapsed);
        if (targets.length === 0) return;
        await this.index.commit(() => {
            const now = Date.now();
            for (const n of targets) {
                n.collapsed = false;
                n.updatedAt = now;
            }
        });
    }

    /** 应用模板:创建一个新的顶层 Space,模板的 roots 作为它的子文件夹 */
    async applyTemplate(tmpl: SpaceTemplate, spaceName: string): Promise<FolderNode> {
        const space = await this.createSpace(spaceName, { icon: tmpl.icon });
        for (const tn of tmpl.roots) {
            await this.applyTemplateNode(space.id, tn);
        }
        return space;
    }

    private async applyTemplateNode(parentId: string, tn: TemplateNode): Promise<void> {
        const node = await this.createFolder(parentId, tn.name, { icon: tn.icon, color: tn.color });
        if (tn.isProject) {
            await this.index.commit(() => {
                const live = this.index.getNode(node.id);
                if (live) {
                    live.isProject = true;
                    live.updatedAt = Date.now();
                }
            });
        }
        if (tn.children) {
            for (const c of tn.children) {
                await this.applyTemplateNode(node.id, c);
            }
        }
    }

    private assertNoSiblingConflict(parentId: string | null, name: string): void {
        const siblings = parentId == null ? this.index.getRoots() : this.index.getChildren(parentId);
        if (siblings.some(s => s.name === name)) {
            new Notice(t('Folder with same name exists').replace('{name}', name));
            throw new Error(`Sibling conflict: ${name}`);
        }
    }
}

function assertValidName(name: string): void {
    if (!name) throw new Error(t('Name cannot be empty'));
    // 禁止常见非法字符(Windows + 路径分隔)
    if (/[\\/:*?"<>|]/.test(name)) {
        throw new Error(t('Name contains invalid characters'));
    }
}
