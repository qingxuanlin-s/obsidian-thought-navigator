import { DataAdapter } from "obsidian";
import { FolderNode, SpaceStoreFile, SpaceStoreNode } from "src/types/folder";

/** id 生成:`flt_` + 8 位 base36 + 时间戳尾 */
export function genFolderId(): string {
    const rand = Math.random().toString(36).slice(2, 10);
    const t = Date.now().toString(36).slice(-4);
    return `flt_${rand}${t}`;
}

/** 把内存 FolderNode 投影成磁盘 schema(去掉派生字段) */
export function nodeToStore(node: FolderNode): SpaceStoreNode {
    const out: SpaceStoreNode = {
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
    if (node.kind === 'file') {
        out.kind = 'file';
        if (node.filePath) out.filePath = node.filePath;
    }
    return out;
}

/** 把磁盘 schema 还原为内存节点(depth/childIds 由扫描端补) */
export function storeToNode(meta: SpaceStoreNode): FolderNode {
    return {
        id: meta.id,
        name: meta.name,
        parentId: meta.parentId ?? null,
        childIds: [],
        depth: 0,
        kind: meta.kind === 'file' ? 'file' : 'folder',
        filePath: meta.kind === 'file' ? meta.filePath : undefined,
        isProject: !!meta.isProject,
        icon: meta.icon,
        color: meta.color,
        order: typeof meta.order === 'number' ? meta.order : 0,
        collapsed: !!meta.collapsed,
        // 旧字段保留以供 VaultIndex 一次性迁移成 file 子节点
        mocRefs: Array.isArray(meta.mocRefs) ? meta.mocRefs.slice() : undefined,
        createdAt: meta.createdAt ?? Date.now(),
        updatedAt: meta.updatedAt ?? Date.now(),
    };
}

export async function readSpaceStore(adapter: DataAdapter, storePath: string): Promise<FolderNode[]> {
    try {
        const exists = await adapter.exists(storePath);
        if (!exists) return [];
        const raw = await adapter.read(storePath);
        const parsed = JSON.parse(raw) as SpaceStoreFile;
        if (!parsed || !Array.isArray(parsed.nodes)) return [];
        return parsed.nodes.map(storeToNode);
    } catch (e) {
        console.warn('[zk-navigation] spaces.json 读取失败:', storePath, e);
        return [];
    }
}

export async function writeSpaceStore(adapter: DataAdapter, storePath: string, nodes: FolderNode[]): Promise<void> {
    const data: SpaceStoreFile = {
        version: 1,
        nodes: nodes.map(nodeToStore),
    };
    await adapter.write(storePath, JSON.stringify(data, null, 2));
}
