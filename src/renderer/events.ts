import { Notice, setIcon } from 'obsidian';
import { t } from 'src/lang/helper';
import { GraphChanges } from './types';
import * as layoutAdapter from './layoutAdapter';

function getClipboardTextForNode(node: any): string {
    const data = node.data();
    const originalNode = data.originalNode || {};
    return String(
        originalNode.displayText ||
        originalNode.title ||
        data.displayText ||
        data.title ||
        data.label ||
        originalNode.wikiLink ||
        originalNode.IDStr ||
        originalNode.ID ||
        ''
    ).trim();
}

async function writeTextToSystemClipboard(text: string): Promise<boolean> {
    if (!text) return false;

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (error) {
        console.warn('[ZK] navigator.clipboard.writeText failed, falling back to execCommand:', error);
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    textarea.setAttribute('readonly', 'true');
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
        copied = document.execCommand('copy');
    } catch (error) {
        console.warn('[ZK] document.execCommand copy failed:', error);
    } finally {
        textarea.remove();
    }
    return copied;
}

async function readTextFromSystemClipboard(): Promise<string> {
    try {
        if (navigator.clipboard?.readText) {
            const text = await navigator.clipboard.readText();
            return text ?? '';
        }
    } catch (error) {
        console.warn('[ZK] navigator.clipboard.readText failed:', error);
    }
    return '';
}

