/**
 * 这是一个示例文件，展示如何在 ZKGraphView 中集成 CytoscapeRenderer
 * 
 * 使用方法：
 * 1. 在 ZKGraphView 类中添加 CytoscapeRenderer 实例
 * 2. 在 refreshLocalGraph 方法中使用 Cytoscape 渲染
 * 3. 监听自定义事件处理用户交互
 */

import { CytoscapeRenderer } from './CytoscapeRenderer';
import { GraphDataBuilder } from './GraphDataBuilder';
import { RenderOptions } from './types';

// ============================================
// 示例 1: 渲染家族图（Family Graph）
// ============================================
async function renderFamilyGraphExample(
    container: HTMLElement,
    familyNodes: any[],  // ZKNode[]
    currentFile: any,    // TFile
    plugin: any
) {
    // 1. 构建图形数据
    const graphData = GraphDataBuilder.fromFamilyNodes(familyNodes, currentFile);

    // 2. 创建渲染器
    const renderer = new CytoscapeRenderer();

    // 3. 配置渲染选项
    const options: RenderOptions = {
        direction: plugin.settings.DirectionOfFamilyGraph || 'TB',
        layoutType: 'dagre',  // 使用 dagre 布局，适合层级结构
        animate: true,
        animationDuration: 500,
        nodeText: plugin.settings.NodeText || 'both'
    };

    // 4. 渲染图形
    await renderer.render(container, graphData, options);

    // 5. 监听节点点击事件
    container.addEventListener('node-click', (event: any) => {
        const { node, ctrlKey, shiftKey, altKey } = event.detail;
        
        if (ctrlKey) {
            // Ctrl + 点击：在新标签页打开
            plugin.app.workspace.openLinkText("", node.file.path, 'tab');
        } else if (shiftKey) {
            // Shift + 点击：在图形视图中打开
            plugin.retrivalforLocaLgraph = {
                type: '1',
                ID: node.ID,
                filePath: node.file.path,
            };
            plugin.openGraphView();
        } else if (altKey) {
            // Alt + 点击：在索引视图中打开
            plugin.clearShowingSettings();
            plugin.settings.lastRetrival = {
                type: 'main',
                ID: node.ID,
                displayText: node.displayText,
                filePath: node.file.path,
                openTime: '',
            };
            plugin.RefreshIndexViewFlag = true;
            plugin.openIndexView();
        } else {
            // 普通点击：打开文件
            plugin.app.workspace.openLinkText("", node.file.path);
        }
    });

    // 6. 监听节点悬停事件（显示预览）
    container.addEventListener('node-hover', (event: any) => {
        const { node, event: mouseEvent } = event.detail;
        
        // 触发 Obsidian 的悬停预览
        plugin.app.workspace.trigger('hover-link', {
            event: mouseEvent,
            source: 'zk-navigation',
            hoverParent: container,
            linktext: "",
            targetEl: mouseEvent.target,
            sourcePath: node.file.path,
        });
    });

    return renderer;
}

// ============================================
// 示例 2: 渲染入链出链图（InOutLinks Graph）
// ============================================
async function renderInOutLinksGraphExample(
    container: HTMLElement,
    currentFile: any,    // TFile
    inlinks: any[],      // TFile[]
    outlinks: any[],     // TFile[]
    plugin: any
) {
    // 1. 构建图形数据
    const graphData = GraphDataBuilder.fromInOutLinks(currentFile, inlinks, outlinks);

    // 2. 创建渲染器
    const renderer = new CytoscapeRenderer();

    // 3. 配置渲染选项
    const options: RenderOptions = {
        direction: plugin.settings.DirectionOfInlinksGraph || 'TB',
        layoutType: 'cose',  // 使用力导向布局，适合网络结构
        animate: true,
        animationDuration: 500,
        nodeText: plugin.settings.NodeText || 'both'
    };

    // 4. 渲染图形
    await renderer.render(container, graphData, options);

    // 5. 监听事件（同上）
    container.addEventListener('node-click', (event: any) => {
        const { node, ctrlKey, shiftKey, altKey } = event.detail;
        
        if (ctrlKey) {
            plugin.app.workspace.openLinkText("", node.file.path, 'tab');
        } else if (shiftKey) {
            plugin.retrivalforLocaLgraph = {
                type: '1',
                ID: '',
                filePath: node.file.path,
            };
            plugin.openGraphView();
        } else {
            plugin.app.workspace.openLinkText("", node.file.path);
        }
    });

    return renderer;
}

// ============================================
// 示例 3: 在 ZKGraphView 中集成
// ============================================
/*
在 ZKGraphView 类中添加：

class ZKGraphView extends ItemView {
    // ... 现有属性 ...
    
    // 新增：Cytoscape 渲染器
    private cytoscapeRenderer: CytoscapeRenderer | null = null;
    
    async refreshLocalGraph() {
        let { containerEl } = this;
        
        // 不要立即清空容器！
        // containerEl.empty();  // 移除这行
        
        // 创建或获取图形容器
        let graphContainer = containerEl.querySelector('.zk-graph-container') as HTMLElement;
        if (!graphContainer) {
            containerEl.empty();  // 只在首次创建时清空
            graphContainer = containerEl.createDiv('zk-graph-container');
        }
        
        // 获取家族节点
        await this.getFamilyNodes(this.currentFile);
        
        if (this.familyNodeArr.length > 0) {
            // 使用 Cytoscape 渲染
            if (this.cytoscapeRenderer) {
                this.cytoscapeRenderer.destroy();
            }
            
            this.cytoscapeRenderer = await renderFamilyGraphExample(
                graphContainer,
                this.familyNodeArr,
                this.currentFile,
                this.plugin
            );
        }
    }
    
    // 在视图销毁时清理
    async onClose() {
        if (this.cytoscapeRenderer) {
            this.cytoscapeRenderer.destroy();
            this.cytoscapeRenderer = null;
        }
    }
}
*/

// ============================================
// 示例 4: 增量更新
// ============================================
/*
async function updateGraphExample(
    renderer: CytoscapeRenderer,
    oldNodes: ZKNode[],
    newNodes: ZKNode[]
) {
    // 计算差异
    const addedNodes = newNodes.filter(n => !oldNodes.find(o => o.ID === n.ID));
    const removedNodes = oldNodes.filter(o => !newNodes.find(n => n.ID === o.ID));
    const updatedNodes = newNodes.filter(n => {
        const old = oldNodes.find(o => o.ID === n.ID);
        return old && old.displayText !== n.displayText;
    });
    
    // 增量更新
    await renderer.update({
        addedNodes,
        removedNodes,
        updatedNodes,
        addedEdges: [],
        removedEdges: [],
        updatedEdges: []
    });
}
*/

export {
    renderFamilyGraphExample,
    renderInOutLinksGraphExample
};
