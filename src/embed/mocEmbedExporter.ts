import { App, MarkdownRenderChild, TFile } from "obsidian";
import ZKNavigationPlugin from "main";
import { parseMOCJson } from "src/utils/mocJsonCodec";
import { convertMOCToZKNodes } from "src/utils/utils";
import { GraphDataBuilder } from "src/renderer/GraphDataBuilder";
import { CytoscapeRenderer } from "src/renderer/CytoscapeRenderer";
import { RenderOptions } from "src/renderer/types";

const PNG_SUFFIX = '.png';

/**
 * 计算 PNG 附件路径：保存在 .moc 文件所在目录的 attachments 子目录下
 */
function getPNGPath(mocFile: TFile): string {
    const dir = mocFile.parent?.path || '';
    const pngName = mocFile.name + PNG_SUFFIX;
    return dir ? `${dir}/attachments/${pngName}` : `attachments/${pngName}`;
}

/**
 * 将 .moc 文件渲染为 PNG，返回 PNG 的 TFile
 */
async function exportMOCToPNG(mocFile: TFile, plugin: ZKNavigationPlugin): Promise<TFile> {
    const app = plugin.app;
    const pngPath = getPNGPath(mocFile);

    // 读取并解析 .moc
    const content = await app.vault.read(mocFile);
    const mocData = parseMOCJson(content, mocFile.path, app);

    // 转换为 ZKNode
    const mocNodes = await convertMOCToZKNodes(
        plugin,
        mocData.nodes,
        mocData.reverseRelations,
        [],
        mocData.nodePositions
    );

    // 构建图形数据
    const graphData = GraphDataBuilder.fromMOCTree(
        mocNodes,
        mocData.reverseRelations,
        null,
        mocData.groups,
        mocData.edgeCurvatures,
        mocData.nodeColors,
        mocData.nodeStyleColors,
        mocData.crossDomainLinks || {},
        mocData.nodePositions,
        mocData.embedNodeSizes || {},
        mocData.nodeRemarks || {}
    );

    // 创建隐藏容器（Cytoscape 需要真实 DOM）
    const hiddenDiv = document.createElement('div');
    hiddenDiv.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1200px;height:800px;visibility:hidden;';
    document.body.appendChild(hiddenDiv);

    const renderer = new CytoscapeRenderer();
    let pngBytes: ArrayBuffer;

    try {
        const options: RenderOptions = {
            direction: (plugin.settings.DirectionOfBranchGraph || 'LR') as any,
            layoutType: 'dagre',
            animate: false,
            nodeText: (plugin.settings.NodeText || 'both') as any,
            themeMode: plugin.settings.themeMode,
            themeStyle: plugin.settings.themeStyle || 'default',
            edgeStyle: plugin.settings.edgeStyle || 'bezier',
            nodeLayoutStyle: mocData.nodeLayoutStyle || 'free',
            readOnly: true,
        };

        await renderer.render(hiddenDiv, graphData, options);

        const cy = renderer.getCytoscapeInstance();
        if (!cy) throw new Error('Cytoscape 实例不存在');

        // 导出 PNG（full:true 导出完整图，scale:2 高清）
        const dataUri: string = (cy as any).png({ output: 'base64uri', bg: 'white', full: true, scale: 2 });
        const base64 = dataUri.split(',')[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        pngBytes = bytes.buffer;
    } finally {
        renderer.destroy();
        document.body.removeChild(hiddenDiv);
    }

    // 确保 attachments 目录存在
    const attachmentsDir = pngPath.substring(0, pngPath.lastIndexOf('/'));
    if (!app.vault.getAbstractFileByPath(attachmentsDir)) {
        await app.vault.createFolder(attachmentsDir);
    }

    // 写入 vault
    const existingPng = app.vault.getFileByPath(pngPath);
    if (existingPng) {
        await app.vault.modifyBinary(existingPng, pngBytes);
        return existingPng;
    } else {
        return await app.vault.createBinary(pngPath, pngBytes);
    }
}

/**
 * 判断 PNG 是否需要重新生成（.moc 比 PNG 新）
 */
function pngNeedsUpdate(mocFile: TFile, pngFile: TFile | null): boolean {
    if (!pngFile) return true;
    return mocFile.stat.mtime > pngFile.stat.mtime;
}

/**
 * MarkdownRenderChild：处理 ![[xxx.moc]] 内嵌，展示为 PNG 图片
 */
export class MOCEmbedRenderChild extends MarkdownRenderChild {
    constructor(
        containerEl: HTMLElement,
        private mocFile: TFile,
        private plugin: ZKNavigationPlugin
    ) {
        super(containerEl);
    }

    async onload() {
        // 立即移除 src 属性，阻止 Obsidian 的 embed 处理器在我们之后覆盖内容
        this.containerEl.removeAttribute('src');
        this.containerEl.empty();
        this.containerEl.addClass('zk-moc-embed');

        const app = this.plugin.app;
        const pngPath = getPNGPath(this.mocFile);

        try {
            let pngFile = app.vault.getFileByPath(pngPath);

            if (pngNeedsUpdate(this.mocFile, pngFile)) {
                // 显示加载占位
                const loading = this.containerEl.createDiv('zk-moc-embed-loading');
                loading.setText('渲染思维树...');

                pngFile = await exportMOCToPNG(this.mocFile, this.plugin);
                loading.remove();
            }

            if (!pngFile) throw new Error('PNG 生成失败');

            // 显示图片
            const img = this.containerEl.createEl('img');
            img.addClass('zk-moc-embed-img');
            img.src = app.vault.getResourcePath(pngFile);
            img.style.cssText = 'width:100%;height:auto;border-radius:6px;';
            img.alt = this.mocFile.basename;
        } catch (e) {
            this.containerEl.createDiv('zk-moc-embed-error').setText(`思维树预览失败: ${e.message}`);
        }
    }
}