export function bindEvents(this: any): void {
        if (!this.cy || !this.container) return;

        // 绑定分组创建事件（Command + 拖动）- 已禁用
        // this.bindGroupCreationEvents();

        this.cy.on('select unselect', 'node', () => {
            this.updateActiveFirstLevelBranch();
        });

        // 祖先链高亮:点击节点 → 它到 root 的整条路径恢复亮色(覆盖 2 级+ muted)+ 沿途边加粗。
        // unselect 后,如果还有别的节点是选中态,以 ID 字典序最小者为锚(确定性即可,不重要);
        // 全部 unselect 时清除高亮。
        const refreshAncestorHighlight = () => {
            if (!this.cy) return;
            const selected = this.cy.$('node:selected').filter((n: any) => !n.data('isGroup') && !n.data('isPlaceholder'));
            if (selected.length === 0) {
                this.applyAncestorHighlight(null);
                return;
            }
            this.applyAncestorHighlight(selected[0].id());
        };
        this.cy.on('select unselect', 'node', refreshAncestorHighlight);

        // 节点点击事件（单击选中；Command/Ctrl + 单击打开文件节点）
        this.cy.on('tap', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 如果是分组节点或占位符节点，不触发普通节点点击事件
            if (data.isGroup) {
                return;
            }
            if (data.isPlaceholder) {
                return;  // 占位符节点不触发点击事件
            }

            // 清除之前的高亮（使用filter避免selector转义问题）
            this.cy?.edges('.child-edge-highlight').removeClass('child-edge-highlight');

            // 递归高亮所有后代节点的边
            const nodeId = node.id();
            const visited = new Set<string>();  // 防止循环引用导致无限递归
            const highlightChildEdges = (sourceNodeId: string) => {
                // 检查是否已访问过，避免循环引用
                if (visited.has(sourceNodeId)) {
                    return;
                }
                visited.add(sourceNodeId);

                // 获取从当前节点出发的所有边（使用filter避免selector转义问题）
                const outgoingEdges = this.cy?.edges().filter((edge: any) => edge.data('source') === sourceNodeId);
                if (!outgoingEdges || outgoingEdges.length === 0) {
                    return;
                }

                // 高亮当前层的边
                outgoingEdges.addClass('child-edge-highlight');

                // 递归处理子节点
                outgoingEdges.forEach((edge: any) => {
                    const targetNodeId = edge.data('target');
                    highlightChildEdges(targetNodeId);
                });
            };

            // 从当前节点开始递归高亮
            highlightChildEdges(nodeId);

            // 跨领域节点：单击只选中，不跳转（跳转到双击处理）
            if (data.isCrossDomain) {
                // 只选中节点，不触发跳转
                // 触发选中事件以便其他功能使用
                this.container?.dispatchEvent(new CustomEvent('node-select', {
                    detail: {
                        node: data.originalNode,
                        event: originalEvent
                    }
                }));
                return;
            }

            // 普通节点：单击只选中，不打开文件
            // 触发自定义事件（用于其他功能，如高亮等）
            this.container?.dispatchEvent(new CustomEvent('node-select', {
                detail: {
                    node: data.originalNode,
                    event: originalEvent
                }
            }));
        });

        // 节点双击事件（编辑内容）
        this.cy.on('dbltap', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 如果是分组节点，不触发
            if (data.isGroup) {
                return;
            }

            // 占位符节点：双击显示内联编辑器
            if (data.isPlaceholder) {
                this.showInlineNodeEditor(node);
                return;
            }

            // 跨领域节点：双击触发跳转
            if (data.isCrossDomain) {
                // 触发跳转事件，传递 originalNode
                this.container?.dispatchEvent(new CustomEvent('cross-domain-node-click', {
                    detail: {
                        node: data.originalNode,
                        event: originalEvent
                    }
                }));
                return;
            }

            if (this.isReadOnlyMode()) {
                return;
            }

            // 普通节点：双击进入内联编辑
            this.showInlineNodeEditor(node);
        });

        // 分组节点双击事件（修改分组名）
        this.cy.on('dbltap', 'node[?isGroup]', (evt: any) => {
            if (this.isReadOnlyMode()) {
                return;
            }
            const node = evt.target;
            const data = node.data();
            
            this.showGroupNameDialog((newLabel: string | null) => {
                if (newLabel && newLabel !== data.label) {
                    // 触发分组重命名事件
                    this.container?.dispatchEvent(new CustomEvent('group-rename', {
                        detail: {
                            groupId: data.id,
                            oldLabel: data.label,
                            newLabel: newLabel
                        }
                    }));
                }
            }, data.label);
        });

        // 分组节点右键菜单事件（删除分组）
        this.cy.on('cxttap', 'node[?isGroup]', (evt: any) => {
            if (this.isReadOnlyMode()) {
                return;
            }
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 触发分组右键菜单事件
            this.container?.dispatchEvent(new CustomEvent('group-contextmenu', {
                detail: {
                    groupId: data.id,
                    groupLabel: data.label,
                    event: originalEvent,
                    position: {
                        x: originalEvent.clientX,
                        y: originalEvent.clientY
                    }
                }
            }));
        });

        // 节点悬停事件
        this.cy.on('mouseover', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            this.container?.dispatchEvent(new CustomEvent('node-hover', {
                detail: {
                    node: data.originalNode,
                    event: originalEvent
                }
            }));
        });

        // 节点离开事件
        this.cy.on('mouseout', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();

            this.container?.dispatchEvent(new CustomEvent('node-leave', {
                detail: {
                    node: data.originalNode
                }
            }));
        });

        // 节点右键菜单事件
        this.cy.on('cxttap', 'node[!isGroup]', (evt: any) => {
            if (this.isReadOnlyMode()) {
                return;
            }
            const node = evt.target;
            const data = node.data();
            const originalEvent = evt.originalEvent as MouseEvent;
            const renderedPosition = node.renderedPosition();

            // 跨领域节点：发送专门的跨领域右键菜单事件
            if (data.isCrossDomain) {
                this.container?.dispatchEvent(new CustomEvent('cross-domain-contextmenu', {
                    detail: {
                        node: data.originalNode,
                        event: originalEvent,
                        position: {
                            x: renderedPosition.x,
                            y: renderedPosition.y
                        }
                    }
                }));
                return;
            }

            // 普通节点：发送普通的节点右键菜单事件
            this.container?.dispatchEvent(new CustomEvent('node-contextmenu', {
                detail: {
                    node: data.originalNode,
                    event: originalEvent,
                    position: {
                        x: renderedPosition.x,
                        y: renderedPosition.y
                    }
                }
            }));
        });

        // 背景点击事件（取消选择）
        this.cy.on('tap', (evt: any) => {
            if (evt.target === this.cy) {
                // 清除子节点箭头高亮
                this.cy?.$('edge.child-edge-highlight').removeClass('child-edge-highlight');

                // 取消批量选择并隐藏工具栏
                if (this.batchSelectedNodeIds.length > 0) {
                    this.batchSelectedNodeIds = [];
                    this.batchSelectedNodes = [];
                    this.hideBatchToolbar();
                }

                this.container?.dispatchEvent(new CustomEvent('background-click', {
                    detail: { event: evt.originalEvent }
                }));
            }
        });

        // 背景双击事件（创建自由节点）
        this.cy.on('dbltap', (evt: any) => {
            if (evt.target === this.cy) {
                if (this.isReadOnlyMode()) {
                    return;
                }
                const position = evt.position;
                this.container?.dispatchEvent(new CustomEvent('background-dblclick', {
                    detail: {
                        position: { x: position.x, y: position.y },
                        event: evt.originalEvent
                    }
                }));
            }
        });

        // 监听添加占位符节点事件
        this.overlayScheduler.addManagedDomListener(this.container, 'add-placeholder-node', (event: any) => {
            const { nodeId, position, suggestedNodeId, parentNodeId } = event.detail;

            try {
                // 直接在 Cytoscape 中添加占位符节点
                this.cy?.add({
                    group: 'nodes',
                    data: {
                        id: nodeId,
                        label: '',  // 不显示预生成的 ID，保持空白
                        isPlaceholder: true,
                        isTextOnly: true,
                        hasMarkdownOverlay: true,
                        originalNode: null,
                        suggestedNodeId: suggestedNodeId,  // 存储预生成的节点 ID
                        parentNodeId: parentNodeId  // 存储父节点 ID
                    },
                    position: position
                });

                // 如果有父节点，创建连接线
                if (parentNodeId) {
                    setTimeout(() => {
                        const placeholderNode = this.cy?.$id(nodeId);
                        if (placeholderNode && placeholderNode.length > 0) {
                            this.createPlaceholderConnectionLine(nodeId, parentNodeId);
                        }
                    }, 50);
                }

                // 自动选中并打开编辑框
                setTimeout(() => {
                    const node = this.cy?.$id(nodeId);

                    if (node && node.length > 0) {
                        // 取消其他节点的选中
                        const previouslySelected = this.cy!.$(':selected');
                        previouslySelected.unselect();

                        // 选中这个节点
                        node.select();

                        // 延迟打开编辑器，确保选中完成
                        setTimeout(() => {
                            this.showInlineNodeEditor(node);
                        }, 10);
                    } else {
                        console.error('[CytoscapeRenderer] 未找到节点', nodeId);
                    }
                }, 10);
            } catch (error) {
                console.error('[CytoscapeRenderer] Error adding placeholder node:', error);
            }
        });

        // 监听移除占位符节点事件
        this.overlayScheduler.addManagedDomListener(this.container, 'remove-placeholder-node', (event: any) => {
            const { nodeId } = event.detail;

            // 先清理连接线（通过查询选择器，更可靠）
            const connectionLine = this.container?.querySelector(`.placeholder-connection-line[data-placeholder-id="${nodeId}"]`);
            if (connectionLine && connectionLine.parentNode) {
                connectionLine.parentNode.removeChild(connectionLine);
            }

            // 从 Cytoscape 中移除占位符节点
            const node = this.cy?.$id(nodeId);
            if (node && node.length > 0) {
                // 清理连接线（备用方法）
                const nodeData = node.data();
                const connectionLineFromData = (nodeData as any).connectionLine;

                if (connectionLineFromData && connectionLineFromData.parentNode) {
                    connectionLineFromData.parentNode.removeChild(connectionLineFromData);
                }

                // 从 overlay 调度器移除连接线更新器
                const lineUpdater = (nodeData as any).connectionLineUpdater;
                if (lineUpdater) {
                    this.overlayScheduler.updaters.delete(lineUpdater);
                }

                this.cy?.remove(node);
            }
        });

        // 监听节点移除事件，清理占位符节点的连接线
        this.cy?.on('remove', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();

            // 如果是占位符节点，清理连接线
            if (data.isPlaceholder) {
                const connectionLine = this.container?.querySelector(`.placeholder-connection-line[data-placeholder-id="${data.id}"]`);
                if (connectionLine && connectionLine.parentNode) {
                    connectionLine.parentNode.removeChild(connectionLine);
                }
            }
        });

        // 监听清理所有占位符连接线事件（用于视图刷新时）
        this.overlayScheduler.addManagedDomListener(this.container, 'cleanup-all-placeholder-connections', () => {
            const connectionLines = this.container?.querySelectorAll('.placeholder-connection-line');
            if (connectionLines) {
                connectionLines.forEach((line: Element) => {
                    if (line.parentNode) {
                        line.parentNode.removeChild(line);
                    }
                });
            }
        });

        // 监听通过 ID 选中节点事件（用于新建节点后自动选中）
        this.overlayScheduler.addManagedDomListener(this.container, 'select-node-by-id', (event: any) => {
            const { nodeId } = event.detail;

            // 延迟执行，确保视图刷新完成
            setTimeout(() => {
                if (!this.cy) return;

                // 查找对应 ID 的节点
                const targetNode = this.cy.$('node').filter((node: any) => {
                    const data = node.data();
                    return data.originalNode && data.originalNode.IDStr === nodeId;
                });

                if (targetNode.length > 0) {
                    // 取消其他节点的选中
                    this.cy.$(':selected').unselect();

                    // 选中目标节点
                    targetNode.select();
                    this.ensureNodeVisibleInViewport(targetNode);


                    // 将焦点设置到 container，确保方向键能工作
                    this.container?.focus();
                } else {
                    console.warn('[CytoscapeRenderer] 未找到节点', nodeId);
                }
            }, 300); // 延迟 300ms 确保视图刷新完成
        });

        // 节点拖动自动连接相关变量
        let tempConnectionLine: SVGLineElement | null = null;
        let svgOverlay: SVGSVGElement | null = null;
        let nearbyNodeId: string | null = null;
        const PROXIMITY_THRESHOLD = 250;  // 250px 范围
        let alignmentOverlay: SVGSVGElement | null = null;
        let verticalAlignmentLine: SVGLineElement | null = null;
        let horizontalAlignmentLine: SVGLineElement | null = null;
        let spacingGuideLineA: SVGLineElement | null = null;
        let spacingGuideLineB: SVGLineElement | null = null;
        const ALIGNMENT_THRESHOLD = 5;
        const SPACING_THRESHOLD = 8;
        const AXIS_GROUP_THRESHOLD = 24;
        let isMultiNodeDrag = false; // grab 时缓存，避免 drag 高频查选择器
        // 自动布局节点的子树同步拖动状态
        let autoHierarchyDescendants: Array<{ node: any; startX: number; startY: number }> = [];
        let autoHierarchyGrabStartX = 0;
        let autoHierarchyGrabStartY = 0;
        let isAutoHierarchyDrag = false;
        let autoHierarchyGrabbedNode: any = null;
        let autoHierarchyStyled = false;

        // 分组退出检测状态
        let draggedNodeOriginalGroup: any = null;
        let draggedNodeOriginalGroupModelBounds: { x1: number; y1: number; x2: number; y2: number } | null = null;
        let pendingGroupLeave: { nodeId: string; groupId: string } | null = null;
        let pendingGroupJoin: { nodeId: string; groupId: string } | null = null;
        let groupDragNodeActuallyMoved = false; // 区分拖动和点击，避免 free/dragfree 顺序问题
        let groupJoinPreviewNode: any = null;

        // 拖拽期静态候选快照：grab 时构建一次，drag 期间复用，避免每帧 N 次 renderedPosition
        type DragCandidate = {
            node: any;
            id: string;
            isPlaceholder: boolean;
            isGroup: boolean;
            isFreeNode: boolean;
            isCrossDomain: boolean;
            metrics: { x: number; y: number; x1: number; x2: number; y1: number; y2: number; width: number; height: number };
        };
        let dragCandidateSnapshot: DragCandidate[] = [];
        let snapshotZoom = 0;
        let snapshotPanX = 0;
        let snapshotPanY = 0;

        const buildDragCandidateSnapshot = (draggedId: string) => {
            if (!this.cy) {
                dragCandidateSnapshot = [];
                return;
            }
            const arr: DragCandidate[] = [];
            this.cy.nodes().forEach((other: any) => {
                if (other.id() === draggedId) return;
                if (other.removed() || !other.visible()) return;
                if (other.hasClass('zk-collapsed-hidden')) return;
                const d = other.data();
                const originalId = d.originalNode?.ID || d.originalSource || other.id();
                const isFreeNode = !!d.isFreeNode || (typeof originalId === 'string' && originalId.startsWith('free.'));
                arr.push({
                    node: other,
                    id: other.id(),
                    isPlaceholder: !!d.isPlaceholder,
                    isGroup: !!d.isGroup,
                    isFreeNode,
                    isCrossDomain: !!d.isCrossDomain,
                    metrics: getRenderedMetrics(other),
                });
            });
            dragCandidateSnapshot = arr;
            snapshotZoom = this.cy.zoom();
            const pan = this.cy.pan();
            snapshotPanX = pan.x;
            snapshotPanY = pan.y;
        };

        // 拖拽中如发生 zoom/pan 变化（罕见但可能），重算快照 metrics（保留候选数组，不重建）
        const refreshSnapshotMetricsIfViewportChanged = () => {
            if (!this.cy || dragCandidateSnapshot.length === 0) return;
            const zoom = this.cy.zoom();
            const pan = this.cy.pan();
            if (zoom === snapshotZoom && pan.x === snapshotPanX && pan.y === snapshotPanY) return;
            for (const cand of dragCandidateSnapshot) {
                cand.metrics = getRenderedMetrics(cand.node);
            }
            snapshotZoom = zoom;
            snapshotPanX = pan.x;
            snapshotPanY = pan.y;
        };

        const clearDragCandidateSnapshot = () => {
            dragCandidateSnapshot = [];
        };

        const ensureAlignmentOverlay = () => {
            if (alignmentOverlay || !this.container) return;
            alignmentOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            alignmentOverlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 3;
            `;

            verticalAlignmentLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            horizontalAlignmentLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            spacingGuideLineA = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            spacingGuideLineB = document.createElementNS('http://www.w3.org/2000/svg', 'line');

            [verticalAlignmentLine, horizontalAlignmentLine].forEach((line) => {
                if (!line) return;
                line.setAttribute('stroke', '#f8fafc');
                line.setAttribute('stroke-width', '1.5');
                line.setAttribute('stroke-dasharray', '4,4');
                line.setAttribute('opacity', '0.85');
                line.style.display = 'none';
                alignmentOverlay!.appendChild(line);
            });

            [spacingGuideLineA, spacingGuideLineB].forEach((line) => {
                if (!line) return;
                line.setAttribute('stroke', '#38bdf8');
                line.setAttribute('stroke-width', '1.5');
                line.setAttribute('stroke-dasharray', '3,3');
                line.setAttribute('opacity', '0.9');
                line.style.display = 'none';
                alignmentOverlay!.appendChild(line);
            });

            this.container.appendChild(alignmentOverlay);
            this.activeAlignmentOverlay = alignmentOverlay;
        };

        const hideAlignmentGuides = () => {
            if (verticalAlignmentLine) verticalAlignmentLine.style.display = 'none';
            if (horizontalAlignmentLine) horizontalAlignmentLine.style.display = 'none';
            if (spacingGuideLineA) spacingGuideLineA.style.display = 'none';
            if (spacingGuideLineB) spacingGuideLineB.style.display = 'none';
        };

        const getRenderedMetrics = (node: any) => {
            const pos = node.renderedPosition();
            const width = typeof node.renderedWidth === 'function'
                ? node.renderedWidth()
                : node.width() * this.cy!.zoom();
            const height = typeof node.renderedHeight === 'function'
                ? node.renderedHeight()
                : node.height() * this.cy!.zoom();
            return {
                x: pos.x,
                y: pos.y,
                x1: pos.x - width / 2,
                x2: pos.x + width / 2,
                y1: pos.y - height / 2,
                y2: pos.y + height / 2,
                width,
                height
            };
        };

        const GUIDE_PROXIMITY = 400; // 只对 400px 内的节点触发辅助线

        const updateAlignmentGuides = (draggedNode: any) => {
            if (!this.cy || !this.container) return;

            // 多节点拖动时不触发辅助线（使用 grab 时缓存的标志，避免高频查选择器）
            if (isMultiNodeDrag) {
                return;
            }

            ensureAlignmentOverlay();
            if (!verticalAlignmentLine || !horizontalAlignmentLine || !spacingGuideLineA || !spacingGuideLineB) return;

            refreshSnapshotMetricsIfViewportChanged();

            const originalMetrics = getRenderedMetrics(draggedNode);
            let snappedX = originalMetrics.x;
            let snappedY = originalMetrics.y;

            let verticalGuide: { x: number; y1: number; y2: number } | null = null;
            let horizontalGuide: { y: number; x1: number; x2: number } | null = null;
            let verticalBest = Number.POSITIVE_INFINITY;
            let horizontalBest = Number.POSITIVE_INFINITY;
            let horizontalSpacing: { left: any; right: any; y: number } | null = null;
            let verticalSpacing: { top: any; bottom: any; x: number } | null = null;

            // 单次遍历：同时算对齐候选 + 收集 axis peers，metrics 来自 grab 时建立的快照
            const proximitySq = GUIDE_PROXIMITY * GUIDE_PROXIMITY;
            const horizontalPeerMetrics: typeof originalMetrics[] = [];
            const verticalPeerMetrics: typeof originalMetrics[] = [];
            const draggedId = draggedNode.id();

            for (let i = 0; i < dragCandidateSnapshot.length; i++) {
                const cand = dragCandidateSnapshot[i];
                if (cand.id === draggedId) continue;
                if (cand.isPlaceholder || cand.isGroup) continue;
                const other = cand.metrics;
                const dx = originalMetrics.x - other.x;
                const dy = originalMetrics.y - other.y;
                if (dx * dx + dy * dy > proximitySq) continue;

                // 对齐候选（X 轴：中心 / 左缘 / 右缘）
                const vc1 = Math.abs(originalMetrics.x - other.x);
                if (vc1 <= ALIGNMENT_THRESHOLD && vc1 < verticalBest) {
                    verticalBest = vc1;
                    snappedX = other.x;
                    verticalGuide = { x: other.x, y1: Math.min(originalMetrics.y1, other.y1) - 40, y2: Math.max(originalMetrics.y2, other.y2) + 40 };
                }
                const vc2 = Math.abs(originalMetrics.x1 - other.x1);
                if (vc2 <= ALIGNMENT_THRESHOLD && vc2 < verticalBest) {
                    verticalBest = vc2;
                    snappedX = other.x1 + originalMetrics.width / 2;
                    verticalGuide = { x: other.x1, y1: Math.min(originalMetrics.y1, other.y1) - 40, y2: Math.max(originalMetrics.y2, other.y2) + 40 };
                }
                const vc3 = Math.abs(originalMetrics.x2 - other.x2);
                if (vc3 <= ALIGNMENT_THRESHOLD && vc3 < verticalBest) {
                    verticalBest = vc3;
                    snappedX = other.x2 - originalMetrics.width / 2;
                    verticalGuide = { x: other.x2, y1: Math.min(originalMetrics.y1, other.y1) - 40, y2: Math.max(originalMetrics.y2, other.y2) + 40 };
                }

                // 对齐候选（Y 轴：中心 / 上缘 / 下缘）
                const hc1 = Math.abs(originalMetrics.y - other.y);
                if (hc1 <= ALIGNMENT_THRESHOLD && hc1 < horizontalBest) {
                    horizontalBest = hc1;
                    snappedY = other.y;
                    horizontalGuide = { y: other.y, x1: Math.min(originalMetrics.x1, other.x1) - 40, x2: Math.max(originalMetrics.x2, other.x2) + 40 };
                }
                const hc2 = Math.abs(originalMetrics.y1 - other.y1);
                if (hc2 <= ALIGNMENT_THRESHOLD && hc2 < horizontalBest) {
                    horizontalBest = hc2;
                    snappedY = other.y1 + originalMetrics.height / 2;
                    horizontalGuide = { y: other.y1, x1: Math.min(originalMetrics.x1, other.x1) - 40, x2: Math.max(originalMetrics.x2, other.x2) + 40 };
                }
                const hc3 = Math.abs(originalMetrics.y2 - other.y2);
                if (hc3 <= ALIGNMENT_THRESHOLD && hc3 < horizontalBest) {
                    horizontalBest = hc3;
                    snappedY = other.y2 - originalMetrics.height / 2;
                    horizontalGuide = { y: other.y2, x1: Math.min(originalMetrics.x1, other.x1) - 40, x2: Math.max(originalMetrics.x2, other.x2) + 40 };
                }

                // 等距辅助：按轴分组
                if (Math.abs(other.y - originalMetrics.y) <= AXIS_GROUP_THRESHOLD) {
                    horizontalPeerMetrics.push(other);
                }
                if (Math.abs(other.x - originalMetrics.x) <= AXIS_GROUP_THRESHOLD) {
                    verticalPeerMetrics.push(other);
                }
            }

            horizontalPeerMetrics.sort((a, b) => a.x - b.x);
            for (let i = 0; i < horizontalPeerMetrics.length - 1; i++) {
                const left = horizontalPeerMetrics[i];
                const right = horizontalPeerMetrics[i + 1];
                if (left.x >= originalMetrics.x || right.x <= originalMetrics.x) continue;
                const midpoint = (left.x + right.x) / 2;
                const delta = Math.abs(originalMetrics.x - midpoint);
                if (delta <= SPACING_THRESHOLD) {
                    snappedX = midpoint;
                    verticalGuide = null;
                    horizontalSpacing = {
                        left,
                        right,
                        y: (left.y + right.y + originalMetrics.y) / 3
                    };
                    break;
                }
            }

            verticalPeerMetrics.sort((a, b) => a.y - b.y);
            for (let i = 0; i < verticalPeerMetrics.length - 1; i++) {
                const top = verticalPeerMetrics[i];
                const bottom = verticalPeerMetrics[i + 1];
                if (top.y >= originalMetrics.y || bottom.y <= originalMetrics.y) continue;
                const midpoint = (top.y + bottom.y) / 2;
                const delta = Math.abs(originalMetrics.y - midpoint);
                if (delta <= SPACING_THRESHOLD) {
                    snappedY = midpoint;
                    horizontalGuide = null;
                    verticalSpacing = {
                        top,
                        bottom,
                        x: (top.x + bottom.x + originalMetrics.x) / 3
                    };
                    break;
                }
            }

            if (snappedX !== originalMetrics.x || snappedY !== originalMetrics.y) {
                const zoom = this.cy.zoom();
                const pan = this.cy.pan();
                draggedNode.position({
                    x: (snappedX - pan.x) / zoom,
                    y: (snappedY - pan.y) / zoom
                });
            }

            const draggedPos = draggedNode.renderedPosition();
            const draggedMetrics = getRenderedMetrics(draggedNode);
            const currentVerticalGuide: any = verticalGuide;
            const currentHorizontalGuide: any = horizontalGuide;

            if (currentVerticalGuide) {
                verticalAlignmentLine.setAttribute('x1', `${currentVerticalGuide.x}`);
                verticalAlignmentLine.setAttribute('y1', `${currentVerticalGuide.y1}`);
                verticalAlignmentLine.setAttribute('x2', `${currentVerticalGuide.x}`);
                verticalAlignmentLine.setAttribute('y2', `${currentVerticalGuide.y2}`);
                verticalAlignmentLine.style.display = 'block';
            } else {
                verticalAlignmentLine.style.display = 'none';
            }

            if (currentHorizontalGuide) {
                horizontalAlignmentLine.setAttribute('x1', `${currentHorizontalGuide.x1}`);
                horizontalAlignmentLine.setAttribute('y1', `${currentHorizontalGuide.y}`);
                horizontalAlignmentLine.setAttribute('x2', `${currentHorizontalGuide.x2}`);
                horizontalAlignmentLine.setAttribute('y2', `${currentHorizontalGuide.y}`);
                horizontalAlignmentLine.style.display = 'block';
            } else {
                horizontalAlignmentLine.style.display = 'none';
            }

            if (horizontalSpacing) {
                spacingGuideLineA.setAttribute('x1', `${horizontalSpacing.left.x2}`);
                spacingGuideLineA.setAttribute('y1', `${draggedPos.y}`);
                spacingGuideLineA.setAttribute('x2', `${draggedMetrics.x1}`);
                spacingGuideLineA.setAttribute('y2', `${draggedPos.y}`);
                spacingGuideLineA.style.display = 'block';

                spacingGuideLineB.setAttribute('x1', `${draggedMetrics.x2}`);
                spacingGuideLineB.setAttribute('y1', `${draggedPos.y}`);
                spacingGuideLineB.setAttribute('x2', `${horizontalSpacing.right.x1}`);
                spacingGuideLineB.setAttribute('y2', `${draggedPos.y}`);
                spacingGuideLineB.style.display = 'block';
            } else if (verticalSpacing) {
                spacingGuideLineA.setAttribute('x1', `${draggedPos.x}`);
                spacingGuideLineA.setAttribute('y1', `${verticalSpacing.top.y2}`);
                spacingGuideLineA.setAttribute('x2', `${draggedPos.x}`);
                spacingGuideLineA.setAttribute('y2', `${draggedMetrics.y1}`);
                spacingGuideLineA.style.display = 'block';

                spacingGuideLineB.setAttribute('x1', `${draggedPos.x}`);
                spacingGuideLineB.setAttribute('y1', `${draggedMetrics.y2}`);
                spacingGuideLineB.setAttribute('x2', `${draggedPos.x}`);
                spacingGuideLineB.setAttribute('y2', `${verticalSpacing.bottom.y1}`);
                spacingGuideLineB.style.display = 'block';
            } else {
                spacingGuideLineA.style.display = 'none';
                spacingGuideLineB.style.display = 'none';
            }
        };

        // 智能连线：从快照里找最近的合法目标节点
        const findNearestSmartTarget = (
            draggedNode: any,
            draggedRenderedPos: { x: number; y: number },
            allowFreeNodeAsTarget: boolean
        ): any => {
            const draggedId = draggedNode.id();
            const proximitySq = PROXIMITY_THRESHOLD * PROXIMITY_THRESHOLD;
            let nearest: any = null;
            let bestDistSq = proximitySq;
            for (let i = 0; i < dragCandidateSnapshot.length; i++) {
                const cand = dragCandidateSnapshot[i];
                if (cand.id === draggedId) continue;
                if (cand.isPlaceholder) continue;
                if (cand.isGroup) continue;
                if (!allowFreeNodeAsTarget && cand.isFreeNode) continue;
                const dx = draggedRenderedPos.x - cand.metrics.x;
                const dy = draggedRenderedPos.y - cand.metrics.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < bestDistSq) {
                    bestDistSq = distSq;
                    nearest = cand.node;
                }
            }
            return nearest;
        };

        // 智能连线虚线：复用单个 SVG line，避免每帧 remove/create
        const ensureTempConnectionLine = (): SVGLineElement | null => {
            if (!svgOverlay) return null;
            if (tempConnectionLine && tempConnectionLine.parentNode === svgOverlay) {
                return tempConnectionLine;
            }
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('stroke', '#10b981');
            line.setAttribute('stroke-width', '2');
            line.setAttribute('stroke-dasharray', '5,5');
            line.style.display = 'none';
            svgOverlay.appendChild(line);
            tempConnectionLine = line;
            return line;
        };

        const hideTempConnectionLine = () => {
            if (tempConnectionLine) tempConnectionLine.style.display = 'none';
        };

        // 切换智能连线高亮目标（仅当目标变化时操作 class）
        let smartHoverTargetId: string | null = null;
        const setSmartHoverTarget = (targetId: string | null) => {
            if (smartHoverTargetId === targetId) return;
            if (smartHoverTargetId) {
                const prev = this.cy!.$id(smartHoverTargetId);
                if (prev && prev.length) prev.removeClass('connection-target-hover');
            }
            if (targetId) {
                const cur = this.cy!.$id(targetId);
                if (cur && cur.length) cur.addClass('connection-target-hover');
            }
            smartHoverTargetId = targetId;
            nearbyNodeId = targetId;
        };

        const findContainingGroup = (node: any, excludedGroupId?: string | null): any | null => {
            if (!this.cy) return null;
            const pos = node.position();
            let containingGroup: any | null = null;
            let containingGroupArea = Number.POSITIVE_INFINITY;

            this.cy.nodes('[?isGroup]').forEach((groupNode: any) => {
                if (excludedGroupId && groupNode.id() === excludedGroupId) return;

                const bb = groupNode.boundingBox({ includeLabels: false, includeOverlays: false });
                if (pos.x < bb.x1 || pos.x > bb.x2 || pos.y < bb.y1 || pos.y > bb.y2) return;

                const area = Math.max(0, bb.x2 - bb.x1) * Math.max(0, bb.y2 - bb.y1);
                if (area < containingGroupArea) {
                    containingGroup = groupNode;
                    containingGroupArea = area;
                }
            });

            return containingGroup;
        };

        const setGroupJoinPreview = (groupNode: any | null) => {
            if (groupJoinPreviewNode && (!groupNode || groupJoinPreviewNode.id() !== groupNode.id())) {
                groupJoinPreviewNode.removeClass('group-join-warning');
            }
            if (groupNode && (!groupJoinPreviewNode || groupJoinPreviewNode.id() !== groupNode.id())) {
                groupNode.addClass('group-join-warning');
            }
            groupJoinPreviewNode = groupNode;
        };

        // 节点开始拖动事件
        this.cy.on('grab', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            const smartEnabled = this.isSmartConnectionEnabled();
            isMultiNodeDrag = this.cy!.nodes(':selected').length > 1;
            ensureAlignmentOverlay();
            hideAlignmentGuides();

            // 单节点拖拽：建静态候选快照（drag 期间复用），多节点拖拽不需要辅助/智能连线
            if (!isMultiNodeDrag) {
                buildDragCandidateSnapshot(node.id());
            } else {
                clearDragCandidateSnapshot();
            }

            // 自动布局节点：收集后代 & 起始位置；样式延迟到真正开始移动时再加
            autoHierarchyDescendants = [];
            isAutoHierarchyDrag = false;
            autoHierarchyGrabbedNode = null;
            autoHierarchyStyled = false;
            if (!isMultiNodeDrag && !data.isPlaceholder && !data.isGroup && !data.isCrossDomain) {
                const grabbedId = data.originalNode?.ID || data.originalSource || data.id;
                if (typeof grabbedId === 'string' && grabbedId.length > 0 && this.isNodeAutoLayoutForId(grabbedId)) {
                    const prefix = `${grabbedId}.`;
                    const grabPos = node.position();
                    autoHierarchyGrabStartX = grabPos.x;
                    autoHierarchyGrabStartY = grabPos.y;
                    this.cy!.nodes().forEach((n: any) => {
                        if (n.id() === node.id()) return;
                        const d = n.data();
                        if (d.isPlaceholder || d.isGroup || d.isCrossDomain) return;
                        const nid = d.originalNode?.ID || d.originalSource || n.id();
                        if (typeof nid === 'string' && nid.startsWith(prefix)) {
                            const p = n.position();
                            autoHierarchyDescendants.push({ node: n, startX: p.x, startY: p.y });
                        }
                    });
                    if (autoHierarchyDescendants.length > 0) {
                        isAutoHierarchyDrag = true;
                        autoHierarchyGrabbedNode = node;
                    }
                }
            }

            // 分组退出检测：捕获边界，临时移出防止分组自动扩张
            draggedNodeOriginalGroup = null;
            draggedNodeOriginalGroupModelBounds = null;
            groupDragNodeActuallyMoved = false;
            if (!isMultiNodeDrag && !data.isGroup && !data.isPlaceholder && !data.isCrossDomain) {
                const parentId = node.data('parent');
                if (parentId) {
                    const groupNode = this.cy!.$id(parentId);
                    if (groupNode.length > 0 && groupNode.data('isGroup')) {
                        const bb = groupNode.boundingBox({ includeLabels: false, includeOverlays: false });
                        draggedNodeOriginalGroup = groupNode;
                        draggedNodeOriginalGroupModelBounds = { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 };
                        try { node.move({ parent: null }); } catch (e) {}
                    }
                }
            }

            if (!smartEnabled) {
                hideTempConnectionLine();
                setSmartHoverTarget(null);
                return;
            }

            // 只对自由节点启用自动连接
            if (data.isPlaceholder || data.isGroup || data.isCrossDomain) return;

            // 检查是否是自由节点（ID 以 'free.' 开头）
            const originalNodeId = data.originalNode?.ID || data.originalSource || data.id;

            if (!originalNodeId.startsWith('free.')) {
                return;  // 只允许自由节点拖动自动连接
            }

            // 限制：自由节点一旦已有任意连线（父子/反向），不再允许智能连线到其他节点
            if (node.connectedEdges().length > 0) {
                return;
            }

            // 创建 SVG 叠加层用于绘制连线
            if (!svgOverlay && this.container) {
                svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svgOverlay.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    pointer-events: none;
                    z-index: 2;
                `;
                this.container.appendChild(svgOverlay);
            }
            ensureTempConnectionLine();
        });

        // 节点拖动事件
        this.cy.on('drag', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();

            // 自动布局：把后代同步平移
            if (isAutoHierarchyDrag && !isMultiNodeDrag) {
                const curPos = node.position();
                const dx = curPos.x - autoHierarchyGrabStartX;
                const dy = curPos.y - autoHierarchyGrabStartY;
                if (!autoHierarchyStyled && (dx !== 0 || dy !== 0)) {
                    autoHierarchyStyled = true;
                    const descendantIds = new Set<string>(
                        autoHierarchyDescendants.map(({ node: n }) => n.id())
                    );
                    if (autoHierarchyGrabbedNode) descendantIds.add(autoHierarchyGrabbedNode.id());
                    autoHierarchyDescendants.forEach(({ node: n }) => {
                        n.addClass('auto-hierarchy-descendant');
                    });
                    this.cy!.edges().forEach((e: any) => {
                        if (descendantIds.has(e.source().id()) && descendantIds.has(e.target().id())) {
                            e.addClass('auto-hierarchy-descendant-edge');
                        }
                    });
                }
                this.cy!.batch(() => {
                    autoHierarchyDescendants.forEach(({ node: n, startX, startY }) => {
                        n.position({ x: startX + dx, y: startY + dy });
                    });
                });
            }

            // 多节点拖动时跳过辅助线和智能连线，避免 N 个节点 × 每帧的重复计算
            if (isMultiNodeDrag) return;

            const smartEnabled = this.isSmartConnectionEnabled();

             if (!data.isGroup) {
                updateAlignmentGuides(node);
            }

            // 分组退出警告：节点中心移出初始分组边界时高亮边框
            if (draggedNodeOriginalGroup && draggedNodeOriginalGroupModelBounds && !isMultiNodeDrag) {
                groupDragNodeActuallyMoved = true;
                const pos = node.position();
                const bb = draggedNodeOriginalGroupModelBounds;
                const isOutside = pos.x < bb.x1 || pos.x > bb.x2 || pos.y < bb.y1 || pos.y > bb.y2;
                if (isOutside) {
                    if (!draggedNodeOriginalGroup.hasClass('group-exit-warning')) {
                        draggedNodeOriginalGroup.addClass('group-exit-warning');
                    }
                } else {
                    if (draggedNodeOriginalGroup.hasClass('group-exit-warning')) {
                        draggedNodeOriginalGroup.removeClass('group-exit-warning');
                    }
                }
            }

            // 分组加入预览：节点中心进入某个分组边界时，用同一套橘黄色虚线反馈目标分组
            if (!data.isGroup && !data.isPlaceholder && !data.isCrossDomain) {
                const originalGroupId = draggedNodeOriginalGroup?.id?.() || node.data('parent') || null;
                setGroupJoinPreview(findContainingGroup(node, originalGroupId));
            } else {
                setGroupJoinPreview(null);
            }

            if (!smartEnabled) {
                hideTempConnectionLine();
                setSmartHoverTarget(null);
                return;
            }

            // 智能连线扫描：占位符 vs 自由节点共用快照 + helper
            const isPlaceholderDrag = !!data.isPlaceholder;
            if (!isPlaceholderDrag) {
                if (data.isGroup || data.isCrossDomain) return;
                const originalNodeId = data.originalNode?.ID || data.originalSource || data.id;
                if (!originalNodeId.startsWith('free.')) return;
                if (node.connectedEdges().length > 0) {
                    hideTempConnectionLine();
                    setSmartHoverTarget(null);
                    return;
                }
            }

            // svgOverlay 仅在自由节点 grab 时创建；占位符路径如果还没建过 overlay 也不应绘制连线
            if (!svgOverlay) {
                setSmartHoverTarget(null);
                return;
            }

            const pos = node.renderedPosition();
            const nearestNode = findNearestSmartTarget(node, pos, /* allowFreeNodeAsTarget */ isPlaceholderDrag);

            if (nearestNode) {
                const line = ensureTempConnectionLine();
                if (line) {
                    const targetPos = nearestNode.renderedPosition();
                    line.setAttribute('x1', targetPos.x.toString());
                    line.setAttribute('y1', targetPos.y.toString());
                    line.setAttribute('x2', pos.x.toString());
                    line.setAttribute('y2', pos.y.toString());
                    line.style.display = 'block';
                }
                setSmartHoverTarget(nearestNode.id());
            } else {
                hideTempConnectionLine();
                setSmartHoverTarget(null);
            }
        });

        // 节点拖动结束事件
        this.cy.on('dragfree', 'node', (evt: any) => {
            if (!evt || !evt.target) return;
            const node = evt.target;
            const data = node.data();
            const smartEnabled = this.isSmartConnectionEnabled();
            const smartTargetNodeId = nearbyNodeId;
            hideAlignmentGuides();

            // 自动布局：为同步平移的后代派发位置变化事件（以便批量持久化）
            if (isAutoHierarchyDrag) {
                autoHierarchyDescendants.forEach(({ node: n }) => {
                    const d = n.data();
                    n.removeClass('auto-hierarchy-descendant');
                    if (!d || !d.originalNode) return;
                    const pos = n.position();
                    this.container?.dispatchEvent(new CustomEvent('node-position-changed', {
                        detail: {
                            node: d.originalNode,
                            nodeId: d.id,
                            position: { x: pos.x, y: pos.y }
                        }
                    }));
                });
                this.cy!.edges('.auto-hierarchy-descendant-edge').removeClass('auto-hierarchy-descendant-edge');
                isAutoHierarchyDrag = false;
                autoHierarchyDescendants = [];
                autoHierarchyGrabbedNode = null;
                autoHierarchyStyled = false;
            }

            // 隐藏临时连接线（不移除 DOM，free 事件会整体清理 svgOverlay）
            hideTempConnectionLine();
            setSmartHoverTarget(null);

            // 分组退出：根据放置位置决定是否移出分组
            pendingGroupLeave = null;
            pendingGroupJoin = null;
            let originalGroupId: string | null = null;
            if (draggedNodeOriginalGroup && draggedNodeOriginalGroupModelBounds && !isMultiNodeDrag && !data.isGroup && !data.isPlaceholder) {
                const pos = node.position();
                const bb = draggedNodeOriginalGroupModelBounds;
                const isOutside = pos.x < bb.x1 || pos.x > bb.x2 || pos.y < bb.y1 || pos.y > bb.y2;

                draggedNodeOriginalGroup.removeClass('group-exit-warning');
                const sourceGroupId = draggedNodeOriginalGroup.id();
                originalGroupId = sourceGroupId;

                if (isOutside) {
                    const nodeId = data.originalNode?.ID || data.originalSource || data.id;
                    const currentIds: string[] = draggedNodeOriginalGroup.data('nodeIds') || [];
                    draggedNodeOriginalGroup.data('nodeIds', currentIds.filter((id: string) => id !== nodeId));
                    // 记录脱组信息，合并到 node-position-changed 里原子保存，避免并发写竞态
                    pendingGroupLeave = { nodeId, groupId: sourceGroupId };
                } else {
                    try { node.move({ parent: draggedNodeOriginalGroup.id() }); } catch (e) {}
                }

                draggedNodeOriginalGroup = null;
                draggedNodeOriginalGroupModelBounds = null;
                groupDragNodeActuallyMoved = false;
            }
            setGroupJoinPreview(null);

            // 如果是分组节点，不触发位置保存
            if (data.isGroup) return;

            const position = node.position();

            // 处理占位符节点的智能连线
            if (data.isPlaceholder) {
                // 检查是否启用了智能连线并且有附近的节点
                if (smartEnabled && smartTargetNodeId) {
                    const parentData = this.cy!.$id(smartTargetNodeId).data();
                    const parentId = parentData.originalNode?.ID || parentData.originalSource || smartTargetNodeId;
                    const placeholderId = data.id;

                    // 触发占位符节点自动连接事件
                    this.container?.dispatchEvent(new CustomEvent('placeholder-smart-connect', {
                        detail: {
                            placeholderId: placeholderId,
                            parentNodeId: parentId,
                            position: {
                                x: position.x,
                                y: position.y
                            }
                        }
                    }));

                    nearbyNodeId = null;
                }
                return;  // 占位符节点不保存位置
            }

            // 检查是否有自动连接（自由节点）
            if (smartEnabled && smartTargetNodeId) {
                const parentData = this.cy!.$id(smartTargetNodeId).data();

                // 使用 originalNode.ID（带点的格式）而不是转义后的 ID
                const childId = data.originalNode?.ID || data.originalSource || data.id;
                const parentId = parentData.originalNode?.ID || parentData.originalSource || smartTargetNodeId;

                // 触发自动连接事件
                this.container?.dispatchEvent(new CustomEvent('auto-connect-node', {
                    detail: {
                        childNodeId: childId,
                        parentNodeId: parentId,
                        position: {
                            x: position.x,
                            y: position.y
                        }
                    }
                }));

                nearbyNodeId = null;
                return;
            }

            nearbyNodeId = null;

            // 跨领域节点：触发特殊的位置变化事件
            if (data.isCrossDomain) {
                const crossDomainLink = data.originalNode?.file;

                // 找到连接这个跨领域节点的边，获取源节点 ID
                const connectedEdges = this.cy!.$(`edge[type="cross-domain"][target="${data.id}"]`);
                let sourceNodeId = null;
                if (connectedEdges.length > 0) {
                    sourceNodeId = connectedEdges.first().data().originalSource;
                }

                this.container?.dispatchEvent(new CustomEvent('cross-domain-node-position-changed', {
                    detail: {
                        node: data.originalNode,
                        nodeId: data.id,
                        position: {
                            x: position.x,
                            y: position.y
                        },
                        // 获取跨领域链接信息和源节点 ID
                        crossDomainLink: crossDomainLink,
                        sourceNodeId: sourceNodeId
                    }
                }));
                return;
            }

            // 分组加入：非组内节点拖入任意分组范围后，自动成为该分组的子节点。
            if (!isMultiNodeDrag && !data.isGroup && !data.isPlaceholder && !data.isCrossDomain) {
                const nodeId = data.originalNode?.ID || data.originalSource || data.id;
                const targetGroup = findContainingGroup(node, originalGroupId);
                if (targetGroup && targetGroup.length > 0) {
                    const targetGroupId = targetGroup.id();
                    const currentParent = node.data('parent');
                    if (currentParent !== targetGroupId) {
                        const currentIds: string[] = targetGroup.data('nodeIds') || [];
                        if (!currentIds.includes(nodeId)) {
                            targetGroup.data('nodeIds', [...currentIds, nodeId]);
                        }
                        try { node.move({ parent: targetGroupId }); } catch (e) {}
                        pendingGroupJoin = { nodeId, groupId: targetGroupId };
                    }
                }
            }

            // 普通节点：触发位置变化事件（含脱组信息，合并到同一次写入）
            const groupLeaveInfo = pendingGroupLeave;
            const groupJoinInfo = pendingGroupJoin;
            pendingGroupLeave = null;
            pendingGroupJoin = null;
            this.container?.dispatchEvent(new CustomEvent('node-position-changed', {
                detail: {
                    node: data.originalNode,
                    nodeId: data.id,
                    position: {
                        x: position.x,
                        y: position.y
                    },
                    leftGroup: groupLeaveInfo,
                    joinedGroup: groupJoinInfo
                }
            }));
        });

        // 节点释放事件（清理 SVG 叠加层）
        this.cy.on('free', 'node', (evt: any) => {
            const node = evt.target;
            const data = node.data();
            hideAlignmentGuides();
            clearDragCandidateSnapshot();

            // 纯点击（未发生移动）时，dragfree 不触发，在此恢复分组关系
            // 若实际发生了拖动，由 dragfree 负责处理，free 不干预
            if (draggedNodeOriginalGroup && !groupDragNodeActuallyMoved) {
                try { node.move({ parent: draggedNodeOriginalGroup.id() }); } catch (e) {}
                draggedNodeOriginalGroup.removeClass('group-exit-warning');
                setGroupJoinPreview(null);
                draggedNodeOriginalGroup = null;
                draggedNodeOriginalGroupModelBounds = null;
                pendingGroupLeave = null;
                groupDragNodeActuallyMoved = false;
            } else if (draggedNodeOriginalGroup && groupDragNodeActuallyMoved) {
                // 有拖动但 free 比 dragfree 先触发（Cytoscape 顺序不保证）：先不处理，等 dragfree
                // dragfree 结束后会清空 draggedNodeOriginalGroup，若此后 free 再次触发则跳过
            } else {
                setGroupJoinPreview(null);
            }

            // 只对自由节点进行清理
            const originalNodeId = data.originalNode?.ID || data.originalSource || data.id;
            if (!originalNodeId.startsWith('free.')) {
                return;
            }

            // 延迟清理，确保 dragfree 事件已经处理完成
            setTimeout(() => {
                // 移除 SVG 叠加层（连同复用的 tempConnectionLine 一起清理）
                if (svgOverlay && this.container) {
                    this.container.removeChild(svgOverlay);
                    svgOverlay = null;
                }
                tempConnectionLine = null;
                setSmartHoverTarget(null);
            }, 0);
        });

        // 边点击事件（选中边）
        this.cy.on('tap', 'edge', (evt: any) => {
            const edge = evt.target;
            const data = edge.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 触发边点击事件
            this.container?.dispatchEvent(new CustomEvent('edge-click', {
                detail: {
                    edgeId: data.id,
                    source: data.originalSource || data.source,  // 使用原始 ID
                    target: data.originalTarget || data.target,  // 使用原始 ID
                    type: data.type,
                    label: data.label,
                    event: originalEvent
                }
            }));
        });

        // 边双击事件（编辑关系文本）
        this.cy.on('dbltap', 'edge', (evt: any) => {
            if (this.isReadOnlyMode()) {
                return;
            }
            const edge = evt.target;
            const data = edge.data();

            // 允许编辑所有边的标签
            this.showInlineEdgeLabelEditor(edge);
        });

        // 边右键菜单事件（删除边）
        this.cy.on('cxttap', 'edge', (evt: any) => {
            if (this.isReadOnlyMode()) {
                return;
            }
            const edge = evt.target;
            const data = edge.data();
            const originalEvent = evt.originalEvent as MouseEvent;

            // 获取目标节点的 nodeSons 信息
            const targetNode = this.cy!.$id(data.target);
            if (!targetNode.length) return;

            const targetData = targetNode.data();
            const targetNodeSons = targetData.originalNode ? targetData.originalNode.nodeSons : 1;

            // 触发边右键菜单事件
            this.container?.dispatchEvent(new CustomEvent('edge-contextmenu', {
                detail: {
                    edgeId: data.id,
                    source: data.originalSource || data.source,  // 使用原始 ID
                    target: data.originalTarget || data.target,  // 使用原始 ID
                    type: data.type,
                    label: data.label,
                    targetNodeSons: targetNodeSons,  // 添加目标节点的子节点数量
                    event: originalEvent,
                    position: {
                        x: originalEvent.clientX,
                        y: originalEvent.clientY
                    }
                }
            }));
        });

        // 画板拖动视觉反馈（当空格键按下并拖动时）
        this.cy.on('grab', () => {
            if (this.cy) {
                const container = this.cy.container();
                if (container) {
                    container.style.cursor = 'grabbing';
                }
            }
        });

        this.cy.on('free', () => {
            if (this.cy && this.cy.userPanningEnabled()) {
                const container = this.cy.container();
                if (container) {
                    container.style.cursor = 'grab';
                }
            }
        });

        // 监听视图状态变化（缩放和平移）
        // 使用防抖避免频繁触发
        let viewStateTimeout: NodeJS.Timeout | null = null;
        this.cy.on('zoom pan', () => {
            if (viewStateTimeout) clearTimeout(viewStateTimeout);
            viewStateTimeout = setTimeout(() => {
                if (!this.cy) return;
                const zoom = this.cy.zoom();
                const pan = this.cy.pan();
                this.container?.dispatchEvent(new CustomEvent('viewStateChanged', {
                    detail: { zoom, pan }
                }));
            }, 150);
        });
    }

    /**
     * 绑定键盘事件
     */
