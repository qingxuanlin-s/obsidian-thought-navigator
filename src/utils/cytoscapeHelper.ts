/**
 * Cytoscape 辅助函数
 * 用于在 IndexView 中渲染 Cytoscape 图形
 */

import { ZKNode } from "src/view/indexView";
import { CytoscapeRenderer } from "src/renderer/CytoscapeRenderer";
import { GraphDataBuilder } from "src/renderer/GraphDataBuilder";
import { RenderOptions } from "src/renderer/types";
import ZKNavigationPlugin from "main";
import { ZoomPanScale } from "main";

/**
 * 使用 Cytoscape 渲染分支图（替代 addSvgPanZoom）
 */
export async function addCytoscapeGraph(
    zkGraph: HTMLDivElement,
    indexMermaidDiv: HTMLElement,
    i: number,
    plugin: ZKNavigationPlugin,
    branchNodes: ZKNode[],
    height: number,
    currentFile?: any
): Promise<CytoscapeRenderer> {
    
    // 设置容器样式
    zkGraph.style.height = `${height}px`;
    zkGraph.style.width = "100%";
    zkGraph.addClass("zk-graph-cytoscape");
    
    // 添加到父容器
    indexMermaidDiv.appendChild(zkGraph);
    
    // 构建图形数据
    const graphData = GraphDataBuilder.fromFamilyNodes(branchNodes, currentFile);
    
    // 配置渲染选项
    const layoutType = plugin.settings.graphType === "roadmap" ? 'cose' : 'dagre';
    const options: RenderOptions = {
        direction: (plugin.settings.DirectionOfFamilyGraph || 'TB') as 'TB' | 'BT' | 'LR' | 'RL',
        layoutType: layoutType as 'dagre' | 'cose' | 'breadthfirst' | 'grid',
        animate: true,
        animationDuration: 500,
        nodeText: (plugin.settings.NodeText || 'both') as 'id' | 'title' | 'both' | 'id-title',
        themeMode: plugin.settings.themeMode,
        showNoteId: plugin.settings.showNoteIdInBranchView
    };
    
    // 创建渲染器
    const renderer = new CytoscapeRenderer();
    
    // 渲染图形
    await renderer.render(zkGraph, graphData, options);
    
    // 恢复之前保存的视图状态
    if (plugin.settings.zoomPanScaleArr[i]) {
        const savedState = plugin.settings.zoomPanScaleArr[i];
        renderer.setState({
            zoom: savedState.zoomScale,
            pan: savedState.pan,
            selectedNodes: [],
            expandedNodes: [],
            timestamp: Date.now()
        });
    } else {
        // 保存初始状态
        const initialState = renderer.getState();
        const zoomPanScale: ZoomPanScale = {
            graphID: zkGraph.id,
            zoomScale: initialState.zoom,
            pan: initialState.pan,
        };
        plugin.settings.zoomPanScaleArr.push(zoomPanScale);
    }
    
    // 监听视图变化，保存状态
    // 注意：Cytoscape 的状态保存需要通过定期轮询或事件监听
    // 这里我们使用一个简单的定时器
    const saveStateInterval = setInterval(() => {
        if (plugin.settings.zoomPanScaleArr[i]) {
            const currentState = renderer.getState();
            plugin.settings.zoomPanScaleArr[i].zoomScale = currentState.zoom;
            plugin.settings.zoomPanScaleArr[i].pan = currentState.pan;
        }
    }, 1000); // 每秒保存一次状态
    
    // 将定时器ID存储到元素上，以便清理
    (zkGraph as any).saveStateInterval = saveStateInterval;
    
    return renderer;
}

/**
 * 清理 Cytoscape 图形
 */
export function cleanupCytoscapeGraph(zkGraph: HTMLDivElement, renderer: CytoscapeRenderer) {
    // 清理定时器
    if ((zkGraph as any).saveStateInterval) {
        clearInterval((zkGraph as any).saveStateInterval);
        delete (zkGraph as any).saveStateInterval;
    }
    
    // 销毁渲染器
    if (renderer) {
        renderer.destroy();
    }
}
