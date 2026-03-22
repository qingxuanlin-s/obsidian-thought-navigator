import { App, SuggestModal, setIcon } from "obsidian";
import { MOCReverseIndex, MOCLocation } from "src/utils/mocReverseIndex";
import { t } from "src/lang/helper";

/**
 * 搜索结果项
 */
interface NoteSearchItem {
    notePath: string;
    noteBasename: string;
    locations: MOCLocation[];
}

/**
 * 笔记搜索 Modal — 从反向索引模糊搜索笔记，选择后定位到所在 MOC
 */
export class NoteSearchModal extends SuggestModal<NoteSearchItem> {
    private reverseIndex: MOCReverseIndex;
    private onChoose: (notePath: string, location: MOCLocation) => void;

    constructor(
        app: App,
        reverseIndex: MOCReverseIndex,
        onChoose: (notePath: string, location: MOCLocation) => void
    ) {
        super(app);
        this.reverseIndex = reverseIndex;
        this.onChoose = onChoose;
        this.setPlaceholder(t("Search notes in MOC trees"));
        this.limit = 50;
    }

    getSuggestions(query: string): NoteSearchItem[] {
        return this.reverseIndex.fuzzySearch(query, 50);
    }

    renderSuggestion(item: NoteSearchItem, el: HTMLElement) {
        el.addClass("zk-note-search-item");

        const content = el.createDiv("zk-note-search-content");
        const nameEl = content.createDiv("zk-note-search-name");
        nameEl.setText(item.noteBasename);

        // 显示 MOC 列表摘要
        const mocsEl = content.createDiv("zk-note-search-mocs");
        const mocNames = item.locations.map(loc => loc.mocFileName);
        // 最多显示 3 个 MOC 名
        const display = mocNames.length > 3
            ? mocNames.slice(0, 3).join(", ") + ` +${mocNames.length - 3}`
            : mocNames.join(", ");
        mocsEl.setText(display);

        // 右侧 MOC 数量徽章
        const badge = el.createDiv("zk-note-search-badge");
        badge.setText(`${item.locations.length} MOC${item.locations.length > 1 ? 's' : ''}`);
    }

    onChooseSuggestion(item: NoteSearchItem, evt: MouseEvent | KeyboardEvent) {
        if (item.locations.length === 1) {
            // 只有一个 MOC，直接跳转
            this.onChoose(item.notePath, item.locations[0]);
        } else {
            // 多个 MOC，弹出二级选择
            new MOCPickerModal(this.app, item.noteBasename, item.locations, (location) => {
                this.onChoose(item.notePath, location);
            }).open();
        }
    }
}

/**
 * MOC 选择 Modal（二级）— 从多个 MOC 中选择一个
 */
class MOCPickerModal extends SuggestModal<MOCLocation> {
    private noteName: string;
    private locations: MOCLocation[];
    private onPick: (location: MOCLocation) => void;

    constructor(
        app: App,
        noteName: string,
        locations: MOCLocation[],
        onPick: (location: MOCLocation) => void
    ) {
        super(app);
        this.noteName = noteName;
        this.locations = locations;
        this.onPick = onPick;
        this.setPlaceholder(`"${noteName}" ${t("exists in multiple MOCs, choose one")}`);
    }

    getSuggestions(query: string): MOCLocation[] {
        if (!query.trim()) return this.locations;
        const lower = query.toLowerCase();
        return this.locations.filter(loc =>
            loc.mocFileName.toLowerCase().includes(lower)
        );
    }

    renderSuggestion(loc: MOCLocation, el: HTMLElement) {
        el.addClass("zk-moc-picker-item");

        const iconEl = el.createSpan("zk-moc-picker-icon");
        setIcon(iconEl, "book-open");

        const content = el.createDiv("zk-moc-picker-content");
        content.createDiv("zk-moc-picker-name").setText(loc.mocFileName);

        const detail = content.createDiv("zk-moc-picker-detail");
        detail.setText(`${t("Node ID")}: ${loc.nodeId}`);
    }

    onChooseSuggestion(loc: MOCLocation, evt: MouseEvent | KeyboardEvent) {
        this.onPick(loc);
    }
}
