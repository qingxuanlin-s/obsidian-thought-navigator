import "obsidian";

declare module "obsidian"{
    // 运行时自 Obsidian 1.8+ 提供;随包的 d.ts 版本较旧未声明,这里补上
    export function getLanguage(): string;

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

    interface App {
        commands:{
            commands:{
                [id:string]: Command;
            };
            executeCommandById: (id: string) => void;
        }
    }
}
