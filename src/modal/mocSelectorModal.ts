import { App, SuggestModal, TFile } from "obsidian";

interface MOCItem {
    type: 'moc' | 'roadmap';
    file: TFile | null;
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

export class MOCSelectorModal extends SuggestModal<MOCItem> {
    mocFiles: TFile[];
    onSubmit: (item: MOCItem) => void;
    private sortedFiles: TFile[];

    constructor(app: App, mocFiles: TFile[], onSubmit: (item: MOCItem) => void) {
        super(app);
        this.mocFiles = mocFiles;
        this.onSubmit = onSubmit;
        this.setPlaceholder("搜索 MOC 文件...");

        // 按 mtime 倒序排列（最近修改/打开的在前）
        this.sortedFiles = [...mocFiles].sort((a, b) => b.stat.mtime - a.stat.mtime);
    }

    getSuggestions(query: string): MOCItem[] {
        const q = query.trim().toLowerCase();
        const filtered = q
            ? this.sortedFiles.filter(f => f.basename.toLowerCase().includes(q))
            : this.sortedFiles;
        return filtered.map(f => ({ type: 'moc' as const, file: f }));
    }

    renderSuggestion(item: MOCItem, el: HTMLElement): void {
        const file = item.file;
        if (!file) return;

        el.style.display = 'flex';
        el.style.justifyContent = 'space-between';
        el.style.alignItems = 'center';

        el.createDiv().setText(file.basename);

        const timeEl = el.createDiv();
        timeEl.style.cssText = 'font-size: 11px; color: var(--text-muted); flex-shrink: 0; margin-left: 8px;';
        timeEl.setText(formatRelativeTime(file.stat.mtime));
    }

    onChooseSuggestion(item: MOCItem, evt: MouseEvent | KeyboardEvent): void {
        this.onSubmit(item);
    }
}
