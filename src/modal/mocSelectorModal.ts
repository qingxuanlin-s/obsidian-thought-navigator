import { App, SuggestModal, TFile } from "obsidian";
import { isMocFile } from "src/utils/utils";

interface MOCItem {
    type: 'moc' | 'roadmap';
    file: TFile | null;
    isProject?: boolean;
    sectionHeader?: string; // 非空表示这是一个分组标签伪项
}

function formatRelativeTime(ms: number): string {
    const now = Date.now();
    const diff = now - ms;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const month = 30 * day;

    if (diff < minute) return '刚刚';
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < month) return `${Math.floor(diff / day)} 天前`;
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 轻量探测:只匹配 JSON 里的 isProject: true,避免全量解析
const PROJECT_FLAG_RE = /"isProject"\s*:\s*true/;

export class MOCSelectorModal extends SuggestModal<MOCItem> {
    mocFiles: TFile[];
    onSubmit: (item: MOCItem) => void;
    private sortedFiles: TFile[];
    private projectPaths: Set<string> = new Set();
    private scanDone = false;

    constructor(app: App, mocFiles: TFile[], onSubmit: (item: MOCItem) => void) {
        super(app);
        this.mocFiles = mocFiles;
        this.onSubmit = onSubmit;
        this.setPlaceholder("搜索 MOC 文件(📐 项目置顶)...");

        // 按 mtime 倒序
        this.sortedFiles = [...mocFiles].sort((a, b) => b.stat.mtime - a.stat.mtime);

        // 后台扫描项目标志,扫完刷新建议
        this.scanProjectFlags();
    }

    private async scanProjectFlags() {
        await Promise.all(this.sortedFiles.map(async (f) => {
            if (!isMocFile(f)) return;
            try {
                const content = await this.app.vault.cachedRead(f);
                if (PROJECT_FLAG_RE.test(content)) {
                    this.projectPaths.add(f.path);
                }
            } catch {
                // 读失败忽略
            }
        }));
        this.scanDone = true;
        // 重新渲染(输入框值不变触发重新过滤)
        (this as any).onInput?.();
    }

    getSuggestions(query: string): MOCItem[] {
        const q = query.trim().toLowerCase();
        const filtered = q
            ? this.sortedFiles.filter(f => f.basename.toLowerCase().includes(q))
            : this.sortedFiles;

        const projects: MOCItem[] = [];
        const normals: MOCItem[] = [];
        for (const f of filtered) {
            const isProject = this.projectPaths.has(f.path);
            const item: MOCItem = { type: 'moc', file: f, isProject };
            if (isProject) projects.push(item);
            else normals.push(item);
        }

        const result: MOCItem[] = [];
        if (projects.length > 0) {
            result.push({ type: 'moc', file: null, sectionHeader: `📐 项目 · ${projects.length}` });
            result.push(...projects);
        }
        if (normals.length > 0) {
            result.push({ type: 'moc', file: null, sectionHeader: `📄 普通思维树 · ${normals.length}` });
            result.push(...normals);
        }
        return result;
    }

    renderSuggestion(item: MOCItem, el: HTMLElement): void {
        // 分组标题
        if (item.sectionHeader) {
            el.style.cssText = 'padding: 6px 12px; font-size: 10.5px; color: var(--text-muted); letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; cursor: default; background: var(--background-secondary);';
            el.setText(item.sectionHeader);
            // 分组项不可选
            el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
            return;
        }

        const file = item.file;
        if (!file) return;

        el.style.display = 'flex';
        el.style.justifyContent = 'space-between';
        el.style.alignItems = 'center';

        const left = el.createDiv();
        left.style.cssText = 'display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1;';

        if (item.isProject) {
            const badge = left.createSpan();
            badge.setText('📐');
            badge.style.cssText = 'flex-shrink: 0; font-size: 13px;';
        }

        const name = left.createSpan();
        name.setText(file.basename);
        name.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

        const timeEl = el.createDiv();
        timeEl.style.cssText = 'font-size: 11px; color: var(--text-muted); flex-shrink: 0; margin-left: 8px;';
        timeEl.setText(formatRelativeTime(file.stat.mtime));
    }

    onChooseSuggestion(item: MOCItem, evt: MouseEvent | KeyboardEvent): void {
        // 分组标题被点到则忽略
        if (item.sectionHeader || !item.file) return;
        this.onSubmit(item);
    }
}
