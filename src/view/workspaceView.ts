import { ItemView, WorkspaceLeaf } from "obsidian";
import ZKNavigationPlugin from "main";
import { t } from "src/lang/helper";
import { WorkspacePanel } from "./workspace/WorkspacePanel";

export const ZK_WORKSPACE_TYPE = "zk-workspace-view";

/** 独立工作区视图 —— 薄壳,渲染逻辑全在 WorkspacePanel(与 indexView 内嵌共用一份实现) */
export class ZKWorkspaceView extends ItemView {
    private plugin: ZKNavigationPlugin;
    private panel: WorkspacePanel | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: ZKNavigationPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string { return ZK_WORKSPACE_TYPE; }
    getDisplayText(): string { return t("ws Workspace"); }
    getIcon(): string { return "layout-grid"; }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('zk-workspace-host');
        this.panel = new WorkspacePanel(this.contentEl, {
            app: this.app,
            store: this.plugin.workspaceStore!,
            session: this.plugin.workspaceSession,
            taskStore: this.plugin.workspaceTaskStore!,
            owner: this,
            projectFolderPath: this.plugin.settings.projectFolderPath,
            taskPrefix: this.plugin.settings.wsTaskPrefix,
            taskPrefixAuto: this.plugin.settings.wsTaskPrefixAuto !== false,
            taskFileTag: this.plugin.settings.wsTaskFileTag,
        });
    }

    async onClose(): Promise<void> {
        this.panel?.destroy();
        this.panel = null;
        // 共享 <style> 不在此移除(内嵌面板可能仍在用),留存无害
    }
}
