import { App, Notice, TFile, TFolder } from "obsidian";
import { FolderNode, SpaceTemplate, SPACES_ROOT, TemplateNode, FOLDER_META_FILENAME } from "src/types/folder";
import { genFolderId, writeFolderMeta } from "src/services/folderJson";
import { VaultIndex } from "src/index/VaultIndex";

/**
 * 业务层:UI 不直接读写文件/索引,通过 SpaceService 触发原子操作。
 * 写完后显式 refresh,让 UI 立即拿到最新状态。
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

        await this.ensureSpacesRoot();
        const path = `${SPACES_ROOT}/${trimmed}`;
        await this.assertNoConflict(path);

        const now = Date.now();
        const node: FolderNode = {
            id: genFolderId(),
            name: trimmed,
            path,
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
        await this.app.vault.createFolder(path);
        await writeFolderMeta(this.app.vault, node);
        await this.index.refreshNow();
        return node;
    }

    /** 在指定父节点下创建子文件夹 */
    async createFolder(parentId: string, name: string, opts?: { icon?: string; color?: string }): Promise<FolderNode> {
        const parent = this.index.getNode(parentId);
        if (!parent) throw new Error('父文件夹不存在');
        const trimmed = name.trim();
        assertValidName(trimmed);

        const path = `${parent.path}/${trimmed}`;
        await this.assertNoConflict(path);

        const now = Date.now();
        const node: FolderNode = {
            id: genFolderId(),
            name: trimmed,
            path,
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
        await this.app.vault.createFolder(path);
        await writeFolderMeta(this.app.vault, node);
        await this.index.refreshNow();
        return node;
    }

    /** 把一个 MOC 文件挂载到指定文件夹下(添加 mocRefs 记录) */
    async mountMoc(folderId: string, mocPath: string): Promise<boolean> {
        const node = this.index.getNode(folderId);
        if (!node) throw new Error('文件夹不存在');
        const refs = node.mocRefs ?? (node.mocRefs = []);
        if (refs.includes(mocPath)) return false;
        refs.push(mocPath);
        node.updatedAt = Date.now();
        await writeFolderMeta(this.app.vault, node);
        await this.index.refreshNow();
        return true;
    }

    /** 取消挂载 */
    async unmountMoc(folderId: string, mocPath: string): Promise<boolean> {
        const node = this.index.getNode(folderId);
        if (!node || !node.mocRefs) return false;
        const before = node.mocRefs.length;
        node.mocRefs = node.mocRefs.filter(p => p !== mocPath);
        if (node.mocRefs.length === before) return false;
        node.updatedAt = Date.now();
        await writeFolderMeta(this.app.vault, node);
        await this.index.refreshNow();
        return true;
    }

    /**
     * 把 MOC 从一个文件夹移动到另一个文件夹(原子操作:一次 refresh)
     * - 同一文件夹内拖动 → 直接返回 false
     * - 目标文件夹已挂载该 MOC → 仅从源解挂(等价于"取消挂载");返回 true
     */
    async moveMoc(fromFolderId: string, toFolderId: string, mocPath: string): Promise<boolean> {
        if (fromFolderId === toFolderId) return false;
        const fromNode = this.index.getNode(fromFolderId);
        const toNode = this.index.getNode(toFolderId);
        if (!fromNode || !toNode) throw new Error('源或目标文件夹不存在');

        const fromRefs = fromNode.mocRefs ?? (fromNode.mocRefs = []);
        if (!fromRefs.includes(mocPath)) return false;

        const now = Date.now();
        fromNode.mocRefs = fromRefs.filter(p => p !== mocPath);
        fromNode.updatedAt = now;
        await writeFolderMeta(this.app.vault, fromNode);

        const toRefs = toNode.mocRefs ?? (toNode.mocRefs = []);
        if (!toRefs.includes(mocPath)) {
            toRefs.push(mocPath);
            toNode.updatedAt = now;
            await writeFolderMeta(this.app.vault, toNode);
        }

        await this.index.refreshNow();
        return true;
    }

    /** MOC 文件被重命名:更新所有引用了它的文件夹 */
    async handleMocRename(oldPath: string, newPath: string): Promise<void> {
        const folders = this.index.getFoldersHostingMoc(oldPath);
        if (folders.length === 0) return;
        const now = Date.now();
        for (const node of folders) {
            if (!node.mocRefs) continue;
            node.mocRefs = node.mocRefs.map(p => p === oldPath ? newPath : p);
            node.updatedAt = now;
            await writeFolderMeta(this.app.vault, node);
        }
        await this.index.refreshNow();
    }

    /** MOC 文件被删除:清理所有挂载 */
    async handleMocDelete(path: string): Promise<void> {
        const folders = this.index.getFoldersHostingMoc(path);
        if (folders.length === 0) return;
        const now = Date.now();
        for (const node of folders) {
            if (!node.mocRefs) continue;
            node.mocRefs = node.mocRefs.filter(p => p !== path);
            node.updatedAt = now;
            await writeFolderMeta(this.app.vault, node);
        }
        await this.index.refreshNow();
    }

    /** 删除 Space / Folder(连同其下所有内容,谨慎使用) */
    async delete(folderId: string): Promise<void> {
        const node = this.index.getNode(folderId);
        if (!node) return;
        const folder = this.app.vault.getAbstractFileByPath(node.path);
        if (folder instanceof TFolder) {
            await this.app.vault.trash(folder, true);
        }
        await this.index.refreshNow();
    }

    /** 应用模板:创建一个新的顶层 Space,模板的 roots 作为它的子文件夹 */
    async applyTemplate(tmpl: SpaceTemplate, spaceName: string): Promise<FolderNode> {
        const space = await this.createSpace(spaceName, { icon: tmpl.icon });
        for (const tn of tmpl.roots) {
            await this.applyTemplateNode(space.id, tn);
        }
        await this.index.refreshNow();
        return space;
    }

    private async applyTemplateNode(parentId: string, tn: TemplateNode): Promise<void> {
        const node = await this.createFolder(parentId, tn.name, { icon: tn.icon, color: tn.color });
        if (tn.isProject) {
            // 升级为项目暂不在 Layer 1 范围;仅写入 isProject 标志
            const live = this.index.getNode(node.id);
            if (live) {
                live.isProject = true;
                live.updatedAt = Date.now();
                await writeFolderMeta(this.app.vault, live);
            }
        }
        if (tn.children) {
            for (const c of tn.children) {
                await this.applyTemplateNode(node.id, c);
            }
        }
    }

    private async ensureSpacesRoot(): Promise<void> {
        const root = this.app.vault.getAbstractFileByPath(SPACES_ROOT);
        if (!root) {
            await this.app.vault.createFolder(SPACES_ROOT);
        }
    }

    private async assertNoConflict(path: string): Promise<void> {
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing) {
            new Notice(`已存在同名文件夹: ${path}`);
            throw new Error(`Path conflict: ${path}`);
        }
    }
}

function assertValidName(name: string): void {
    if (!name) throw new Error('名称不能为空');
    if (name === FOLDER_META_FILENAME) throw new Error('名称不能为 _folder.json');
    // 禁止常见非法字符(Windows + 路径分隔)
    if (/[\\/:*?"<>|]/.test(name)) {
        throw new Error('名称包含非法字符 \\ / : * ? " < > |');
    }
}
