import { App, Modal } from "obsidian";
import { t } from "src/lang/helper";

/** 收集交互式创建 MOC 的文件名；取消时返回 null。 */
export function requestMOCName(app: App): Promise<string | null> {
	return new Promise((resolve) => {
		new class extends Modal {
			private settled = false;

			private finish(value: string | null): void {
				if (this.settled) return;
				this.settled = true;
				resolve(value);
			}

			onOpen() {
				this.titleEl.setText(t("New MOC file"));
				const input = this.contentEl.createEl("input", { type: "text" });
				input.placeholder = t("MOC name");
				input.setCssStyles({ width: "100%", marginBottom: "14px" });

				const footer = this.contentEl.createDiv();
				footer.setCssStyles({ display: "flex", gap: "8px", justifyContent: "flex-end" });
				const cancel = footer.createEl("button", { text: t("Cancel") });
				cancel.onclick = () => this.close();
				const create = footer.createEl("button", { cls: "mod-cta", text: t("Create") });
				const submit = () => {
					const name = input.value.trim();
					if (!name) {
						input.focus();
						return;
					}
					this.finish(name);
					this.close();
				};
				create.onclick = submit;
				input.onkeydown = (event) => { if (event.key === "Enter") submit(); };
				window.setTimeout(() => input.focus(), 0);
			}

			onClose() {
				this.contentEl.empty();
				this.finish(null);
			}
		}(app).open();
	});
}
