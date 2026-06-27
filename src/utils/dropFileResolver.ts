import { App, TFile } from "obsidian";

/**
 * 解析 DragEvent 中的 vault 文件链接(text/plain、text/uri-list、obsidian:// URI 等)。
 * 兼容文件管理器 / 文件浏览器 / 链接拖拽各种格式。
 */
export function resolveDroppedVaultFiles(app: App, event: DragEvent): TFile[] {
    const dt = event.dataTransfer;
    if (!dt) return [];

    const candidateValues = new Set<string>();
    const addCandidate = (value?: string | null) => {
        if (!value) return;
        const trimmed = value.trim();
        if (!trimmed) return;
        candidateValues.add(trimmed);
    };

    addCandidate(dt.getData('text/plain'));
    addCandidate(dt.getData('text/uri-list'));
    addCandidate(dt.getData('text/x-obsidian-uri'));
    addCandidate(dt.getData('application/x-obsidian-uri'));
    addCandidate(dt.getData('application/x-obsidian-file'));

    for (const type of Array.from(dt.types || [])) {
        try {
            addCandidate(dt.getData(type));
        } catch {
            // 某些类型不可读，忽略即可
        }
    }

    const vaultFiles = app.vault.getFiles();

    /** 把候选字符串规整成纯路径片段(去掉 obsidian:// / file:// / 前导斜杠 / wikilink 装饰) */
    const normalizeCandidate = (raw: string): string => {
        let normalized = decodeURIComponent(raw).trim();

        // 兼容 Obsidian URI：obsidian://open?vault=...&file=...
        if (normalized.startsWith('obsidian://')) {
            try {
                const parsed = new URL(normalized);
                const fileParam = parsed.searchParams.get('file');
                if (fileParam) {
                    normalized = decodeURIComponent(fileParam);
                } else {
                    normalized = normalized
                        .replace(/^obsidian:\/\/open\?file=/, '')
                        .replace(/^obsidian:\/\/advanced-uri\?.*?file=/, '');
                }
            } catch {
                normalized = normalized
                    .replace(/^obsidian:\/\/open\?file=/, '')
                    .replace(/^obsidian:\/\/advanced-uri\?.*?file=/, '');
            }
        }

        return normalized
            .replace(/^file:\/\//, '')
            .replace(/^\//, '')
            .replace(/\[\[|\]\]/g, '')
            .split('|')[0]
            .split('#')[0];
    };

    /** 仅做精确路径匹配,不做 basename 模糊兜底 */
    const resolveExact = (raw: string): TFile | null => {
        const normalized = normalizeCandidate(raw);
        if (!normalized) return null;
        const exact = app.vault.getFileByPath(normalized);
        if (exact instanceof TFile) return exact;
        const withoutVaultPrefix = normalized.replace(/^.*?\/(?=[^/]+\/[^/]+$)/, '');
        const maybeExact = app.vault.getFileByPath(withoutVaultPrefix);
        if (maybeExact instanceof TFile) return maybeExact;
        return null;
    };

    /** basename 兜底:仅在没有任何精确匹配时使用,避免同名文件造成重复 */
    const resolveByBasename = (raw: string): TFile | null => {
        const normalized = normalizeCandidate(raw);
        if (!normalized) return null;
        const basename = normalized.split('/').pop();
        if (!basename) return null;
        return vaultFiles.find(f =>
            f.path === basename ||
            f.basename === basename ||
            f.path.endsWith(`/${basename}`)
        ) || null;
    };

    const resolvedFiles: TFile[] = [];
    const seenPaths = new Set<string>();
    const pushResolved = (file: TFile | null) => {
        if (!file) return;
        if (seenPaths.has(file.path)) return;
        seenPaths.add(file.path);
        resolvedFiles.push(file);
    };

    /** 把每个候选转成"待解析的字符串列表"(展开 JSON 包装) */
    const stringCandidates: string[] = [];
    for (const value of candidateValues) {
        stringCandidates.push(value);
        try {
            const parsed = JSON.parse(value);
            if (typeof parsed === 'string') {
                stringCandidates.push(parsed);
            } else if (parsed && typeof parsed === 'object') {
                const pathLike = parsed.path || parsed.file || parsed.filePath || parsed.sourcePath;
                if (typeof pathLike === 'string') stringCandidates.push(pathLike);
            }
        } catch {
            // 非 JSON,忽略
        }
    }

    // Pass 1: 优先精确路径匹配,确保拖到的就是用户实际选中的那个文件
    for (const value of stringCandidates) {
        pushResolved(resolveExact(value));
    }

    // Pass 2: 仅当 Pass 1 没结果时才用 basename 兜底(否则会因为同名文件多一份)
    if (resolvedFiles.length === 0) {
        for (const value of stringCandidates) {
            pushResolved(resolveByBasename(value));
            if (resolvedFiles.length > 0) break; // basename 模糊匹配只取第一个
        }
    }

    return resolvedFiles;
}

/** DragEvent 是否包含 vault 文件类型(不含暂存区卡片) */
export function hasVaultFileDragTypes(event: DragEvent): boolean {
    const dt = event.dataTransfer;
    if (!dt) return false;
    const types = Array.from(dt.types || []);
    return types.some(t =>
        t === 'text/plain' ||
        t === 'text/uri-list' ||
        t === 'text/x-obsidian-uri' ||
        t === 'application/x-obsidian-uri' ||
        t === 'application/x-obsidian-file' ||
        t === 'Files'
    );
}
