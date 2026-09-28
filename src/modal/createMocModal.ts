import { App, FuzzySuggestModal, Modal, TFile } from "obsidian";
import { t, TKey } from "src/lang/helper";
import { isMocFile, stripMocSuffix } from "src/utils/utils";
import { MocCandidate, MocCreationRules, MocPreviewNode, MocRuleCondition, MocRulePreview, mocJsonFromPreview, previewMocRules } from "src/utils/mocRuleEngine";

export interface MocCreationSetup { name: string; content?: string }

class RootPicker extends FuzzySuggestModal<TFile> {
	constructor(app: App, private files: TFile[], private choose: (file: TFile) => void) {
		super(app);
		this.setPlaceholder(t('Search root note'));
	}
	getItems(): TFile[] { return this.files; }
	getItemText(file: TFile): string { return file.path; }
	onChooseItem(file: TFile): void { this.choose(file); }
}

function getCandidates(app: App): MocCandidate[] {
	return app.vault.getMarkdownFiles().filter(file => !isMocFile(file)).map(file => ({
		path: file.path, basename: file.basename, folder: file.parent?.name ?? '',
		properties: app.metadataCache.getFileCache(file)?.frontmatter ?? {},
	}));
}

const newCondition = (): MocRuleCondition => ({ field: 'filename', operator: 'contains', value: '' });
const ruleErrorKeys: Record<string, TKey> = {
	'Each group needs a condition': 'Each group needs a condition',
	'Enter a property name': 'Enter a property name',
	'Enter a condition value': 'Enter a condition value',
	'Enter a hierarchy separator': 'Enter a hierarchy separator',
	'Enter a hierarchy property': 'Enter a hierarchy property',
	'Selected root does not match the filter': 'Selected root does not match the filter',
	'Selected root has no hierarchy key': 'Selected root has no hierarchy key',
};
function ruleError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return ruleErrorKeys[message] ? t(ruleErrorKeys[message]) : message;
}

