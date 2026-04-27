import { TFile, Vault } from "obsidian";
import { FolderMetaFile, FolderNode, FOLDER_META_FILENAME } from "src/types/folder";

/** id 生成:`flt_` + 8 位 base36 + 时间戳尾 */
export function genFolderId(): string {
    const rand = Math.random().toString(36).slice(2, 10);
    const t = Date.now().toString(36).slice(-4);
    return `flt_${rand}${t}`;
}

/** 把内存 FolderNode 投影成磁盘 schema(去掉派生字段) */
export function nodeToMeta(node: FolderNode): FolderMetaFile {
    const meta: FolderMetaFile = {
        id: node.id,
        name: node.name,
        parentId: node.parentId,
        isProject: node.isProject,
        icon: node.icon,
        color: node.color,
        order: node.order,
        collapsed: node.collapsed,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
    };
    if (node.mocRefs && node.mocRefs.length > 0) meta.mocRefs = node.mocRefs.slice();
    return meta;
}

/** 把磁盘 schema 还原为内存节点(path/depth/childIds 由扫描端补) */
export function metaToNode(meta: FolderMetaFile, path: string): FolderNode {
    return {
        id: meta.id,
        name: meta.name,
        parentId: meta.parentId ?? null,
        path,
        childIds: [],
        depth: 0,
        isProject: !!meta.isProject,
        icon: meta.icon,
        color: meta.color,
        order: typeof meta.order === 'number' ? meta.order : 0,
        collapsed: !!meta.collapsed,
        mocRefs: Array.isArray(meta.mocRefs) ? meta.mocRefs.slice() : [],
        createdAt: meta.createdAt ?? Date.now(),
        updatedAt: meta.updatedAt ?? Date.now(),
    };
}

export async function readFolderMeta(vault: Vault, file: TFile): Promise<FolderMetaFile | null> {
    try {
        const raw = await vault.read(file);
        return JSON.parse(raw) as FolderMetaFile;
    } catch (e) {
        console.warn('[zk-navigation] _folder.json parse failed:', file.path, e);
        return null;
    }
}

export async function writeFolderMeta(vault: Vault, node: FolderNode): Promise<void> {
    const metaPath = `${node.path}/${FOLDER_META_FILENAME}`;
    const content = JSON.stringify(nodeToMeta(node), null, 2);
    const existing = vault.getFileByPath(metaPath);
    if (existing) {
        await vault.modify(existing, content);
    } else {
        await vault.create(metaPath, content);
    }
}
