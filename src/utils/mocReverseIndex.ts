import { App, TFile } from "obsidian";
import { isMocFile } from "./utils";

/**
 * MOC 中笔记的位置信息
 */
export interface MOCLocation {
    mocFilePath: string;     // MOC 文件路径
    mocFileName: string;     // MOC 文件名（不含扩展名）
    nodeId: string;          // 笔记在该 MOC 中的节点 ID
}

export interface MOCParentLocation {
    parentMocPath: string;
    parentMocName: string;
    /** 父 MOC 中指向当前子 MOC 的节点 ID，可用于打开后选中并居中。 */
    parentNodeId: string;
}

export type SearchKind = 'fileNode' | 'conceptNode' | 'embedNode' | 'mocFile' | 'remark';

export interface SearchEntry {
    kind: SearchKind;
    text: string;
    mocFilePath: string;
    mocFileName: string;
    nodeId: string;
}

/**
 * MOC 反向索引
 * 维护 notePath -> MOCLocation[] 的映射，用于快速查找一个笔记存在于哪些 MOC 中
 */
export class MOCReverseIndex {
    private app: App;
    private index: Map<string, MOCLocation[]> = new Map();
    /** 子 MOC 路径 → 所有直接引用它的父 MOC 位置。 */
    private mocParents: Map<string, MOCParentLocation[]> = new Map();
    private searchEntries: SearchEntry[] = [];
    private mocFolderPath = '';
    private headingTitle = '';
    private initialized = false;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * 初始化反向索引，扫描所有 MOC 文件
     */
    async initialize(mocFolderPath: string, headingTitle: string): Promise<void> {
        this.mocFolderPath = mocFolderPath;
        this.headingTitle = headingTitle;

        if (!mocFolderPath) {
            this.index.clear();
            this.mocParents.clear();
            this.searchEntries = [];
            return;
        }

        await this.rebuild();
        this.initialized = true;
    }

    /**
     * 全量重建索引
     */
    async rebuild(): Promise<void> {
        this.index.clear();
        this.mocParents.clear();
        this.searchEntries = [];

        const mocFiles = this.getMOCFiles();

        for (const file of mocFiles) {
            await this.indexMOCFile(file);
        }
    }

