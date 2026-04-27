import { App, SuggestModal, TFile } from "obsidian";
import { VaultIndex } from "src/index/VaultIndex";

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

export class MOCSelectorModal extends SuggestModal<MOCItem> {
    mocFiles: TFile[];
    onSubmit: (item: MOCItem) => void;
    private sortedFiles: TFile[];
    private vaultIndex: VaultIndex | null;

    constructor(app: App, mocFiles: TFile[], vaultIndex: VaultIndex | null, onSubmit: (item: MOCItem) => void) {
        super(app);
        this.mocFiles = mocFiles;
        this.onSubmit = onSubmit;
        this.vaultIndex = vaultIndex;
        this.setPlaceholder("搜索 MOC 文件(项目置顶)...");

        // 按 mtime 倒序
        this.sortedFiles = [...mocFiles].sort((a, b) => b.stat.mtime - a.stat.mtime);
    }

    private isProjectMoc(file: TFile): boolean {
        return !!this.vaultIndex?.isMocMounted(file.path);
    }

    getSuggestions(query: string): MOCItem[] {
        const q = query.trim().toLowerCase();
        const filtered = q
            ? this.sortedFiles.filter(f => f.basename.toLowerCase().includes(q))
            : this.sortedFiles;

        const projects: MOCItem[] = [];
        const normals: MOCItem[] = [];
        for (const f of filtered) {
            const isProject = this.isProjectMoc(f);
            const item: MOCItem = { type: 'moc', file: f, isProject };
            if (isProject) projects.push(item);
            else normals.push(item);
        }

        const result: MOCItem[] = [];
        if (projects.length > 0) {
            result.push({ type: 'moc', file: null, sectionHeader: `项目 · ${projects.length}` });
            result.push(...projects);
        }
        if (normals.length > 0) {
            result.push({ type: 'moc', file: null, sectionHeader: `普通思维树 · ${normals.length}` });
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
        left.style.cssText = 'display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1;';

        const name = left.createSpan();
        name.setText(file.basename);
        name.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0;';

        // 项目挂载所在的文件夹名(可能多个)
        if (item.isProject && this.vaultIndex) {
            const folders = this.vaultIndex.getFoldersHostingMoc(file.path);
            if (folders.length > 0) {
                const folderEl = left.createSpan();
                folderEl.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-muted); min-width: 0;';
                folderEl.setText('· ' + folders.map(f => f.name).join(' / '));
            }
        }

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