export function requestMOCSetup(app: App, defaultName = ''): Promise<MocCreationSetup | null> {
	return new Promise(resolve => {
		new class extends Modal {
			private settled = false;
			private populate = false;
			private name = defaultName;
			private rules: MocCreationRules = {
				groupJoin: 'and', groups: [], parentSource: 'filename', parentProperty: '',
				separator: '.', stopMarker: ' ', rootPath: '',
			};
			private rulesEl!: HTMLElement;
			private previewEl!: HTMLElement;
			private createButton!: HTMLButtonElement;
			private preview: MocRulePreview | null = null;

			private finish(result: MocCreationSetup | null): void {
				if (this.settled) return;
				this.settled = true;
				resolve(result);
			}
			private invalidate(): void {
				this.preview = null;
				this.createButton.disabled = this.populate;
				this.previewEl.empty();
				if (this.populate) this.previewEl.setText(t('Preview to review matching notes'));
			}
			private select(parent: HTMLElement, options: Array<[string, string]>, value: string, changed: (value: string) => void): void {
				const select = parent.createEl('select');
				for (const [key, label] of options) select.createEl('option', { value: key, text: label });
				select.value = value;
				select.addEventListener('change', () => { changed(select.value); this.invalidate(); });
			}
			private renderGroups(): void {
				const host = this.rulesEl.querySelector('.zk-moc-rule-groups') as HTMLElement;
				host.empty();
				if (!this.rules.groups.length) host.createEl('p', { cls: 'setting-item-description', text: t('No groups means all notes') });
				this.rules.groups.forEach((group, groupIndex) => {
					const card = host.createDiv('zk-moc-rule-group');
					const header = card.createDiv('zk-moc-rule-group-header');
					header.createEl('strong', { text: t('Condition group') + ` ${groupIndex + 1}` });
					this.select(header, [['and', t('All conditions')], ['or', t('Any condition')]], group.join, value => { group.join = value as 'and' | 'or'; });
					header.createEl('button', { text: t('Remove group') }).addEventListener('click', () => {
						this.rules.groups.splice(groupIndex, 1); this.renderGroups(); this.invalidate();
					});
					group.conditions.forEach((condition, conditionIndex) => {
						const row = card.createDiv('zk-moc-rule-condition');
						this.select(row, [['filename', t('File name')], ['folder', t('Folder name')], ['property', t('Property')]], condition.field, value => {
							condition.field = value as MocRuleCondition['field']; this.renderGroups();
						});
						if (condition.field === 'property') {
							const property = row.createEl('input', { type: 'text', placeholder: t('Property name') });
							property.value = condition.property ?? '';
							property.addEventListener('input', () => { condition.property = property.value; this.invalidate(); });
						}
						this.select(row, [
							['contains', t('Contains')], ['notContains', t('Does not contain')], ['equals', t('Equals')],
							['startsWith', t('Starts with')], ['endsWith', t('Ends with')], ['exists', t('Exists')],
						], condition.operator, value => { condition.operator = value as MocRuleCondition['operator']; this.renderGroups(); });
						if (condition.operator !== 'exists') {
							const input = row.createEl('input', { type: 'text', placeholder: t('Condition value') });
							input.value = condition.value;
							input.addEventListener('input', () => { condition.value = input.value; this.invalidate(); });
						}
						row.createEl('button', { text: '×', attr: { 'aria-label': t('Remove condition') } }).addEventListener('click', () => {
							group.conditions.splice(conditionIndex, 1); this.renderGroups(); this.invalidate();
						});
					});
					card.createEl('button', { text: t('Add condition') }).addEventListener('click', () => {
						group.conditions.push(newCondition()); this.renderGroups(); this.invalidate();
					});
				});
			}
			private renderTree(nodes: MocPreviewNode[], host: HTMLElement, counter: { value: number }): void {
				const list = host.createEl('ul');
				for (const node of nodes) {
					if (counter.value >= 100) break;
					counter.value++;
					const item = list.createEl('li');
					item.createSpan({ text: node.file.basename });
					item.createSpan({ cls: 'zk-moc-rule-path', text: ` · ${node.file.path}` });
					if (node.children.length) this.renderTree(node.children, item, counter);
				}
			}
			private runPreview(): void {
				this.previewEl.empty();
				try {
					const result = previewMocRules(getCandidates(app), this.rules);
					this.preview = result;
					this.createButton.disabled = result.included === 0;
					this.previewEl.createEl('p', { text: t('MOC preview summary')
						.replace('{matched}', String(result.matched.length))
						.replace('{included}', String(result.included))
						.replace('{excluded}', String(result.excludedByRoot)) });
					if (!result.included) this.previewEl.createEl('p', { text: t('No notes match rules') });
					else this.renderTree(result.roots, this.previewEl, { value: 0 });
					if (result.included > 100) this.previewEl.createEl('p', { text: t('Preview first 100 notes') });
					if (result.missingKeys) this.previewEl.createEl('p', { text: t('Notes without hierarchy key').replace('{count}', String(result.missingKeys)) });
				} catch (error) {
					this.preview = null;
					this.createButton.disabled = true;
					this.previewEl.createEl('p', { cls: 'zk-moc-rule-error', text: ruleError(error) });
				}
			}
			private renderRules(): void {
				this.rulesEl.empty();
				this.rulesEl.setCssStyles({ display: this.populate ? '' : 'none' });
				if (!this.populate) return;
				const filter = this.rulesEl.createDiv('zk-moc-rule-section');
				filter.createEl('h3', { text: t('Filter notes') });
				const between = filter.createDiv('zk-moc-rule-line');
				between.createSpan({ text: t('Between groups') });
				this.select(between, [['and', t('All groups')], ['or', t('Any group')]], this.rules.groupJoin, value => { this.rules.groupJoin = value as 'and' | 'or'; });
				filter.createDiv('zk-moc-rule-groups');
				this.renderGroups();
				filter.createEl('button', { text: t('Add condition group') }).addEventListener('click', () => {
					this.rules.groups.push({ join: 'and', conditions: [newCondition()] }); this.renderGroups(); this.invalidate();
				});

				const hierarchy = this.rulesEl.createDiv('zk-moc-rule-section');
				hierarchy.createEl('h3', { text: t('Parent-child aggregation') });
				const source = hierarchy.createDiv('zk-moc-rule-line');
				source.createSpan({ text: t('Hierarchy source') });
				this.select(source, [['filename', t('File name')], ['property', t('Property')]], this.rules.parentSource, value => {
					this.rules.parentSource = value as 'filename' | 'property'; this.renderRules();
				});
				if (this.rules.parentSource === 'property') {
					const property = hierarchy.createEl('input', { type: 'text', placeholder: t('Hierarchy property') });
					property.value = this.rules.parentProperty;
					property.addEventListener('input', () => { this.rules.parentProperty = property.value; this.invalidate(); });
				}
				for (const [label, key] of [[t('Hierarchy separator'), 'separator'], [t('Stop marker'), 'stopMarker']] as const) {
					const line = hierarchy.createDiv('zk-moc-rule-line');
					line.createSpan({ text: label });
					const input = line.createEl('input', { type: 'text' });
					input.value = this.rules[key];
					if (key === 'stopMarker') input.placeholder = t('Space is default stop marker');
					input.addEventListener('input', () => { this.rules[key] = input.value; this.invalidate(); });
				}
				hierarchy.createEl('p', { cls: 'setting-item-description', text: t('Hierarchy example') });
				const root = hierarchy.createDiv('zk-moc-rule-line');
				root.createSpan({ text: t('Root note') });
				const rootLabel = root.createSpan({ cls: 'zk-moc-rule-root', text: this.rules.rootPath || t('Automatic roots') });
				root.createEl('button', { text: t('Choose root') }).addEventListener('click', () => {
					try {
						const matched = previewMocRules(getCandidates(app), { ...this.rules, rootPath: '' }).matched;
						const paths = new Set(matched.map(file => file.path));
						new RootPicker(app, app.vault.getMarkdownFiles().filter(file => paths.has(file.path)), file => {
							this.rules.rootPath = file.path; rootLabel.setText(file.path); this.invalidate();
						}).open();
					} catch (error) { this.previewEl.setText(ruleError(error)); }
				});
				root.createEl('button', { text: t('Clear root') }).addEventListener('click', () => {
					this.rules.rootPath = ''; rootLabel.setText(t('Automatic roots')); this.invalidate();
				});
				this.rulesEl.createEl('button', { text: t('Preview rules') }).addEventListener('click', () => this.runPreview());
			}
			onOpen(): void {
				this.titleEl.setText(t('New MOC file'));
				this.modalEl.addClass('zk-moc-create-modal');
				const nameLine = this.contentEl.createDiv('zk-moc-rule-line');
				nameLine.createEl('label', { text: t('MOC name') });
				const nameInput = nameLine.createEl('input', { type: 'text' });
				nameInput.value = this.name;
				nameInput.addEventListener('input', () => { this.name = nameInput.value; });
				const toggle = this.contentEl.createDiv('zk-moc-rule-line');
				const checkbox = toggle.createEl('input', { type: 'checkbox' });
				checkbox.id = 'zk-moc-populate';
				toggle.createEl('label', { text: t('Populate from existing notes'), attr: { for: checkbox.id } });
				checkbox.addEventListener('change', () => { this.populate = checkbox.checked; this.renderRules(); this.invalidate(); });
				this.rulesEl = this.contentEl.createDiv('zk-moc-rule-editor');
				this.previewEl = this.contentEl.createDiv('zk-moc-rule-preview');
				const footer = this.contentEl.createDiv('zk-moc-rule-footer');
				footer.createEl('button', { text: t('Cancel') }).addEventListener('click', () => this.close());
				this.createButton = footer.createEl('button', { cls: 'mod-cta', text: t('Create') });
				this.createButton.addEventListener('click', () => {
					const name = stripMocSuffix(this.name.trim()).trim();
					if (!name) { nameInput.focus(); return; }
					if (this.populate && !this.preview) return;
					this.finish({ name, content: this.populate && this.preview ? mocJsonFromPreview(this.preview, 'auto') : undefined });
					this.close();
				});
				nameInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !this.populate) this.createButton.click(); });
				this.renderRules();
				window.setTimeout(() => nameInput.focus(), 0);
			}
			onClose(): void { this.contentEl.empty(); this.finish(null); }
		}(app).open();
	});
}