export function bindKeyboardEvents(this: any): void {
        if (!this.container) return;

        // 监听键盘按下事件
        const handleKeyDown = (event: KeyboardEvent) => {
            const targetEl = event.target as HTMLElement | null;
            const isInlineEditing = !!this.container?.querySelector('.node-label-editor') ||
                !!this.container?.querySelector('.edge-label-editor') ||
                !!this.container?.querySelector('.zk-text-md-live-edit-host');
            const isEventFromInlineEditor = !!targetEl?.closest(
                '.node-label-editor, .edge-label-editor, .zk-text-md-live-edit-host, .cm-editor, .cm-content, .node-link-suggester, .zk-text-selection-toolbar'
            );

            // 编辑器内按键不应触发图级快捷键（方向键切换、Tab 建节点等）
            if (isInlineEditing && isEventFromInlineEditor) {
                return;
            }

            // Cmd+F：搜索节点
            if (event.key === 'f' && event.metaKey && !event.ctrlKey && !event.repeat) {
                event.preventDefault();
                event.stopPropagation();
                this.showSearchBar();
                return;
            }

            // Cmd+C：复制选中节点
            if (event.key === 'c' && (event.metaKey || event.ctrlKey) && !event.repeat) {
                if (!this.cy) return;
                const selected = this.cy.$(':selected').filter((n: any) =>
                    n.isNode() && !n.data('isGroup') && !n.data('isPlaceholder') && !n.data('isCrossDomain')
                );
                if (selected.length === 0) return;
                event.preventDefault();
                event.stopPropagation();
                this.clipboardNodes = selected.map((node: any) => ({
                    originalNode: node.data('originalNode'),
                    position: { ...node.position() }
                })).filter((item: any) => item.originalNode);
                if (this.clipboardNodes.length > 0) {
                    const clipboardText = selected
                        .map((node: any) => getClipboardTextForNode(node))
                        .filter((text: string) => text.length > 0)
                        .join('\n');
                    void writeTextToSystemClipboard(clipboardText).then((systemClipboardWritten) => {
                        if (!systemClipboardWritten) {
                            new Notice(t("System clipboard write failed"));
                        }
                    });
                    this.container?.dispatchEvent(new CustomEvent('node-copy', {
                        detail: { count: this.clipboardNodes.length }
                    }));
                }
                return;
            }

            // Cmd+V：粘贴节点(内部剪贴板)或系统剪贴板文本/链接
            if (event.key === 'v' && (event.metaKey || event.ctrlKey) && !event.repeat) {
                if (!this.cy) return;
                event.preventDefault();
                event.stopPropagation();
                const pan = this.cy.pan();
                const zoom = this.cy.zoom();
                const pasteCenter = {
                    x: (this.cy.width() / 2 - pan.x) / zoom,
                    y: (this.cy.height() / 2 - pan.y) / zoom
                };
                if (this.clipboardNodes.length > 0) {
                    this.container?.dispatchEvent(new CustomEvent('node-paste', {
                        detail: { nodes: this.clipboardNodes, pasteCenter }
                    }));
                } else {
                    void readTextFromSystemClipboard().then((text) => {
                        if (!text || !text.trim()) return;
                        this.container?.dispatchEvent(new CustomEvent('system-text-paste', {
                            detail: { text: text.trim(), pasteCenter }
                        }));
                    });
                }
                return;
            }

            // Command/Meta 键：启用框选模式
            if ((event.key === 'Meta' || event.key === 'Meta') && !event.repeat) {
                this.isMetaPressed = true;
                if (this.cy) {
                    this.cy.boxSelectionEnabled(true);
                }
            }

            // Delete 或 Backspace 键
            if (event.key === 'Delete' || event.key === 'Backspace') {
                if (!this.cy) return;

                // 获取选中的元素
                const selected = this.cy.$(':selected');

                // 检查是否有选中的普通节点
                const selectedNodes = selected.filter('node[!isGroup]');

                if (selectedNodes.length > 0) {
                    // 阻止默认行为（避免浏览器后退）
                    event.preventDefault();
                    event.stopPropagation();

                    // 如果选中的节点 >= 2个，使用批量删除
                    if (selectedNodes.length >= 2) {
                        // 保存选中的节点 ID 和完整节点数据
                        this.batchSelectedNodeIds = [];
                        this.batchSelectedNodes = [];
                        selectedNodes.forEach((node: any) => {
                            const data = node.data();
                            if (data.originalNode && data.originalNode.IDStr) {
                                this.batchSelectedNodeIds.push(data.originalNode.IDStr);
                                // 保存完整节点数据，包含 isCrossDomain 等信息
                                this.batchSelectedNodes.push({
                                    IDStr: data.originalNode.IDStr,
                                    isCrossDomain: data.originalNode.isCrossDomain || false,
                                    originalNode: data.originalNode
                                });
                            }
                        });

                        // 触发批量删除
                        this.batchDeleteNodes();
                        return;
                    }

                    // 单个节点删除，使用现有的确认流程
                    selectedNodes.forEach((node: any) => {
                        const data = node.data();
                        const originalNode = data.originalNode;

                        if (originalNode) {
                            // 计算节点的关系数量（入边 + 出边）
                            const connectedEdges = node.connectedEdges();
                            const relationCount = connectedEdges.length;

                            this.container?.dispatchEvent(new CustomEvent('node-delete-key', {
                                detail: {
                                    node: originalNode,
                                    relationCount: relationCount
                                }
                            }));
                        }
                    });

                    return; // 处理完节点删除后返回
                }
                
                // 检查是否有选中的分组节点
                const selectedGroups = selected.filter('node[?isGroup]');
                
                if (selectedGroups.length > 0) {
                    // 阻止默认行为（避免浏览器后退）
                    event.preventDefault();
                    event.stopPropagation();
                    
                    // 触发删除分组事件
                    selectedGroups.forEach((groupNode: any) => {
                        const data = groupNode.data();
                        this.container?.dispatchEvent(new CustomEvent('group-delete-key', {
                            detail: {
                                groupId: data.id,
                                groupLabel: data.label
                            }
                        }));
                    });
                    
                    return;
                }
                
                // 检查是否有选中的边（所有类型）
                const selectedEdges = selected.filter('edge');

                if (selectedEdges.length > 0) {
                    // 阻止默认行为
                    event.preventDefault();
                    event.stopPropagation();

                    // 触发删除边事件
                    selectedEdges.forEach((edge: any) => {
                        const data = edge.data();

                        // 获取目标节点的 nodeSons 信息
                        const targetNode = this.cy!.$id(data.target);
                        if (!targetNode.length) return;

                        const targetData = targetNode.data();
                        const targetNodeSons = targetData.originalNode ? targetData.originalNode.nodeSons : 1;

                        this.container?.dispatchEvent(new CustomEvent('edge-delete-key', {
                            detail: {
                                edgeId: data.id,
                                source: data.originalSource || data.source,  // 使用原始 ID
                                target: data.originalTarget || data.target,  // 使用原始 ID
                                type: data.type,
                                label: data.label,
                                targetNodeSons: targetNodeSons  // 添加目标节点的子节点数量
                            }
                        }));
                    });
                }
            }

            // Space 键：选中单个节点时进入编辑态
            if ((event.key === ' ' || event.code === 'Space') && !event.repeat) {
                if (!this.cy || this.isReadOnlyMode()) return;

                const activeElement = document.activeElement as HTMLElement | null;
                const isTypingIntoInput = !!activeElement && (
                    activeElement.tagName === 'INPUT' ||
                    activeElement.tagName === 'TEXTAREA' ||
                    activeElement.isContentEditable
                );
                if (isTypingIntoInput) {
                    return;
                }

                const hasExistingEditor =
                    !!this.container?.querySelector('.node-label-editor') ||
                    !!this.container?.querySelector('.edge-label-editor');
                if (hasExistingEditor) {
                    return;
                }

                const selected = this.cy.$(':selected');
                const selectedNodes = selected.filter('node[!isGroup]');
                if (selectedNodes.length === 1) {
                    const node = selectedNodes.first();
                    const data = node.data();
                    if (!data || data.isCrossDomain) {
                        return;
                    }

                    event.preventDefault();
                    event.stopPropagation();
                    this.showInlineNodeEditor(node);
                    return;
                }

                // 选中单条边时，Space 进入边标签编辑
                const selectedEdges = selected.filter('edge');
                if (selectedEdges.length === 1 && selectedNodes.length === 0) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.showInlineEdgeLabelEditor(selectedEdges.first());
                    return;
                }
            }

            // Tab 键：创建子节点
            if (event.key === 'Tab' && !event.shiftKey && !event.repeat) {
                event.preventDefault();
                this.handleCreateChildNode();
                return;
            }

            // Enter 键：创建兄弟节点（仅在没有打开内联编辑器时）
            if (event.key === 'Enter' && !event.repeat) {
                // 检查是否有打开的内联编辑器
                if (!isInlineEditing) {
                    event.preventDefault();
                    this.handleCreateSiblingNode();
                    return;
                }
            }

            // Shift+Tab 键：创建父节点
            if (event.key === 'Tab' && event.shiftKey && !event.repeat) {
                event.preventDefault();
                this.handleCreateParentNode();
                return;
            }

            // 方向键：切换选中节点
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && !event.repeat) {
                // 检查是否有打开的内联编辑器
                if (!isInlineEditing) {
                    event.preventDefault();
                    this.handleArrowKeyNavigation(event.key);
                    return;
                }
            }
        };

        // 监听键盘松开事件
        const handleKeyUp = (event: KeyboardEvent) => {
            // Command/Meta 键：禁用框选模式
            if (event.key === 'Meta') {
                this.isMetaPressed = false;
                if (this.cy) {
                    this.cy.boxSelectionEnabled(false);
                }
            }
        };

        // 添加事件监听器
        this.overlayScheduler.addManagedDomListener(this.container, 'keydown', handleKeyDown);
        this.overlayScheduler.addManagedDomListener(this.container, 'keyup', handleKeyUp);
        this.overlayScheduler.addManagedDomListener(this.container, 'zk-open-search-bar', () => {
            this.showSearchBar();
        });

        // 确保容器可以接收键盘事件
        if (!this.container.hasAttribute('tabindex')) {
            this.container.setAttribute('tabindex', '0');
        }

        // 当容器获得焦点时，自动聚焦
        this.overlayScheduler.addManagedDomListener(this.container, 'mousedown', () => {
            this.container?.focus();
        });
    }

    /**
     * 判断是否需要重新布局
     */
