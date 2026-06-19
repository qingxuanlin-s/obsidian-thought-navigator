import { App, Modal } from "obsidian";
import { t } from "src/lang/helper";

export interface TaskModalInit { description?: string; priority?: string; start?: string; due?: string; }
export interface TaskModalResult { description: string; priority: string; start?: string; due?: string; }

/**
 * 任务编辑弹框:描述 + 优先级 + 开始/截止日期。
 * 新建任务、新建子任务、编辑既有任务三处复用(由调用方决定提交后如何落盘)。
 */
export class TaskModal extends Modal {
    constructor(app: App, private opts: { header: string; submitLabel: string; initial?: TaskModalInit; onSubmit: (r: TaskModalResult) => void }) {
        super(app);
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText(this.opts.header);
        const init = this.opts.initial ?? {};

        const field = (label: string) => {
            contentEl.createEl('div', { text: label }).setCssStyles({ fontSize: '12px', color: 'var(--text-muted)', margin: '10px 0 4px' });
        };
        const fullWidth = { width: '100%' } as const;

        field(t('ws action text placeholder'));
        const desc = contentEl.createEl('input', { type: 'text' });
        desc.setCssStyles(fullWidth);
        desc.value = init.description ?? '';

        field(t('ws action priority'));
        const prio = contentEl.createEl('select');
        prio.setCssStyles(fullWidth);
        ([['', t('ws prio none')], ['🔺', t('ws prio highest')], ['⏫', t('ws prio high')],
          ['🔼', t('ws prio medium')], ['🔽', t('ws prio low')], ['⏬', t('ws prio lowest')]] as [string, string][])
            .forEach(([val, label]) => prio.createEl('option', { value: val, text: val ? `${val} ${label}` : label }));
        prio.value = init.priority ?? '';

        const dateRow = contentEl.createDiv();
        dateRow.setCssStyles({ display: 'flex', gap: '12px', marginTop: '4px' });
        const mkDate = (label: string, val?: string) => {
            const col = dateRow.createDiv();
            col.setCssStyles({ flex: '1' });
            col.createEl('div', { text: label }).setCssStyles({ fontSize: '12px', color: 'var(--text-muted)', margin: '6px 0 4px' });
            const inp = col.createEl('input', { type: 'date' });
            inp.setCssStyles({ width: '100%' });
            if (val) inp.value = val;
            return inp;
        };
        const start = mkDate(t('ws action start'), init.start);
        const due = mkDate(t('ws action due'), init.due);

        const foot = contentEl.createDiv();
        foot.setCssStyles({ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' });
        const cancel = foot.createEl('button', { text: t('ws cancel') });
        cancel.onclick = () => this.close();
        const ok = foot.createEl('button', { cls: 'mod-cta', text: this.opts.submitLabel });
        const submit = () => {
            const v = desc.value.trim();
            if (!v) { desc.focus(); return; }
            this.opts.onSubmit({ description: v, priority: prio.value, start: start.value || undefined, due: due.value || undefined });
            this.close();
        };
        ok.onclick = submit;
        desc.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
        setTimeout(() => desc.focus(), 0);
    }

    onClose() { this.contentEl.empty(); }
}

/** 轻量单行输入弹窗:回车/创建提交,Esc/取消关闭 */
export function promptTitle(app: App, header: string, onSubmit: (value: string) => void, initial = ''): void {
    new class extends Modal {
        onOpen() {
            this.titleEl.setText(header);
            const input = this.contentEl.createEl('input', { type: 'text' });
            input.setCssStyles({
                width: '100%',
                marginBottom: '14px',
            });
            input.value = initial;
            const foot = this.contentEl.createDiv();
            foot.setCssStyles({
                display: 'flex',
                gap: '8px',
                justifyContent: 'flex-end',
            });
            const cancel = foot.createEl('button', { text: t('ws cancel') });
            cancel.onclick = () => this.close();
            const ok = foot.createEl('button', { cls: 'mod-cta', text: t('ws create') });
            const submit = () => { const v = input.value.trim(); if (!v) { input.focus(); return; } onSubmit(v); this.close(); };
            ok.onclick = submit;
            input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
            setTimeout(() => input.focus(), 0);
        }
        onClose() { this.contentEl.empty(); }
    }(app).open();
}
