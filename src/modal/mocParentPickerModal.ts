import { App, SuggestModal, setIcon } from "obsidian";
import { t } from "src/lang/helper";
import { MOCParentLocation } from "src/utils/mocReverseIndex";

/** 选择当前 MOC 的一个全局结构父级。 */
export class MOCParentPickerModal extends SuggestModal<MOCParentLocation> {
    constructor(
        app: App,
        private parents: MOCParentLocation[],
        private onChooseParent: (parent: MOCParentLocation) => void,
    ) {
        super(app);
        this.setPlaceholder(t('moc parent picker placeholder'));
    }

    getSuggestions(query: string): MOCParentLocation[] {
        const q = query.trim().toLowerCase();
        return this.parents.filter(parent => !q || `${parent.parentMocName} ${parent.parentMocPath}`.toLowerCase().includes(q));
    }

    renderSuggestion(parent: MOCParentLocation, el: HTMLElement): void {
        el.addClass('zk-moc-parent-picker-item');
        const icon = el.createSpan({ cls: 'zk-moc-parent-picker-icon' });
        setIcon(icon, 'git-fork');
        const content = el.createDiv({ cls: 'zk-moc-parent-picker-content' });
        content.createDiv({ cls: 'zk-moc-parent-picker-title', text: parent.parentMocName });
        content.createDiv({ cls: 'zk-moc-parent-picker-path', text: parent.parentMocPath });
    }

    onChooseSuggestion(parent: MOCParentLocation): void {
        this.onChooseParent(parent);
    }
}
