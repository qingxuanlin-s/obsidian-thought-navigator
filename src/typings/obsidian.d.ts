import "obsidian";

declare module "obsidian"{
    interface Workspace{
        on(
            name:"zk-navigation:refresh-local-graph",
            callback: ()=>unknown
        ):EventRef;
    }

    interface Workspace{
        on(
            name:"zk-navigation:refresh-index-graph",
            callback: ()=>unknown
        ):EventRef;
    }

    interface Workspace{
        on(
            name:"zk-navigation:refresh-outline-view",
            callback: ()=>unknown
        ):EventRef;
    }

    interface Workspace{
        on(
            name:"zk-navigation:refresh-table-view",
            callback: ()=>unknown
        ):EventRef;
    }

    interface Workspace{
        on(
            name:"zk-navigation:refresh-recent-view",
            callback: ()=>unknown
        ):EventRef;
    }

    interface Workspace{
        on(
            name:"zk-navigation:moc-file-changed",
            callback: (mocFile: TFile)=>unknown
        ):EventRef;
    }

    interface Workspace{
        on(
            name:"zk-navigation:moc-reverse-index-ready",
            callback: ()=>unknown
        ):EventRef;
    }

    interface App {
        commands:{
            commands:{
                [id:string]: Command;
            };
            executeCommandById: (id: string) => void;
        }
    }
}

// Obsidian 会在每个窗口(含弹出窗口)上挂载 DOM 构造辅助函数,
// 官方类型只声明为全局函数;这里补到 Window 上以便使用 activeWindow.createEl 等。
declare global {
    interface Window {
        createEl: typeof createEl;
        createDiv: typeof createDiv;
        createSpan: typeof createSpan;
        createSvg: typeof createSvg;
        createFragment: typeof createFragment;
    }
}
