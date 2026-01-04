import { App, FuzzySuggestModal, TFile } from "obsidian";

interface MOCItem {
    type: 'moc' | 'roadmap';
    file: TFile | null;
}

export class MOCSelectorModal extends FuzzySuggestModal<MOCItem> {
    mocFiles: TFile[];
    onSubmit: (item: MOCItem) => void;

    constructor(app: App, mocFiles: TFile[], onSubmit: (item: MOCItem) => void) {
        super(app);
        this.mocFiles = mocFiles;
        this.onSubmit = onSubmit;
        this.setPlaceholder("搜索 MOC 文件...");
    }

    getItems(): MOCItem[] {
        return this.mocFiles.map(f => ({ type: 'moc' as const, file: f }));
    }

    getItemText(item: MOCItem): string {
        return item.file?.basename || '';
    }

    onChooseItem(item: MOCItem, evt: MouseEvent | KeyboardEvent) {
        this.onSubmit(item);
    }
}
