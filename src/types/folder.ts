/**
 * Space / Folder 数据模型
 *
 * 整棵 Space 树持久化在插件数据目录下的单个 spaces.json 文件里,
 * 不再为每个文件夹在 vault 里创建真实目录。
 * - id 永不改变(用 UUID 风格)
 * - 父子关系靠 parentId,不依赖文件系统路径
 * - depth=0 的节点是顶层 Space
 */

export interface FolderNode {
    id: string;             // "flt_xxxxxxxx",永不改变
    name: string;           // 用户可见名
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

/**
 * 写入磁盘的整棵树 schema(spaces.json 顶层结构)
 * - childIds / depth 不持久化(由内存重建)
 */
export interface SpaceStoreNode {
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

export interface SpaceStoreFile {
    version: 1;
    nodes: SpaceStoreNode[];
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
