/**
 * Space / Folder 数据模型
 *
 * - 每个 FolderNode 在 vault 中对应一个文件夹,文件夹下放 `_folder.json`
 * - id 永不改变(用 UUID 风格);path 跟随文件系统位置变化
 * - depth=0 的节点是顶层 Space
 */

export interface FolderNode {
    id: string;             // "flt_xxxxxxxx",永不改变
    name: string;           // 用户可见名(等同文件夹名)
    path: string;           // 相对 vault 的路径,如 "zk-spaces/工作/2026 Q2"
    parentId: string | null; // null = 顶层 Space
    childIds: string[];     // 子节点 id,显式存储用于稳定排序
    depth: number;          // 0 = Space, >=1 子层

    isProject: boolean;     // 是否升级为"项目"
    icon?: string;          // emoji 或 Lucide 图标名
    color?: string;         // 颜色

    order: number;          // 同层级排序
    collapsed: boolean;     // UI 折叠状态(持久化)

    /**
     * 挂载在该文件夹下的 MOC 文件路径(虚拟引用,不实际移动文件)
     * 同一个 MOC 可被多个 FolderNode 引用
     */
    mocRefs: string[];

    createdAt: number;
    updatedAt: number;
}

/** 写入磁盘的 _folder.json schema(不含 path / childIds / depth,这些由扫描重建) */
export interface FolderMetaFile {
    id: string;
    name: string;
    parentId: string | null;
    isProject: boolean;
    icon?: string;
    color?: string;
    order: number;
    collapsed: boolean;
    mocRefs?: string[];
    createdAt: number;
    updatedAt: number;
}

export interface ProjectMeta {
    folderId: string;
    description?: string;
    status: 'active' | 'paused' | 'done' | 'archived';
    deadline?: number;
    cardRefs: CardRef[];
    articleIds: string[];
}

export interface CardRef {
    cardId: string;
    pos?: { x: number; y: number };
    localNote?: string;
    addedAt: number;
}

/** 一键模板 */
export interface SpaceTemplate {
    id: string;
    name: string;
    description: string;
    icon?: string;
    roots: TemplateNode[];
}

export interface TemplateNode {
    name: string;
    icon?: string;
    color?: string;
    isProject?: boolean;
    children?: TemplateNode[];
}

export const FOLDER_META_FILENAME = '_folder.json';
export const SPACES_ROOT = 'zk-spaces';