export function shouldRelayout(this: any, changes: GraphChanges): boolean {
        if (!this.currentData) return true;
        return layoutAdapter.shouldRelayout(changes, this.currentData.nodes.length);
    }

    /**
     * 添加分组调整大小手柄
     */
export function addGroupResizeHandles(this: any): void {
        if (!this.cy || !this.container) return;

        // 移除旧的手柄容器
        const oldHandleContainer = this.container.querySelector('.zk-group-resize-handles');
        if (oldHandleContainer) {
            oldHandleContainer.remove();
        }

        // 创建手柄容器
        const handleContainer = document.createElement('div');
        handleContainer.className = 'zk-group-resize-handles';
        handleContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 999;
        `;
        this.container.appendChild(handleContainer);

        let currentHandles: HTMLElement[] = [];
        let selectedGroup: any = null;
        let resizePreview: HTMLElement | null = null;  // 添加预览框

        // 清除所有手柄
        const clearHandles = () => {
            currentHandles.forEach(handle => handle.remove());
            currentHandles = [];
            selectedGroup = null;
            if (resizePreview) {
                resizePreview.remove();
                resizePreview = null;
            }
        };

        // 创建四个角的调整大小手柄
        const createResizeHandles = (groupNode: any) => {
            clearHandles();
            selectedGroup = groupNode;

            const positions = [
                { name: 'nw', cursor: 'nwse-resize', x: 0, y: 0 },      // 左上
                { name: 'ne', cursor: 'nesw-resize', x: 1, y: 0 },      // 右上
                { name: 'sw', cursor: 'nesw-resize', x: 0, y: 1 },      // 左下
                { name: 'se', cursor: 'nwse-resize', x: 1, y: 1 }       // 右下
            ];

            positions.forEach(pos => {
                const handle = document.createElement('div');
                handle.className = `zk-group-resize-handle zk-group-resize-${pos.name}`;
                handle.style.cssText = `
                    position: absolute;
                    width: 10px;
                    height: 10px;
                    background-color: #5b8fd9;
                    border: 2px solid #ffffff;
                    border-radius: 2px;
                    cursor: ${pos.cursor};
                    pointer-events: auto;
                    transform: translate(-50%, -50%);
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    z-index: 1000;
                `;
                handleContainer.appendChild(handle);
                currentHandles.push(handle);


                // 绑定拖动事件
                this.bindResizeHandleDrag(handle, groupNode, pos, handleContainer);
            });

            // 更新手柄位置
            updateHandlePositions();
        };

        // 更新手柄位置
        const updateHandlePositions = () => {
            if (!selectedGroup || currentHandles.length === 0) return;
            if (!this.cy) return;

            const bb = selectedGroup.renderedBoundingBox();
            const positions = [
                { x: bb.x1, y: bb.y1 },  // 左上
                { x: bb.x2, y: bb.y1 },  // 右上
                { x: bb.x1, y: bb.y2 },  // 左下
                { x: bb.x2, y: bb.y2 }   // 右下
            ];


            currentHandles.forEach((handle, index) => {
                handle.style.transform = `translate(${positions[index].x}px, ${positions[index].y}px) translate(-50%, -50%)`;
            });
        };

        // 监听分组节点选中事件
        this.cy.on('select', 'node[?isGroup]', (evt: any) => {
            const groupNode = evt.target;
            createResizeHandles(groupNode);
        });

        // 监听分组节点取消选中事件
        this.cy.on('unselect', 'node[?isGroup]', () => {
            clearHandles();
        });

        // 注册到统一 overlay 调度器
        this.overlayScheduler.updaters.add(updateHandlePositions);
    }

    /**
     * 绑定调整大小手柄的拖动事件
     */
export function bindResizeHandleDrag(this: any, handle: HTMLElement,
        groupNode: any,
        position: { name: string; cursor: string; x: number; y: number },
        handleContainer: HTMLElement): void {
        if (!this.cy || !this.container) return;

        let isDragging = false;
        let startMousePos: { x: number; y: number } | null = null;
        let startBoundingBox: any = null;
        let originalNodeIds: string[] = [];
        let resizePreview: HTMLElement | null = null;

        handle.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            isDragging = true;
            startMousePos = { x: e.clientX, y: e.clientY };
            startBoundingBox = groupNode.renderedBoundingBox();
            
            // 记录原始节点列表
            originalNodeIds = groupNode.data('nodeIds') || [];


            // 创建预览框
            resizePreview = document.createElement('div');
            resizePreview.className = 'zk-group-resize-preview';
            resizePreview.style.cssText = `
                position: absolute;
                border: 2px dashed #5b8fd9;
                background-color: rgba(91, 143, 217, 0.1);
                pointer-events: none;
                z-index: 998;
            `;
            handleContainer.appendChild(resizePreview);

            // 禁用 Cytoscape 的平移
            if (this.cy) {
                this.cy.userPanningEnabled(false);
                this.cy.boxSelectionEnabled(false);
            }

            // 添加全局鼠标移动和释放监听器
            let groupResizeRafId: number | null = null;
            let lastResizeMouseX = 0;
            let lastResizeMouseY = 0;
            const handleMouseMove = (e: MouseEvent) => {
                if (!isDragging || !startMousePos || !startBoundingBox || !this.cy) return;
                lastResizeMouseX = e.clientX;
                lastResizeMouseY = e.clientY;

                // 预览框位置立即更新（轻量 DOM 操作）
                const deltaX = (e.clientX - startMousePos.x);
                const deltaY = (e.clientY - startMousePos.y);
                let newX1 = startBoundingBox.x1;
                let newY1 = startBoundingBox.y1;
                let newX2 = startBoundingBox.x2;
                let newY2 = startBoundingBox.y2;
                if (position.x === 0) { newX1 += deltaX; } else { newX2 += deltaX; }
                if (position.y === 0) { newY1 += deltaY; } else { newY2 += deltaY; }
                const minSize = 50;
                if (newX2 - newX1 < minSize || newY2 - newY1 < minSize) return;
                if (resizePreview) {
                    resizePreview.style.transform = `translate(${newX1}px, ${newY1}px)`;
                    resizePreview.style.width = `${newX2 - newX1}px`;
                    resizePreview.style.height = `${newY2 - newY1}px`;
                }

                // 节点遍历和分组更新通过 RAF 节流（重操作）
                if (groupResizeRafId !== null) return;
                groupResizeRafId = requestAnimationFrame(() => {
                    groupResizeRafId = null;
                    if (!isDragging || !startMousePos || !startBoundingBox || !this.cy) return;

                    const dx = (lastResizeMouseX - startMousePos.x);
                    const dy = (lastResizeMouseY - startMousePos.y);
                    let x1 = startBoundingBox.x1;
                    let y1 = startBoundingBox.y1;
                    let x2 = startBoundingBox.x2;
                    let y2 = startBoundingBox.y2;
                    if (position.x === 0) { x1 += dx; } else { x2 += dx; }
                    if (position.y === 0) { y1 += dy; } else { y2 += dy; }
                    if (x2 - x1 < minSize || y2 - y1 < minSize) return;

                    const nodesInBounds: any[] = [];
                    this.cy!.nodes('[!isGroup]').forEach((node: any) => {
                        const nodeBB = node.renderedBoundingBox();
                        const nodeCenterX = (nodeBB.x1 + nodeBB.x2) / 2;
                        const nodeCenterY = (nodeBB.y1 + nodeBB.y2) / 2;
                        if (nodeCenterX >= x1 && nodeCenterX <= x2 &&
                            nodeCenterY >= y1 && nodeCenterY <= y2) {
                            nodesInBounds.push(node);
                        }
                    });

                    const newNodeIds = nodesInBounds
                        .filter(n => n.data('originalNode') && !n.data('isPlaceholder'))
                        .map(n => n.data('originalNode').ID);

                    nodesInBounds.forEach(node => {
                        if (!node.data('isPlaceholder') &&
                            node.data('originalNode') &&
                            !originalNodeIds.includes(node.data('originalNode').ID)) {
                            node.data('parent', groupNode.id());
                        }
                    });

                    this.cy!.nodes(`[parent="${groupNode.id()}"]`).forEach((node: any) => {
                        if (!node.data('isPlaceholder') && node.data('originalNode')) {
                            const nodeId = node.data('originalNode').ID;
                            if (!newNodeIds.includes(nodeId)) {
                                node.data('parent', undefined);
                            }
                        }
                    });
                });
            };

            const handleMouseUp = (e: MouseEvent) => {
                if (!isDragging) return;

                isDragging = false;

                // 移除预览框
                if (resizePreview) {
                    resizePreview.remove();
                    resizePreview = null;
                }

                // 恢复 Cytoscape 的平移
                if (this.cy) {
                    this.cy.userPanningEnabled(true);
                    this.cy.boxSelectionEnabled(true);
                }

                // 重新计算最终边界（使用最终鼠标位置）
                if (startMousePos && startBoundingBox && this.cy) {
                    const deltaX = e.clientX - startMousePos.x;
                    const deltaY = e.clientY - startMousePos.y;

                    let newX1 = startBoundingBox.x1;
                    let newY1 = startBoundingBox.y1;
                    let newX2 = startBoundingBox.x2;
                    let newY2 = startBoundingBox.y2;

                    if (position.x === 0) {
                        newX1 += deltaX;
                    } else {
                        newX2 += deltaX;
                    }

                    if (position.y === 0) {
                        newY1 += deltaY;
                    } else {
                        newY2 += deltaY;
                    }


                    // 确保最小尺寸
                    const minSize = 50;
                    if (newX2 - newX1 >= minSize && newY2 - newY1 >= minSize) {
                        // 查找最终边界内的所有节点
                        const nodesInBounds: any[] = [];
                        this.cy.nodes('[!isGroup]').forEach((node: any) => {
                            const nodeBB = node.renderedBoundingBox();
                            const nodeCenterX = (nodeBB.x1 + nodeBB.x2) / 2;
                            const nodeCenterY = (nodeBB.y1 + nodeBB.y2) / 2;

                            if (nodeCenterX >= newX1 && nodeCenterX <= newX2 &&
                                nodeCenterY >= newY1 && nodeCenterY <= newY2) {
                                nodesInBounds.push(node);
                            }
                        });


                        // 清除所有当前的 parent 关系
                        this.cy.nodes(`[parent="${groupNode.id()}"]`).forEach((node: any) => {
                            node.data('parent', undefined);
                        });

                        // 设置新的 parent 关系
                        nodesInBounds.forEach(node => {
                            const currentParent = node.data('parent');
                            const isGroup = node.data('isGroup');
                            const nodeId = node.data('originalNode')?.ID || node.id();
                    
                            // 分组节点不能作为子节点
                            if (isGroup) {
                                return;
                            }
                            
                            // 使用 move() 方法移动节点到新的 parent
                            try {
                                if (currentParent !== groupNode.id()) {
                                    node.move({ parent: groupNode.id() });

                                }
                            } catch (error) {
                                console.warn('  Failed to move node:', error);
                            }
                        });                    
                    }
                }

                // 获取最终的节点列表
                const finalNodeIds: string[] = [];
                this.cy?.nodes(`[parent="${groupNode.id()}"]`).forEach((node: any) => {
                    if (!node.data('isPlaceholder') && node.data('originalNode')) {
                        const nodeId = node.data('originalNode').ID;
                        finalNodeIds.push(nodeId);
                    }
                });


                // 更新分组的 nodeIds 数据
                groupNode.data('nodeIds', finalNodeIds);

                // 强制 Cytoscape 重新计算分组边界
                if (this.cy) {
                    // 触发布局更新
                    this.cy.nodes(`[parent="${groupNode.id()}"]`).forEach((node: any) => {
                        node.trigger('position');
                    });
                    
                    // 强制重绘
                    this.cy.forceRender();
                }

                // 触发分组更新事件
                if (finalNodeIds.length > 0 && 
                    JSON.stringify(finalNodeIds.sort()) !== JSON.stringify(originalNodeIds.sort())) {
                    this.container?.dispatchEvent(new CustomEvent('group-resize', {
                        detail: {
                            groupId: groupNode.id(),
                            groupLabel: groupNode.data('label'),
                            nodeIds: finalNodeIds
                        }
                    }));
                }

                // 移除全局监听器
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });
    }

    /**
     * 选择选择框内的节点
     */
export function selectNodesInBox(this: any, left: number, top: number, width: number, height: number): void {
        if (!this.cy) return;

        const nodes = this.cy.nodes().filter((node: any) => !node.data('isGroup'));

        nodes.forEach((node: any) => {
            const bbox = node.renderedBoundingBox();
            const intersects = !(
                bbox.x2 < left ||
                bbox.x1 > left + width ||
                bbox.y2 < top ||
                bbox.y1 > top + height
            );

            if (intersects) {
                node.select();
            }
        });
    }

    /**
     * 初始化框选功能
     */
export function initBoxSelection(this: any): void {
        if (!this.cy || !this.container) return;

        this.boxSelectionElement?.remove();

        // 创建选择框元素
        const selectionBox = document.createElement('div');
        selectionBox.className = 'zk-selection-box';
        selectionBox.style.cssText = `
            position: absolute;
            left: 0;
            top: 0;
            display: none;
            border: 2px dashed #5b8fd9;
            background-color: rgba(91, 143, 217, 0.1);
            border-radius: 4px;
            pointer-events: none;
            z-index: 9999;
            will-change: transform;
        `;
        this.container.appendChild(selectionBox);
        this.boxSelectionElement = selectionBox;

        let isDragging = false;
        let hasMoved = false;  // 标记是否真正移动了鼠标
        let startX = 0;
        let startY = 0;
        let isMultiSelect = false;

        // 鼠标按下开始框选
        this.overlayScheduler.addManagedDomListener(this.container, 'mousedown', (e: MouseEvent) => {
            const target = e.target as HTMLElement;

            // 只在 canvas 上点击时才开始框选
            if (target.tagName !== 'CANVAS') return;

            // 只有左键（button === 0）才能触发框选
            if (e.button !== 0) return;

            // 必须按住 Command 键才能开始框选
            if (!e.metaKey && !e.ctrlKey) return;

            // 检查点击位置是否有节点
            if (this.cy) {
                const rect = (this.container?.getBoundingClientRect() as DOMRect) ?? new DOMRect(0, 0, 0, 0);
                const clickX = e.clientX - rect.left;
                const clickY = e.clientY - rect.top;

                // 检查点击位置是否在某个节点上
                const clickedNode = this.cy.$('node').filter((node: any) => {
                    const bbox = node.renderedBoundingBox();
                    return clickX >= bbox.x1 && clickX <= bbox.x2 &&
                           clickY >= bbox.y1 && clickY <= bbox.y2;
                });

                // 如果点击在节点上，不开始框选
                if (clickedNode.length > 0) {
                    return;
                }
            }

            // 检查是否按住多选键
            isMultiSelect = e.shiftKey || e.ctrlKey || e.metaKey;

            // 如果没有按住多选键，先清除现有选择
            if (!isMultiSelect && this.cy) {
                this.cy.$(':selected').unselect();
                this.hideBatchToolbar();
            }

            const rect = (this.container?.getBoundingClientRect() as DOMRect) ?? new DOMRect(0, 0, 0, 0);
            startX = e.clientX - rect.left;
            startY = e.clientY - rect.top;
            isDragging = true;
            hasMoved = false;  // 重置移动标记

            // 显示选择框
            selectionBox.style.display = 'block';
            selectionBox.style.transform = `translate(${startX}px, ${startY}px)`;
            selectionBox.style.width = '0px';
            selectionBox.style.height = '0px';

            e.preventDefault();
        });

        // 鼠标移动更新选择框
        let boxSelectRafId: number | null = null;
        let lastBoxLeft = 0, lastBoxTop = 0, lastBoxWidth = 0, lastBoxHeight = 0;
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;

            const rect = (this.container?.getBoundingClientRect() as DOMRect) ?? new DOMRect(0, 0, 0, 0);
            const currentX = e.clientX - rect.left;
            const currentY = e.clientY - rect.top;

            if (Math.abs(currentX - startX) > 5 || Math.abs(currentY - startY) > 5) {
                hasMoved = true;
            }

            lastBoxLeft = Math.min(startX, currentX);
            lastBoxTop = Math.min(startY, currentY);
            lastBoxWidth = Math.abs(currentX - startX);
            lastBoxHeight = Math.abs(currentY - startY);

            // 选择框视觉立即更新
            selectionBox.style.transform = `translate(${lastBoxLeft}px, ${lastBoxTop}px)`;
            selectionBox.style.width = `${lastBoxWidth}px`;
            selectionBox.style.height = `${lastBoxHeight}px`;

            // 节点选择检测通过 RAF 节流
            if (boxSelectRafId !== null) return;
            boxSelectRafId = requestAnimationFrame(() => {
                boxSelectRafId = null;
                if (!isDragging) return;
                this.selectNodesInBox(lastBoxLeft, lastBoxTop, lastBoxWidth, lastBoxHeight);
            });
        };

        // 鼠标释放结束框选
        const handleMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;

            // 隐藏选择框
            selectionBox.style.display = 'none';

            // 只有在真正移动了鼠标（框选操作）时才显示批量工具栏
            if (hasMoved) {
                setTimeout(() => {
                    this.showBatchToolbar();
                }, 20);
            }
        };

        this.overlayScheduler.addManagedDomListener(document, 'mousemove', handleMouseMove);
        this.overlayScheduler.addManagedDomListener(document, 'mouseup', handleMouseUp);
    }

    /**
     * 显示批量操作工具栏
     */
export function showBatchToolbar(this: any): void {
        if (!this.cy || !this.container) return;
        if (this.isReadOnlyMode()) {
            this.hideBatchToolbar();
            return;
        }

        const selectedNodes = this.cy.$(':selected').filter('node[!isGroup]');
        const count = selectedNodes.length;

        if (count < 2) {
            this.hideBatchToolbar();
            return;
        }

        // 保存选中的节点ID（使用 originalNode.IDStr）
        this.batchSelectedNodeIds = [];
        this.batchSelectedNodes = [];
        selectedNodes.forEach((node: any) => {
            const data = node.data();
            if (data.originalNode && data.originalNode.IDStr) {
                this.batchSelectedNodeIds.push(data.originalNode.IDStr);
                this.batchSelectedNodes.push({
                    IDStr: data.originalNode.IDStr,
                    isCrossDomain: data.originalNode.isCrossDomain || false,
                    originalNode: data.originalNode
                });
            }
        });

        // 如果正在退出动画中，先移除
        let toolbar = this.container.querySelector('.zk-batch-toolbar') as HTMLElement | null;
        if (toolbar && toolbar.classList.contains('zk-batch-toolbar-exiting')) {
            toolbar.remove();
            toolbar = null;
        }
        if (!toolbar) {
            toolbar = this.createBatchToolbar();
            this.container?.appendChild(toolbar);
        }
        if (!toolbar) return;

        // 更新计数
        const countLabel = toolbar.querySelector('.zk-batch-toolbar-count');
        if (countLabel) {
            countLabel.textContent = t('batch selected count').replace('{count}', String(count));
        }
    }

    /**
     * 显示搜索栏（Cmd+F）
     */
export function showSearchBar(this: any): void {
        if (!this.cy || !this.container) return;

        // 如果已有搜索栏，聚焦输入框
        const existing = this.container.querySelector('.zk-search-bar');
        if (existing) {
            const input = existing.querySelector('.zk-search-bar-input') as HTMLInputElement;
            input?.focus();
            input?.select();
            return;
        }

        let matchedNodes: any[] = [];
        let filteredNodes: any[] = [];
        let currentIndex = -1;
        let activeSuggestionIndex = -1;

        const bar = document.createElement('div');
        bar.className = 'zk-search-bar';

        // 阻止事件穿透到画布
        bar.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
        bar.addEventListener('mousedown', (e) => { e.stopPropagation(); });

        const inputWrap = document.createElement('div');
        inputWrap.className = 'zk-search-bar-input-wrap';
        bar.appendChild(inputWrap);

        // 搜索输入框
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'zk-search-bar-input';
        input.placeholder = t('search placeholder');
        inputWrap.appendChild(input);

        // 候选框
        const suggestionBox = document.createElement('div');
        suggestionBox.className = 'zk-search-suggestions zk-hidden';
        inputWrap.appendChild(suggestionBox);

        // 计数
        const countLabel = document.createElement('span');
        countLabel.className = 'zk-search-bar-count';
        countLabel.textContent = '';
        bar.appendChild(countLabel);

        // 上一个
        const prevBtn = document.createElement('button');
        prevBtn.className = 'zk-search-bar-btn';
        setIcon(prevBtn, 'chevron-up');
        prevBtn.title = 'Previous';
        bar.appendChild(prevBtn);

        // 下一个
        const nextBtn = document.createElement('button');
        nextBtn.className = 'zk-search-bar-btn';
        setIcon(nextBtn, 'chevron-down');
        nextBtn.title = 'Next';
        bar.appendChild(nextBtn);

        // 关闭
        const closeBtn = document.createElement('button');
        closeBtn.className = 'zk-search-bar-btn';
        setIcon(closeBtn, 'x');
        bar.appendChild(closeBtn);

        this.container.appendChild(bar);

        const clearHighlights = () => {
            this.cy?.nodes().forEach((n: any) => n.removeClass('zk-search-highlight'));
        };

        const highlightCurrent = () => {
            clearHighlights();
            if (matchedNodes.length === 0 || currentIndex < 0) return;
            const node = matchedNodes[currentIndex];
            node.addClass('zk-search-highlight');
            this.cy?.animate({ center: { eles: node }, duration: 200 });
            node.select();
        };

        const updateCount = () => {
            if (!input.value.trim()) {
                countLabel.textContent = '';
            } else if (matchedNodes.length > 0 && currentIndex >= 0) {
                countLabel.textContent = `${currentIndex + 1}/${matchedNodes.length}`;
            } else {
                countLabel.textContent = `${filteredNodes.length}`;
            }
        };

        const renderSuggestions = () => {
            suggestionBox.empty();
            if (!input.value.trim() || filteredNodes.length === 0) {
                suggestionBox.addClass('zk-hidden');
                return;
            }

            const visibleCount = Math.min(filteredNodes.length, 12);
            for (let i = 0; i < visibleCount; i++) {
                const node = filteredNodes[i];
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'zk-search-suggestion-item';
                if (i === activeSuggestionIndex) {
                    item.addClass('is-active');
                }

                const origNode = node.data('originalNode');
                const title = origNode?.title || node.data('label') || '';
                item.textContent = title;

                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
                item.addEventListener('click', () => {
                    matchedNodes = filteredNodes;
                    currentIndex = i;
                    highlightCurrent();
                    updateCount();
                    suggestionBox.addClass('zk-hidden');
                    input.focus();
                });
                suggestionBox.appendChild(item);
            }

            suggestionBox.removeClass('zk-hidden');
        };

        const doSearch = () => {
            const term = input.value.trim().toLowerCase();
            clearHighlights();
            matchedNodes = [];
            filteredNodes = [];
            currentIndex = -1;
            activeSuggestionIndex = -1;

            if (!term || !this.cy) {
                suggestionBox.addClass('zk-hidden');
                updateCount();
                return;
            }

            this.cy.nodes('[!isGroup]').forEach((node: any) => {
                const label = (node.data('label') || '').toLowerCase();
                const origNode = node.data('originalNode');
                const filePath = (origNode?.file?.path || '').toLowerCase();
                if (/(^|\/)attachments\//.test(filePath)) {
                    return;
                }
                const idStr = (origNode?.IDStr || '').toLowerCase();
                const title = (origNode?.title || '').toLowerCase();
                if (label.includes(term) || idStr.includes(term) || title.includes(term)) {
                    filteredNodes.push(node);
                }
            });

            renderSuggestions();
            updateCount();
        };

        const goNext = () => {
            if (matchedNodes.length === 0 && filteredNodes.length > 0) {
                matchedNodes = filteredNodes;
                currentIndex = 0;
                highlightCurrent();
                updateCount();
                return;
            }
            if (matchedNodes.length === 0) return;
            currentIndex = (currentIndex + 1) % matchedNodes.length;
            highlightCurrent();
            updateCount();
        };

        const goPrev = () => {
            if (matchedNodes.length === 0 && filteredNodes.length > 0) {
                matchedNodes = filteredNodes;
                currentIndex = Math.max(0, matchedNodes.length - 1);
                highlightCurrent();
                updateCount();
                return;
            }
            if (matchedNodes.length === 0) return;
            currentIndex = (currentIndex - 1 + matchedNodes.length) % matchedNodes.length;
            highlightCurrent();
            updateCount();
        };

        const closeSearch = () => {
            clearHighlights();
            suggestionBox.addClass('zk-hidden');
            // 先收起键盘，等视口恢复后再移除搜索栏，避免移动端工具栏上移
            input.blur();
            setTimeout(() => {
                bar.remove();
            }, 100);
        };

        input.addEventListener('input', doSearch);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' && !suggestionBox.classList.contains('zk-hidden') && filteredNodes.length > 0) {
                e.preventDefault();
                const total = Math.min(filteredNodes.length, 12);
                activeSuggestionIndex = (activeSuggestionIndex + 1 + total) % total;
                renderSuggestions();
            } else if (e.key === 'ArrowUp' && !suggestionBox.classList.contains('zk-hidden') && filteredNodes.length > 0) {
                e.preventDefault();
                const total = Math.min(filteredNodes.length, 12);
                activeSuggestionIndex = (activeSuggestionIndex - 1 + total) % total;
                renderSuggestions();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                doSearch();
                if (filteredNodes.length > 0) {
                    if (activeSuggestionIndex < 0) {
                        activeSuggestionIndex = 0;
                    }
                    matchedNodes = filteredNodes;
                    currentIndex = activeSuggestionIndex;
                    highlightCurrent();
                    updateCount();
                    suggestionBox.addClass('zk-hidden');
                } else if (e.shiftKey) {
                    goPrev();
                } else {
                    goNext();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
            }
        });
        input.addEventListener('focus', () => {
            if (filteredNodes.length > 0) {
                renderSuggestions();
            }
        });
        input.addEventListener('blur', () => {
            setTimeout(() => suggestionBox.addClass('zk-hidden'), 120);
        });

        prevBtn.addEventListener('click', goPrev);
        nextBtn.addEventListener('click', goNext);
        closeBtn.addEventListener('click', closeSearch);

        // 移动端触摸支持
        prevBtn.addEventListener('touchend', (e) => { e.preventDefault(); goPrev(); });
        nextBtn.addEventListener('touchend', (e) => { e.preventDefault(); goNext(); });
        closeBtn.addEventListener('touchend', (e) => { e.preventDefault(); closeSearch(); });

        // 自动聚焦
        setTimeout(() => input.focus(), 50);
    }

    /**
     * 隐藏批量操作工具栏
     */
export function hideBatchToolbar(this: any): void {
        const toolbar = this.container?.querySelector('.zk-batch-toolbar') as HTMLElement | null;
        if (!toolbar) return;

        if (toolbar.classList.contains('zk-batch-toolbar-exiting')) return;

        toolbar.classList.add('zk-batch-toolbar-exiting');
        toolbar.addEventListener('animationend', () => {
            toolbar.remove();
        }, { once: true });

        // 兜底：动画未触发时也能移除
        setTimeout(() => {
            if (toolbar.parentNode) {
                toolbar.remove();
            }
        }, 250);
    }

    /**
     * 创建批量操作工具栏
     */
export function createBatchToolbar(this: any): HTMLElement {
        const toolbar = document.createElement('div');
        toolbar.className = 'zk-batch-toolbar';

        // 防止事件穿透到画布
        const stopPropagation = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
        };
        toolbar.addEventListener('pointerdown', stopPropagation);
        toolbar.addEventListener('mousedown', stopPropagation);

        // 计数徽章
        const countBadge = document.createElement('span');
        countBadge.className = 'zk-batch-toolbar-count';
        countBadge.textContent = t('batch selected count').replace('{count}', '0');
        toolbar.appendChild(countBadge);

        // 分隔线
        const divider1 = document.createElement('div');
        divider1.className = 'zk-batch-toolbar-divider';
        toolbar.appendChild(divider1);

        // 分组按钮
        toolbar.appendChild(this.createToolbarButton('group', t('batch group'), '', () => this.batchCreateGroup()));

        // 删除按钮
        toolbar.appendChild(this.createToolbarButton('trash-2', t('batch delete'), 'zk-batch-btn-delete', () => this.batchDeleteNodes()));

        // 改颜色按钮
        toolbar.appendChild(this.createToolbarButton('palette', t('batch change color'), '', () => this.batchChangeColor()));

        // 分隔线
        const divider2 = document.createElement('div');
        divider2.className = 'zk-batch-toolbar-divider';
        toolbar.appendChild(divider2);

        // 取消按钮
        toolbar.appendChild(this.createToolbarButton('x', t('batch cancel'), 'zk-batch-btn-cancel', () => {
            if (this.cy) {
                this.cy.$(':selected').unselect();
            }
            this.hideBatchToolbar();
        }));

        return toolbar;
    }

    /**
     * 创建工具栏按钮（带 Lucide 图标）
     */
export function createToolbarButton(this: any, iconName: string, label: string, extraClass: string, onClick: () => void): HTMLElement {
        const btn = document.createElement('button');
        btn.className = `zk-batch-toolbar-btn ${extraClass}`.trim();

        // 图标
        const iconEl = document.createElement('span');
        iconEl.className = 'zk-batch-toolbar-icon';
        setIcon(iconEl, iconName);
        btn.appendChild(iconEl);

        // 文字
        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        btn.appendChild(labelEl);

        btn.onclick = (event: MouseEvent) => {
            event.stopPropagation();
            onClick();
        };

        return btn;
    }

    /**
     * 批量创建分组
     */
export function batchCreateGroup(this: any): void {
        if (this.batchSelectedNodeIds.length === 0) {
            return;
        }

        // 先隐藏工具栏，避免遮挡输入框
        this.hideBatchToolbar();

        // 批量分组：统一走 batch-create-group 事件链路（由 indexView 持久化）
        this.showGroupNameDialog((groupName: string | null) => {
            if (!groupName) {
                // 取消时恢复工具栏
                this.showBatchToolbar();
                return;
            }

            this.container?.dispatchEvent(new CustomEvent('batch-create-group', {
                detail: {
                    nodeIds: [...this.batchSelectedNodeIds],
                    groupName
                }
            }));

            // 清空选中缓存
            this.batchSelectedNodeIds = [];
            this.batchSelectedNodes = [];
        });
    }

    /**
     * 获取当前活动的节点（第一个选中的节点）
     */
export function getActiveNode(this: any): any | null {
        if (!this.cy) return null;

        const selectedNodes = this.cy.$('node:selected');

        if (selectedNodes.length === 0) {
            new Notice(t("Please select a node first"));
            return null;
        }

        return selectedNodes.first();
    }

export function normalizeVector(this: any, vx: number, vy: number): { x: number; y: number } {
        return layoutAdapter.normalizeVector(vx, vy);
    }

export function getBranchDirection(this: any, activeNode: any): { x: number; y: number } {
        return layoutAdapter.getBranchDirection(activeNode);
    }

export function getAutoLayoutDirection(this: any, node: any): { x: number; y: number } {
        return layoutAdapter.getAutoLayoutDirection(node);
    }

export function getPerpendicular(this: any, dir: { x: number; y: number }): { x: number; y: number } {
        return layoutAdapter.getPerpendicular(dir);
    }

export function getAutoLayoutStackDirection(this: any, dir: { x: number; y: number }): { x: number; y: number } {
        return layoutAdapter.getAutoLayoutStackDirection(dir);
    }

export function nextOffsetByProjection(this: any, points: any[], anchor: { x: number; y: number }, normal: { x: number; y: number }, gap: number): number {
        return layoutAdapter.nextOffsetByProjection(points, anchor, normal, gap);
    }

export function isAutoNodeLayoutStyle(this: any): boolean {
        return layoutAdapter.isAutoNodeLayoutStyle(this.currentOptions);
    }

    /**
     * 沿 ID 父链向上查找覆盖；未命中则回退到文件级默认
     */
export function isNodeAutoLayoutForId(this: any, nodeId: string): boolean {
        return layoutAdapter.isNodeAutoLayoutForId(nodeId, this.currentOptions);
    }

export function estimateCollisionBox(this: any, referenceNode: any): { width: number; height: number } {
        return layoutAdapter.estimateCollisionBox(referenceNode);
    }

export function getAxisSpan(this: any, size: { width: number; height: number }, dir: { x: number; y: number }): number {
        return layoutAdapter.getAxisSpan(size, dir);
    }

export function getDirectionalDistance(this: any, referenceNode: any, dir: { x: number; y: number }, extraGap: number = 48): number {
        return layoutAdapter.getDirectionalDistance(referenceNode, dir, extraGap);
    }

export function isPositionColliding(this: any, candidate: { x: number; y: number },
        size: { width: number; height: number },
        excludeNodeIds: string[] = []): boolean {
        return layoutAdapter.isPositionColliding(this.cy, candidate, size, excludeNodeIds);
    }

export function resolveShortcutPosition(this: any, basePosition: { x: number; y: number },
        referenceNode: any,
        primaryAxis: { x: number; y: number },
        step: number,
        secondaryAxis?: { x: number; y: number },
        maxAttempts: number = 7): { x: number; y: number } {
        if (!this.cy) return basePosition;
        return layoutAdapter.resolveShortcutPosition(
            this.cy,
            basePosition,
            referenceNode,
            primaryAxis,
            step,
            secondaryAxis,
            maxAttempts
        );
    }

    /**
     * 处理创建子节点（Tab 键）
     * SimpleMind 风格：子节点基于视觉位置而非 ID
     */
export function getFreeChildShortcutPosition(this: any, activeNode: any): { x: number; y: number } {
        if (!this.cy) return activeNode.position();
        return layoutAdapter.getFreeChildShortcutPosition(this.cy, activeNode);
    }

export function getAutoChildShortcutPosition(this: any, activeNode: any): { x: number; y: number } {
        return layoutAdapter.getAutoChildShortcutPosition(activeNode);
    }

export function handleCreateChildNode(this: any): void {
        const activeNode = this.getActiveNode();
        if (!activeNode) return;

        const nodeData = activeNode.data();
        const activeNodeId = nodeData.originalNode?.ID || nodeData.id;
        const finalPosition = this.isAutoNodeLayoutStyle()
            ? this.getAutoChildShortcutPosition(activeNode)
            : this.getFreeChildShortcutPosition(activeNode);

        this.container?.dispatchEvent(new CustomEvent('create-child-node-shortcut', {
            detail: { activeNodeId, position: finalPosition }
        }));
    }

    /**
     * 处理创建兄弟节点（Enter 键）
     * SimpleMind 风格：自动推开下方的兄弟节点及其子树
     */
export function getFreeSiblingShortcutPosition(this: any, activeNode: any): { x: number; y: number } {
        if (!this.cy) return activeNode.position();
        return layoutAdapter.getFreeSiblingShortcutPosition(this.cy, activeNode);
    }

export function getAutoSiblingShortcutPosition(this: any, activeNode: any): { x: number; y: number } {
        return layoutAdapter.getAutoSiblingShortcutPosition(activeNode);
    }

export function handleCreateSiblingNode(this: any): void {
        const activeNode = this.getActiveNode();
        if (!activeNode) return;

        const nodeData = activeNode.data();
        const activeNodeId = nodeData.originalNode?.ID || nodeData.id;
        const nodePos = activeNode.position();
        const parent = activeNode.incomers('edge').sources();
        if (parent.length === 0) return;

        const finalPosition = this.isAutoNodeLayoutStyle()
            ? this.getAutoSiblingShortcutPosition(activeNode)
            : this.getFreeSiblingShortcutPosition(activeNode);

        // 触发创建兄弟节点事件
        this.container?.dispatchEvent(new CustomEvent('create-sibling-node-shortcut', {
            detail: {
                activeNodeId: activeNodeId,
                position: finalPosition
            }
        }));
    }

    /**
     * 处理创建父节点（Shift+Tab 键）
     */
export function getFreeParentShortcutPosition(this: any, activeNode: any): { x: number; y: number } {
        if (!this.cy) return activeNode.position();
        return layoutAdapter.getFreeParentShortcutPosition(this.cy, activeNode);
    }

export function getAutoParentShortcutPosition(this: any, activeNode: any): { x: number; y: number } {
        return layoutAdapter.getAutoParentShortcutPosition(activeNode);
    }

export function handleCreateParentNode(this: any): void {
        const activeNode = this.getActiveNode();
        if (!activeNode) return;

        const finalPosition = this.isAutoNodeLayoutStyle()
            ? this.getAutoParentShortcutPosition(activeNode)
            : this.getFreeParentShortcutPosition(activeNode);
        const nodeData = activeNode.data();

        const activeNodeId = nodeData.originalNode?.ID || nodeData.id;


        // 触发创建父节点事件
        this.container?.dispatchEvent(new CustomEvent('create-parent-node-shortcut', {
            detail: {
                activeNodeId: activeNodeId,
                position: finalPosition
            }
        }));
    }

    /**
     * 创建占位符节点到父节点的连接线（绿色虚线）
     */
export function createPlaceholderConnectionLine(this: any, placeholderNodeId: string, parentNodeId: string): void {
        if (!this.cy || !this.container) return;

        const placeholderNode = this.cy.$id(placeholderNodeId);
        const parentNode = this.cy.$('node').filter((node: any) => {
            const data = node.data();
            return data.originalNode && data.originalNode.IDStr === parentNodeId;
        });

        if (!placeholderNode || placeholderNode.length === 0) {
            console.warn('[CytoscapeRenderer] 未找到占位符节点', placeholderNodeId);
            return;
        }

        if (!parentNode || parentNode.length === 0) {
            console.warn('[CytoscapeRenderer] 未找到父节点', parentNodeId);
            return;
        }

        // 创建 SVG 叠加层（如果不存在）
        let svgOverlay = this.container.querySelector('.placeholder-connections-svg') as SVGSVGElement;
        if (!svgOverlay) {
            svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svgOverlay.classList.add('placeholder-connections-svg');
            svgOverlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 1;
            `;
            this.container.appendChild(svgOverlay);
        }

        // 创建连接线 - 使用绿色虚线（与智能连线一致）
        const connectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        connectionLine.setAttribute('stroke', '#10b981');  // 淡绿色
        connectionLine.setAttribute('stroke-width', '2');
        connectionLine.setAttribute('stroke-dasharray', '5,5');  // 虚线
        connectionLine.setAttribute('opacity', '0.8');
        connectionLine.classList.add('placeholder-connection-line');
        connectionLine.setAttribute('data-placeholder-id', placeholderNodeId);

        // 初始位置
        const placeholderPos = placeholderNode.renderedPosition();
        const parentPos = parentNode.renderedPosition();
        connectionLine.setAttribute('x1', parentPos.x.toString());
        connectionLine.setAttribute('y1', parentPos.y.toString());
        connectionLine.setAttribute('x2', placeholderPos.x.toString());
        connectionLine.setAttribute('y2', placeholderPos.y.toString());

        svgOverlay.appendChild(connectionLine);

        // 保存连接线引用
        const nodeData = placeholderNode.data();
        (nodeData as any).connectionLine = connectionLine;
        (nodeData as any).connectionParentNode = parentNode;

        // 缓存父节点引用，避免每次都遍历所有节点
        const cachedParent = this.cy.$('node').filter((node: any) => {
            const data = node.data();
            return data.originalNode && data.originalNode.IDStr === parentNodeId;
        });

        // 更新连接线位置的函数（轻量，只读取两个节点的位置）
        const updateConnectionLine = () => {
            if (!this.cy || !connectionLine.parentNode) return;

            const currentPlaceholder = this.cy.$id(placeholderNodeId);
            if (currentPlaceholder && currentPlaceholder.length > 0 &&
                cachedParent && cachedParent.length > 0) {
                const newPos = currentPlaceholder.renderedPosition();
                const parentPos = cachedParent.renderedPosition();

                connectionLine.setAttribute('x1', parentPos.x.toString());
                connectionLine.setAttribute('y1', parentPos.y.toString());
                connectionLine.setAttribute('x2', newPos.x.toString());
                connectionLine.setAttribute('y2', newPos.y.toString());
            }
        };

        // 注册到统一 overlay 调度器，而非单独绑定事件
        this.overlayScheduler.updaters.add(updateConnectionLine);

        // 保存更新处理器引用，以便后续清理
        (nodeData as any).connectionLineUpdater = updateConnectionLine;
    }

    /**
     * 处理方向键导航
     */
