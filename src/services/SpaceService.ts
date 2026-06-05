import { App, Notice } from "obsidian";
import { FolderNode, SpaceTemplate, TemplateNode } from "src/types/folder";
import { genFolderId } from "src/services/folderJson";
import { VaultIndex } from "src/index/VaultIndex";
import { t } from "src/lang/helper";

/** vault 路径取 basename(含扩展名)作 file 节点显示名 */
function basenameOf(path: string): string {
    return path.split('/').pop() || path;
}

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
            kind: 'folder',
            isProject: false,
            order: this.index.getRoots().length,
            collapsed: false,
            createdAt: now,
            updatedAt: now,
            ...(opts || {}),
        };
        await this.index.commit((nodes) => { nodes.set(node.id, node); });
        return node;
    }

    /** 在指定父节点下创建子文件夹(父节点可以是 folder 或 file 节点) */
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
            kind: 'folder',
            isProject: false,
            order: this.index.getChildren(parent.id).length,
            collapsed: false,
            createdAt: now,
            updatedAt: now,
            ...(opts || {}),
        };
        await this.index.commit((nodes) => { nodes.set(node.id, node); });
        return node;
    }

    /**
     * 把一批文件挂载到指定父节点下(父节点可以是 folder,也可以是另一个 file 节点)。
     * 每个文件成为 kind==='file' 的子节点;已在该父下的文件跳过。返回新建的节点数。
     */
    async mountFiles(parentId: string, filePaths: string[]): Promise<number> {
        const parent = this.index.getNode(parentId);
        if (!parent) throw new Error(t('Folder does not exist'));
        const toAdd = filePaths.filter(p => !!p && !this.index.hasFileChild(parentId, p));
        if (toAdd.length === 0) return 0;
        await this.index.commit((nodes) => {
            const now = Date.now();
            let order = this.index.getChildren(parentId).length;
            for (const path of toAdd) {
                const node: FolderNode = {
                    id: genFolderId(),
                    name: basenameOf(path),
                    parentId,
                    childIds: [],
                    depth: 0,
                    kind: 'file',
                    filePath: path,
                    isProject: false,
                    order: order++,
                    collapsed: false,
                    createdAt: now,
                    updatedAt: now,
                };
                nodes.set(node.id, node);
            }
            parent.updatedAt = now;
        });
        return toAdd.length;
    }

    /** 把单个 MOC/文件挂到某节点下(FolderMountModal 用) */
    async mountMoc(folderId: string, mocPath: string): Promise<boolean> {
        return (await this.mountFiles(folderId, [mocPath])) > 0;
    }

    /** 取消挂载:删除该父节点下指向 mocPath 的 file 子节点(连同其子树) */
    async unmountMoc(folderId: string, mocPath: string): Promise<boolean> {
        const parent = this.index.getNode(folderId);
        if (!parent) return false;
        const targets = parent.childIds
            .map(id => this.index.getNode(id))
            .filter((n): n is FolderNode => !!n && n.kind === 'file' && n.filePath === mocPath);
        if (targets.length === 0) return false;
        const ids = new Set<string>();
        for (const t of targets) for (const id of this.index.collectSubtreeIds(t.id)) ids.add(id);
        await this.index.commit((nodes) => {
            for (const id of ids) nodes.delete(id);
            parent.updatedAt = Date.now();
        });
        return true;
    }

    /**
     * 把任意节点(file 或 folder)重新挂到新父节点下(拖拽用,一次 commit)。
     * - 目标 === 当前父 → 返回 false
     * - 禁止挂到自身或自己的后代下(防环)
     * - file 节点:若目标下已存在同文件,则等价于"从原处解挂",直接删掉被拖的节点子树
     */
    async moveNode(nodeId: string, toParentId: string): Promise<boolean> {
        const node = this.index.getNode(nodeId);
        const toParent = this.index.getNode(toParentId);
        if (!node || !toParent) throw new Error(t('Source or target folder does not exist'));
        if (node.parentId === toParentId) return false;
        // 防环:目标不能是自身或后代
        const subtree = new Set(this.index.collectSubtreeIds(nodeId));
        if (subtree.has(toParentId)) return false;

        if (node.kind === 'file' && node.filePath && this.index.hasFileChild(toParentId, node.filePath)) {
            // 目标已挂同一文件 → 直接删掉被拖节点子树(去重)
            await this.index.commit((nodes) => {
                for (const id of subtree) nodes.delete(id);
            });
            return true;
        }

        await this.index.commit(() => {
            const now = Date.now();
            node.parentId = toParentId;
            node.order = this.index.getChildren(toParentId).length;
            node.updatedAt = now;
            toParent.updatedAt = now;
        });
        return true;
    }

    /** 文件被重命名:更新所有 file 节点的 filePath + 显示名 */
    async handleMocRename(oldPath: string, newPath: string): Promise<void> {
        const nodes = this.index.getFileNodesByPath(oldPath);
        if (nodes.length === 0) return;
        await this.index.commit(() => {
            const now = Date.now();
            for (const node of nodes) {
                node.filePath = newPath;
                node.name = basenameOf(newPath);
                node.updatedAt = now;
            }
        });
    }

    /** 文件被删除:移除对应 file 节点,但把它的子节点上提到其父,避免丢失用户的子文件夹 */
    async handleMocDelete(path: string): Promise<void> {
        const fileNodes = this.index.getFileNodesByPath(path);
        if (fileNodes.length === 0) return;
        await this.index.commit((nodes) => {
            const now = Date.now();
            for (const fn of fileNodes) {
                for (const childId of fn.childIds.slice()) {
                    const child = nodes.get(childId);
                    if (child) { child.parentId = fn.parentId; child.updatedAt = now; }
                }
                nodes.delete(fn.id);
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
