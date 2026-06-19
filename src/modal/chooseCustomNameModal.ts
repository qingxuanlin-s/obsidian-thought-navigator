// copy from obsidian-commander plugin: https://github.com/phibr0/obsidian-commander

import { App, SuggestModal } from "obsidian";
import { t } from "src/lang/helper";

export default class chooseCustomNameModal extends SuggestModal<string> {
	// eslint-disable-next-line no-unused-vars -- assigned by the constructor and read in onOpen; eslint cannot track the cross-method use
	defaultName:string;

	public constructor(app:App, defaultName: string) {
		super(app);
		this.defaultName = defaultName;
		this.setPlaceholder(t("Use a custom name"));
		this.resultContainerEl.setCssStyles({ display: "none" });

		this.setInstructions([
			{
				command: "",
				purpose: t("Choose a custom Name for your new Command"),
			},
			{
				command: "↵",
				purpose: t("to save"),
			},
			{
				command: "esc",
				purpose: t("to cancel"),
			},
		]);
	}

	public onOpen(): void {
		super.onOpen();

		this.inputEl.value = this.defaultName;
		const wrapper = createDiv({ cls: "zk-name-input-wrapper" });
		this.inputEl.parentNode?.insertBefore(wrapper, this.inputEl);
		wrapper.appendChild(this.inputEl);
		wrapper.parentElement!.setCssStyles({ display: "block" });

		const btn = createEl("button", { text: t("Save"), cls: "mod-cta" });
		btn.onclick = (e): void => this.selectSuggestion(this.inputEl.value, e);
		wrapper.appendChild(btn);
	}

	public async awaitSelection(): Promise<string> {
		this.open();
		return new Promise((resolve, reject) => {
			this.onChooseSuggestion = (item): void => resolve(item);
			//This is wrapped inside a setTimeout, because onClose is called before onChooseItem
			this.onClose = (): number =>
				window.setTimeout(() => reject("No Name selected"), 0);
		});
	}

	public getSuggestions(query: string): string[] | Promise<string[]> {
		return [query];
	}

	// eslint-disable-next-line no-unused-vars, @typescript-eslint/no-empty-function -- intentionally empty: a plain text field with no suggestion rendering is wanted
	public renderSuggestion(value: string, el: HTMLElement): void {}

	// eslint-disable-next-line no-unused-vars, @typescript-eslint/no-empty-function -- placeholder override; the real handler is assigned in awaitSelection
	public onChooseSuggestion(
		item: string,
		evt: MouseEvent | KeyboardEvent
	): void {}
}