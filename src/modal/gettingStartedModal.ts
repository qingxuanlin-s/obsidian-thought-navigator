import { App, Modal } from "obsidian";
import { t } from "src/lang/helper";

interface TutorialStep {
	title: string;
	body: string;
}

export class GettingStartedModal extends Modal {
	private onDismiss: () => void;

	constructor(app: App, onDismiss: () => void) {
		super(app);
		this.onDismiss = onDismiss;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('zk-getting-started-modal');

		const header = contentEl.createDiv({ cls: 'zk-getting-started-header' });
		header.createEl('h2', { text: t('Getting started title') });
		header.createDiv({
			cls: 'zk-getting-started-subtitle',
			text: t('Getting started subtitle'),
		});

		const steps: TutorialStep[] = [
			{
				title: t('Getting started step create title'),
				body: t('Getting started step create body'),
			},
			{
				title: t('Getting started step open title'),
				body: t('Getting started step open body'),
			},
			{
				title: t('Getting started step edit title'),
				body: t('Getting started step edit body'),
			},
			{
				title: t('Getting started step local title'),
				body: t('Getting started step local body'),
			},
		];

		const list = contentEl.createDiv({ cls: 'zk-getting-started-steps' });
		steps.forEach((step, index) => {
			const item = list.createDiv({ cls: 'zk-getting-started-step' });
			item.createDiv({
				cls: 'zk-getting-started-step-number',
				text: String(index + 1),
			});
			const copy = item.createDiv({ cls: 'zk-getting-started-step-copy' });
			copy.createEl('h3', { text: step.title });
			copy.createEl('p', { text: step.body });
		});

		const tips = contentEl.createDiv({ cls: 'zk-getting-started-tips' });
		tips.createDiv({
			cls: 'zk-getting-started-tip-title',
			text: t('Getting started tips title'),
		});
		const tipList = tips.createEl('ul');
		tipList.createEl('li', { text: t('Getting started tip search') });
		tipList.createEl('li', { text: t('Getting started tip paste') });
		tipList.createEl('li', { text: t('Getting started tip workspace') });

		const footer = contentEl.createDiv({ cls: 'zk-getting-started-footer' });
		const btn = footer.createEl('button', {
			text: t('Getting started dismiss'),
			cls: 'mod-cta',
		});
		btn.onclick = () => this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDismiss();
	}
}
