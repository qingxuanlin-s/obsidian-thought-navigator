import { App, TFile } from "obsidian";
import { MermaidParser } from "./mermaidParser";

/**
 * MOC 中笔记的位置信息
 */
export interface MOCLocation {
    mocFilePath: string;     // MOC 文件路径
    mocFileName: string;     // MOC 文件名（不含扩展名）
    nodeId: string;          // 笔记在该 MOC 中的节点 ID
}

/**
 * MOC 反向索引
 * 维护 notePath -> MOCLocation[] 的映射，用于快速查找一个笔记存在于哪些 MOC 中
 */
export class MOCReverseIndex {
    private app: App;
    private index: Map<string, MOCLocation[]> = new Map();
    private mocFolderPath: string = '';
    private headingTitle: string = '';
    private initialized: boolean = false;

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

        const mocFiles = this.getMOCFiles();
        const parser = new MermaidParser(this.app);

        for (const file of mocFiles) {
            await this.indexMOCFile(file, parser);
        }
    }

    /**
     * 索引单个 MOC 文件
     */
    private async indexMOCFile(file: TFile, parser?: MermaidParser): Promise<void> {
        try {
            // 直接读取；仅在失败时做指数回退重试，避免全量重建时为每个文件固定等待
            let fileContent: string | null = null;
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    fileContent = await this.app.vault.read(file);
                    break;
                } catch {
                    await new Promise(resolve => setTimeout(resolve, 75 * (attempt + 1)));
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
                const linkedFile = this.app.metadataCache.getFirstLinkpathDest(wikiLink, basePath);
                resolvedFileCache.set(wikiLink, linkedFile);
                return linkedFile;
            };

            if (file.extension === 'moc') {
                // JSON 格式：遍历节点树提取 wikilink
                let json: any;
                try { json = JSON.parse(content); } catch { return; }

                const walk = (nodes: any[]) => {
                    for (const n of nodes) {
                        // 新 shape: nodeType !== 'text' 且 target 存在
                        // 旧 shape: !isTextOnly 且 wikiLink 存在
                        const isText = n.nodeType === 'text' || n.isTextOnly;
                        const link = n.target ?? n.wikiLink;
                        if (!isText && link) {
                            const linkedFile = resolveWikiLink(link);
                            if (linkedFile) {
                                this.addToIndex(linkedFile.path, file, n.nodeID);
                            }
                        }
                        if (n.children?.length) walk(n.children);
                    }
                };
                walk(json.nodes || []);
            } else {
                // Mermaid 格式：正则提取 wikilink 节点
                const p = parser || new MermaidParser(this.app);
                const mermaidBlock = p.extractMermaidBlock(content);
                if (!mermaidBlock) return;

                const nodeRegex = /^([a-zA-Z0-9.]+)\["(?:!)?\[\[([^\]|]+)(?:\|[^\]]+)?\]\]"\]$/gm;
                let match;
                while ((match = nodeRegex.exec(mermaidBlock)) !== null) {
                    const nodeId = match[1];
                    const wikiLink = match[2];
                    const linkedFile = resolveWikiLink(wikiLink);
                    if (linkedFile) {
                        this.addToIndex(linkedFile.path, file, nodeId);
                    }
                }
            }
        } catch (error) {
            console.error(`MOCReverseIndex: Failed to index ${file.path}`, error);
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
        // 先移除该 MOC 文件的所有旧条目
        this.removeEntriesForMOC(file.path);
        // 重新索引
        await this.indexMOCFile(file);
    }

    /**
     * 移除某个 MOC 文件的所有索引条目
     */
    removeEntriesForMOC(mocFilePath: string): void {
        for (const [notePath, locations] of this.index.entries()) {
            const filtered = locations.filter(loc => loc.mocFilePath !== mocFilePath);
            if (filtered.length === 0) {
                this.index.delete(notePath);
            } else {
                this.index.set(notePath, filtered);
            }
        }
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

    /**
     * 获取 MOC 文件夹中的所有 markdown 文件
     */
    private getMOCFiles(): TFile[] {
        return this.app.vault.getFiles().filter(f => {
            if (f.extension === 'moc') return true;
            if (f.extension === 'md' && this.mocFolderPath) return f.path.startsWith(this.mocFolderPath + '/');
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
    fuzzySearch(query: string, limit: number = 50): Array<{ notePath: string; noteBasename: string; locations: MOCLocation[] }> {
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

    get isInitialized(): boolean {
        return this.initialized;
    }

    get size(): number {
        return this.index.size;
    }
}