export function handleArrowKeyNavigation(this: any, key: string): void {
        if (!this.cy) return;

        const activeNode = this.getActiveNode();
        if (!activeNode) return;

        const nodePosition = activeNode.position();
        const allNodes = this.cy.nodes().filter((node: any) => !node.data().isPlaceholder);

        // 根据方向键找到最近的节点
        let targetNode: any | null = null;
        let minDistance = Infinity;

        allNodes.forEach((node: any) => {
            // 跳过当前节点
            if (node.id() === activeNode.id()) return;

            const nodePos = node.position();
            const dx = nodePos.x - nodePosition.x;
            const dy = nodePos.y - nodePosition.y;

            // 检查节点是否在指定方向上
            let isInDirection = false;
            switch (key) {
                case 'ArrowUp':
                    isInDirection = dy < 0 && Math.abs(dx) < Math.abs(dy);
                    break;
                case 'ArrowDown':
                    isInDirection = dy > 0 && Math.abs(dx) < Math.abs(dy);
                    break;
                case 'ArrowLeft':
                    isInDirection = dx < 0 && Math.abs(dx) > Math.abs(dy);
                    break;
                case 'ArrowRight':
                    isInDirection = dx > 0 && Math.abs(dx) > Math.abs(dy);
                    break;
            }

            if (isInDirection) {
                const distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < minDistance) {
                    minDistance = distance;
                    targetNode = node;
                }
            }
        });

        if (targetNode) {
            // 取消当前选中
            this.cy.$(':selected').unselect();

            // 选中目标节点
            targetNode.select();

            // 可选：将视图中心移到选中的节点
            // this.cy.animate({
            //     center: { eles: targetNode },
            //     zoom: this.cy.zoom()
            // }, {
            //     duration: 200
            // });
        }
    }

    /**
     * 批量删除节点
     */
