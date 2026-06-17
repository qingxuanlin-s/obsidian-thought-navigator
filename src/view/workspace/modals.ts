import { App, Modal } from "obsidian";
import { t } from "src/lang/helper";

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
