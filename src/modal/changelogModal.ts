import { App, Modal, getLanguage } from "obsidian";
import { t } from "src/lang/helper";
import { ChangelogEntry } from "src/utils/changelog";

/**
 * 版本更新公告 Modal。展示自上次启动以来新增的所有 changelog 条目。
 */
export class ChangelogModal extends Modal {
    private entries: ChangelogEntry[];
    private currentVersion: string;
    private onDismiss: () => void;

    constructor(app: App, entries: ChangelogEntry[], currentVersion: string, onDismiss: () => void) {
        super(app);
        this.entries = entries;
        this.currentVersion = currentVersion;
        this.onDismiss = onDismiss;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('zk-changelog-modal');

        const header = contentEl.createDiv({ cls: 'zk-changelog-header' });
        header.createEl('h2', { text: t('Changelog title') });
        header.createDiv({
            cls: 'zk-changelog-subtitle',
            text: t('Changelog subtitle').replace('{version}', this.currentVersion),
        });

        const list = contentEl.createDiv({ cls: 'zk-changelog-list' });
        const lang = this.resolveLang();

        for (const entry of this.entries) {
            const section = list.createDiv({ cls: 'zk-changelog-entry' });
            const head = section.createDiv({ cls: 'zk-changelog-entry-head' });
            head.createEl('span', { cls: 'zk-changelog-version', text: `v${entry.version}` });
            head.createEl('span', { cls: 'zk-changelog-date', text: entry.date });

            const ul = section.createEl('ul', { cls: 'zk-changelog-highlights' });
            for (const item of entry.highlights) {
                ul.createEl('li', { text: item[lang] });
            }
        }

        const footer = contentEl.createDiv({ cls: 'zk-changelog-footer' });
        const btn = footer.createEl('button', { text: t('Changelog dismiss'), cls: 'mod-cta' });
        btn.onclick = () => this.close();
    }

    onClose(): void {
        this.contentEl.empty();
        this.onDismiss();
    }

    private resolveLang(): 'zh' | 'en' {
        const lang = (getLanguage() || '').toLowerCase();
        return lang.startsWith('zh') ? 'zh' : 'en';
    }
}
