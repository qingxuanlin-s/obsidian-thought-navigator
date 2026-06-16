import { App, FuzzySuggestModal, TFile } from "obsidian";
import { t } from "src/lang/helper";

/** 从整个 vault 模糊搜索 markdown 笔记 */
class VaultFilePicker extends FuzzySuggestModal<TFile> {
    constructor(app: App, private onPick: (f: TFile) => void) {
        super(app);
        this.setPlaceholder(t('ws action pick title'));
    }
    getItems(): TFile[] {
        return this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
    }
    getItemText(f: TFile): string { return f.path; }
    onChooseItem(f: TFile): void { this.onPick(f); }
}

export function pickVaultFile(app: App, onPick: (f: TFile) => void): void {
    new VaultFilePicker(app, onPick).open();
}