    /**
     * 索引单个 MOC 文件
     */
    private async indexMOCFile(file: TFile): Promise<void> {
        try {
            if (!isMocFile(file)) return;

            // 直接读取；仅在失败时做指数回退重试，避免全量重建时为每个文件固定等待
            let fileContent: string | null = null;
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    fileContent = await this.app.vault.read(file);
                    break;
                } catch {
                    await new Promise(resolve => window.setTimeout(resolve, 75 * (attempt + 1)));
                    if (attempt === 4) return;
                }
            }
            if (fileContent === null) return;
            const content = fileContent;
            const basePath = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '';
            const resolvedFileCache = new Map<string, TFile | null>();
            const resolveWikiLink = (wikiLink: string): TFile | null => {
                if (resolvedFileCache.has(wikiLink)) {
                    return resolvedFileCache.get(wikiLink) || null;
                }
                const pathOnly = wikiLink.split('#', 1)[0];
                let linkedFile = this.app.metadataCache.getFirstLinkpathDest(pathOnly, basePath);
                // Obsidian 无法总是把旧式 .moc 链接解析为新式 .moc.md 文件；
                // 反向索引需与图谱解析保持一致，确保父 MOC 能被发现。
                if (!linkedFile) {
                    const relativePath = basePath ? `${basePath}/${pathOnly}` : pathOnly;
                    const candidates = [pathOnly, relativePath];
                    if (pathOnly.toLowerCase().endsWith('.moc')) {
                        candidates.push(`${pathOnly}.md`, `${relativePath}.md`);
                    }
                    linkedFile = candidates
                        .map(path => this.app.vault.getFileByPath(path))
                        .find((candidate): candidate is TFile => candidate instanceof TFile)
                        ?? null;
                }
                resolvedFileCache.set(wikiLink, linkedFile);
                return linkedFile;
            };
            /** 文本节点中纯 `[[target]]` 形式也是真实可点击文件节点，兼容旧 MOC 数据。 */
            const pureWikiLinkTarget = (text: string | undefined): string | null => {
                if (!text) return null;
                const match = /^\s*\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]\s*$/.exec(text);
                return match?.[1]?.trim() || null;
            };

            // JSON 格式：遍历节点树提取 wikilink
            type MocJsonNode = { nodeID?: string; nodeType?: string; isTextOnly?: boolean; isEmbed?: boolean; target?: string; wikiLink?: string; children?: MocJsonNode[] };
            let json: { nodes?: MocJsonNode[] };
            try { json = JSON.parse(content); } catch { return; }
            this.searchEntries.push({
                kind: 'mocFile',
                text: file.basename,
                mocFilePath: file.path,
                mocFileName: file.basename,
                nodeId: '',
            });
            const remarks = this.extractNodeRemarks(json);

            const walk = (nodes: MocJsonNode[]) => {
                for (const n of nodes) {
                    // 新 shape: nodeType !== 'text' 且 target 存在
                    // 旧 shape: !isTextOnly 且 wikiLink 存在
                    const isText = n.nodeType === 'text' || n.isTextOnly;
                    const isEmbed = n.nodeType === 'embed' || n.isEmbed === true;
                    const link = n.target ?? n.wikiLink;
                    const textLink = isText ? pureWikiLinkTarget(link) : null;
                    const resolvedLink = textLink ?? link;
                    const nodeId = n.nodeID || '';
                    if ((!isText || textLink) && resolvedLink) {
                        const linkedFile = resolveWikiLink(resolvedLink);
                        if (linkedFile) {
                            this.addToIndex(linkedFile.path, file, nodeId);
                            if (linkedFile.path !== file.path && isMocFile(linkedFile)) {
                                this.addMocParent(linkedFile.path, file, nodeId);
                            }
                            this.addSearchEntry(isEmbed ? 'embedNode' : 'fileNode', linkedFile.basename, file, nodeId);
                        } else {
                            this.addSearchEntry(isEmbed ? 'embedNode' : 'fileNode', resolvedLink, file, nodeId);
                        }
                    } else if (isText) {
                        this.addSearchEntry('conceptNode', this.nodeText(n), file, nodeId);
                    }
                    const remark = nodeId ? remarks.get(nodeId) : null;
                    if (remark) {
                        this.addSearchEntry('remark', remark, file, nodeId);
                    }
                    if (n.children?.length) walk(n.children);
                }
            };
            walk(json.nodes || []);
        } catch (error) {
            console.error(`MOCReverseIndex: Failed to index ${file.path}`, error);
        }
    }

    private addSearchEntry(kind: SearchKind, text: string, mocFile: TFile, nodeId: string): void {
        const trimmed = text.trim();
        if (!trimmed) return;
        this.searchEntries.push({
            kind,
            text: trimmed,
            mocFilePath: mocFile.path,
            mocFileName: mocFile.basename,
            nodeId,
        });
    }

    private nodeText(node: unknown): string {
        if (!node || typeof node !== 'object') return '';
        const record = node as Record<string, unknown>;
        for (const key of ['target', 'text', 'title', 'displayText', 'name', 'label']) {
            const value = record[key];
            if (typeof value === 'string' && value.trim()) return value;
        }
        return '';
    }

    private extractNodeRemarks(json: unknown): Map<string, string> {
        const remarks = new Map<string, string>();
        if (!json || typeof json !== 'object') return remarks;
        const record = json as Record<string, unknown>;
        const ext = record.ext;
        const nodeRemarks = record.nodeRemarks || (ext && typeof ext === 'object' ? (ext as Record<string, unknown>).nodeRemarks : null);
        if (!nodeRemarks || typeof nodeRemarks !== 'object') return remarks;

        for (const [nodeId, value] of Object.entries(nodeRemarks as Record<string, unknown>)) {
            if (typeof value === 'string' && value.trim()) {
                remarks.set(nodeId, value);
            }
        }
        return remarks;
    }

    private addMocParent(childMocPath: string, parentMoc: TFile, parentNodeId: string): void {
        if (!parentNodeId) return;
        const location: MOCParentLocation = {
            parentMocPath: parentMoc.path,
            parentMocName: parentMoc.basename,
            parentNodeId,
        };
        const existing = this.mocParents.get(childMocPath) ?? [];
        if (!existing.some(item => item.parentMocPath === location.parentMocPath && item.parentNodeId === location.parentNodeId)) {
            existing.push(location);
            this.mocParents.set(childMocPath, existing);
        }
    }

    private addToIndex(notePath: string, mocFile: TFile, nodeId: string): void {
        const location: MOCLocation = {
            mocFilePath: mocFile.path,
            mocFileName: mocFile.basename,
            nodeId,
        };
        const existing = this.index.get(notePath);
        if (existing) {
            if (!existing.some(loc => loc.mocFilePath === mocFile.path && loc.nodeId === nodeId)) {
                existing.push(location);
            }
        } else {
            this.index.set(notePath, [location]);
        }
    }

    /**
     * 增量更新：当某个 MOC 文件变化时，重新索引该文件
     */
    async updateFile(file: TFile): Promise<void> {
        // 先移除该 MOC 作为父级写入的旧条目；保留其它 MOC 指向它的父级记录。
        this.removeEntriesForMOC(file.path, false);
        // 重新索引
        await this.indexMOCFile(file);
    }

    /**
     * 移除某个 MOC 文件的所有索引条目
     * @param removeIncomingParentReferences 文件删除时为 true；内容更新时必须保留其它 MOC 指向它的记录。
     */
    removeEntriesForMOC(mocFilePath: string, removeIncomingParentReferences = true): void {
        for (const [notePath, locations] of this.index.entries()) {
            const filtered = locations.filter(loc => loc.mocFilePath !== mocFilePath);
            if (filtered.length === 0) {
                this.index.delete(notePath);
            } else {
                this.index.set(notePath, filtered);
            }
        }
        // 始终移除该文件作为父 MOC 的旧引用；重新索引后会按最新内容写回。
        for (const [childPath, locations] of this.mocParents.entries()) {
            const filtered = locations.filter(loc => loc.parentMocPath !== mocFilePath);
            if (filtered.length === 0) this.mocParents.delete(childPath);
            else this.mocParents.set(childPath, filtered);
        }
        // 只有文件真正删除时，才移除其它 MOC 指向它的记录。
        if (removeIncomingParentReferences) {
            this.mocParents.delete(mocFilePath);
        }
        this.searchEntries = this.searchEntries.filter(entry => entry.mocFilePath !== mocFilePath);
    }

    /**
     * 查询笔记存在于哪些 MOC 中
     * @param notePath 笔记文件路径
     * @param excludeMOCPath 排除的 MOC 路径（通常是当前 MOC）
     * @returns 其他 MOC 的位置信息数组
     */
    query(notePath: string, excludeMOCPath?: string): MOCLocation[] {
        const locations = this.index.get(notePath) || [];
        if (excludeMOCPath) {
            return locations.filter(loc => loc.mocFilePath !== excludeMOCPath);
        }
        return locations;
    }

    /** 当前 MOC 被哪些其它 MOC 作为直接图节点引用。 */
    queryMOCParents(childMocPath: string): MOCParentLocation[] {
        return (this.mocParents.get(childMocPath) ?? [])
            .slice()
            .sort((a, b) => a.parentMocName.localeCompare(b.parentMocName, 'zh')
                || a.parentMocPath.localeCompare(b.parentMocPath));
    }

    /**
     * 获取 vault 中所有 JSON MOC 文件
     */
    private getMOCFiles(): TFile[] {
        return this.app.vault.getFiles().filter(f => {
            if (isMocFile(f)) return true;
            return false;
        });
    }

    /**
     * 处理笔记文件重命名
     */
    handleNoteRename(oldPath: string, newPath: string): void {
        const locations = this.index.get(oldPath);
        if (locations) {
            this.index.delete(oldPath);
            this.index.set(newPath, locations);
        }
    }

    /**
     * 导出为可序列化对象（用于持久化）
     */
    toJSON(): Record<string, MOCLocation[]> {
        const obj: Record<string, MOCLocation[]> = {};
        for (const [key, value] of this.index.entries()) {
            obj[key] = value;
        }
        return obj;
    }

    /**
     * 从序列化对象恢复
     */
    fromJSON(data: Record<string, MOCLocation[]>): void {
        this.index.clear();
        for (const [key, value] of Object.entries(data)) {
            this.index.set(key, value);
        }
    }

    /**
     * 模糊搜索：返回所有匹配的笔记及其 MOC 位置
     * @param query 搜索关键词
     * @param limit 最大返回数量
     */
    fuzzySearch(query: string, limit = 50): Array<{ notePath: string; noteBasename: string; locations: MOCLocation[] }> {
        if (!query.trim()) {
            // 无关键词时返回所有条目
            const results: Array<{ notePath: string; noteBasename: string; locations: MOCLocation[] }> = [];
            for (const [notePath, locations] of this.index.entries()) {
                const file = this.app.vault.getFileByPath(notePath);
                if (file) {
                    results.push({ notePath, noteBasename: file.basename, locations });
                }
                if (results.length >= limit) break;
            }
            return results;
        }

        const lowerQuery = query.toLowerCase();
        const terms = lowerQuery.split(/\s+/).filter(t => t.length > 0);
        const results: Array<{ notePath: string; noteBasename: string; locations: MOCLocation[]; score: number }> = [];

        for (const [notePath, locations] of this.index.entries()) {
            const file = this.app.vault.getFileByPath(notePath);
            if (!file) continue;

            const basename = file.basename.toLowerCase();
            const path = notePath.toLowerCase();

            // 所有关键词都必须匹配（文件名或路径）
            let allMatch = true;
            let score = 0;
            for (const term of terms) {
                const nameIdx = basename.indexOf(term);
                const pathIdx = path.indexOf(term);
                if (nameIdx === -1 && pathIdx === -1) {
                    allMatch = false;
                    break;
                }
                // 文件名匹配优先级更高
                if (nameIdx !== -1) {
                    score += nameIdx === 0 ? 100 : 50; // 前缀匹配加分
                } else {
                    score += 10;
                }
            }

            if (allMatch) {
                results.push({ notePath, noteBasename: file.basename, locations, score });
            }
        }

        // 按匹配分数排序（高分优先）
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit).map(({ notePath, noteBasename, locations }) => ({ notePath, noteBasename, locations }));
    }

    /**
     * 获取所有已索引的笔记路径
     */
    getAllNotePaths(): string[] {
        return Array.from(this.index.keys());
    }

    getSearchEntries(): SearchEntry[] {
        return this.searchEntries.slice();
    }

    get isInitialized(): boolean {
        return this.initialized;
    }

    get size(): number {
        return this.index.size;
    }
}