export function batchDeleteNodes(this: any): void {
        if (this.batchSelectedNodeIds.length === 0) return;
        const nodeIdsSnapshot = [...this.batchSelectedNodeIds];
        const nodesSnapshot = this.batchSelectedNodes.map((n: any) => ({ ...n }));

        // 先隐藏工具栏，避免遮挡对话框
        this.hideBatchToolbar();

        // 创建确认对话框
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10001;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background-color: var(--background-primary);
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 15px;
            min-width: 300px;
        `;

        const title = document.createElement('h3');
        title.textContent = t("Confirm delete");
        title.style.margin = '0';
        dialog.appendChild(title);

        const message = document.createElement('p');
        message.textContent = t("Confirm delete nodes").replace("{count}", String(nodeIdsSnapshot.length));
        message.style.margin = '0';
        dialog.appendChild(message);

        const buttonContainer = document.createElement('div');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.gap = '10px';
        buttonContainer.style.justifyContent = 'flex-end';

        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = t("Confirm");
        confirmBtn.onclick = () => {
            // 触发批量删除事件
            this.container?.dispatchEvent(new CustomEvent('batch-delete-nodes', {
                detail: {
                    nodeIds: nodeIdsSnapshot,
                    nodes: nodesSnapshot
                }
            }));

            overlay.remove();

            // 清除选择并清空节点ID
            if (this.cy) {
                this.cy.$(':selected').unselect();
            }
            this.batchSelectedNodeIds = [];
            this.batchSelectedNodes = [];
        };

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = t("Cancel");
        cancelBtn.onclick = () => {
            overlay.remove();
            // 用户取消，重新显示工具栏
            this.showBatchToolbar();
        };

        buttonContainer.appendChild(confirmBtn);
        buttonContainer.appendChild(cancelBtn);
        dialog.appendChild(buttonContainer);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }

    /**
     * 批量改变颜色
     */
export function batchChangeColor(this: any): void {
        if (this.batchSelectedNodeIds.length === 0) return;
        const nodeIdsSnapshot = [...this.batchSelectedNodeIds];

        // 先隐藏工具栏
        this.hideBatchToolbar();

        // 触发批量颜色选择事件
        this.container?.dispatchEvent(new CustomEvent('batch-show-color-picker', {
            detail: { nodeIds: nodeIdsSnapshot }
        }));
    }

    /**
     * 检查智能连线功能是否启用
     */
export function isSmartConnectionEnabled(this: any): boolean {
        if (this.currentOptions && typeof this.currentOptions.smartConnection === 'boolean') {
            return this.currentOptions.smartConnection;
        }
        return false;
    }
