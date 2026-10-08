import { AbstractInputSuggest, App } from "obsidian";

export class TagSuggest extends AbstractInputSuggest<string> {

    inputEl: HTMLInputElement;

    constructor(app: App, inputEl: HTMLInputElement) {
        super(app, inputEl);
        this.inputEl = inputEl
    }
    getSuggestions(inputStr: string): string[] {
        // getTags 在当前 obsidian 类型版本中未声明,这里补最小调用表面
        const metadataCache = this.app.metadataCache as unknown as {
            getTags: () => Record<string, number>;
        };
        const allTags = Object.keys(metadataCache.getTags());
        const tags: string[] = [];
        const lowerCaseInputStr = inputStr.toLowerCase();

        allTags.forEach((tag: string) => {
            if (
                tag.toLowerCase().contains(lowerCaseInputStr)
            ) {
                tags.push(tag);
            }
        });
        
        return tags;
    }

    renderSuggestion(tag: string, el: HTMLElement): void {
        el.setText(tag);
    }

    selectSuggestion(tag: string): void {
        this.inputEl.value = tag;
        this.inputEl.trigger("input");
        this.close();
    }
}
