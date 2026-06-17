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
        this.setPlaceholder("搜索 MOC 文件...");

        // 按 mtime 倒序(编辑时间)
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

        // 不再区分项目/普通思维树:统一一个列表,按编辑时间(mtime)倒序。
        return filtered.map(f => ({ type: 'moc', file: f, isProject: this.isProjectMoc(f) }));
    }

    renderSuggestion(item: MOCItem, el: HTMLElement): void {
        // 分组标题
        if (item.sectionHeader) {
            el.setCssStyles({
                padding: '6px 12px',
                fontSize: '10.5px',
                color: 'var(--text-muted)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                fontWeight: '600',
                cursor: 'default',
                background: 'var(--background-secondary)',
            });
            el.setText(item.sectionHeader);
            // 分组项不可选
            el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
            return;
        }

        const file = item.file;
        if (!file) return;

        el.setCssStyles({
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
        });

        const left = el.createDiv();
        left.setCssStyles({
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            minWidth: '0',
            flex: '1',
        });

        const name = left.createSpan();
        name.setText(file.basename);
        name.setCssStyles({
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: '0',
        });

        // 项目挂载所在的文件夹名(可能多个)
        if (item.isProject && this.vaultIndex) {
            const folders = this.vaultIndex.getFoldersHostingMoc(file.path);
            if (folders.length > 0) {
                const folderEl = left.createSpan();
                folderEl.setCssStyles({
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: '11px',
                    color: 'var(--text-muted)',
                    minWidth: '0',
                });
                folderEl.setText('· ' + folders.map(f => f.name).join(' / '));
            }
        }

        const timeEl = el.createDiv();
        timeEl.setCssStyles({
            fontSize: '11px',
            color: 'var(--text-muted)',
            flexShrink: '0',
            marginLeft: '8px',
        });
        timeEl.setText(formatRelativeTime(file.stat.mtime));
    }

    onChooseSuggestion(item: MOCItem, evt: MouseEvent | KeyboardEvent): void {
        // 分组标题被点到则忽略
        if (item.sectionHeader || !item.file) return;
        this.onSubmit(item);
    }
}
