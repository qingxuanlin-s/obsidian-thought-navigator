import * as cytoscape from 'cytoscape';
import { GraphData, GraphChanges, RenderOptions } from './types';
import { ZKNode } from 'src/view/indexView';

/** cytoscape 布局配置(含 dagre/cose-bilkent/elk 扩展字段,扩展未提供类型) */
export type LayoutConfig = { name: string; [key: string]: unknown };

// SimpleMind 风格布局间距常量
export const VERTICAL_GAP = 80;
export const HORIZONTAL_GAP = 200;
export const SIBLING_GAP = 100;

/**
 * 将方向字符串转换为 dagre 的 rankDir 格式
 */
export function directionToRankDir(direction: string): string {
    switch (direction) {
        case 'TB': return 'TB';
        case 'BT': return 'BT';
        case 'LR': return 'LR';
        case 'RL': return 'RL';
        default: return 'TB';
    }
}

/**
 * 根据 layoutType 获取布局配置(用于局部关系视图等需要自动布局的场景)
 */
export function getLayoutConfig(options: RenderOptions): LayoutConfig {
    const layoutType = options.layoutType || 'preset';

    if (layoutType === 'preset') {
        return { name: 'preset' };
    }

    const rankDir = directionToRankDir(options.direction || 'TB');

    switch (layoutType) {
        case 'dagre':
            return {
                name: 'dagre',
                rankDir: rankDir,
                nodeSep: 50,
                rankSep: 100,
                edgeSep: 10
            };

        case 'cose':
            return {
                name: 'cose',
                nodeRepulsion: 100000,
                idealEdgeLength: 100,
                edgeElasticity: 100,
                nestingFactor: 5,
                initialTemp: 200,
                coolingFactor: 0.95,
                minTemp: 1.0
            };

        case 'cose-bilkent':
            return {
                name: 'cose-bilkent',
                quality: 'proof',
                directed: false,
                nodeRepulsion: 4500,
                idealEdgeLength: 50,
                edgeElasticity: 0.45
            };

        case 'breadthfirst':
            return {
                name: 'breadthfirst',
                directed: false,
                spacingFactor: 1.5
            };

        case 'grid':
            return { name: 'grid' };

        default:
            return { name: 'preset' };
    }
}

/**
 * 主图布局配置(根据 RenderOptions.layoutType 选择)
 */
export function getLayout(options: RenderOptions): LayoutConfig {
    const layoutType = options.layoutType || 'dagre';
    const animate = options.animate !== false;
    const animationDuration = options.animationDuration || 500;

    const baseLayout = {
        animate: animate,
        animationDuration: animationDuration,
        fit: true,
        padding: 80
    };

    switch (layoutType) {
        case 'breadthfirst':
            return {
                name: 'breadthfirst',
                ...baseLayout,
                directed: true,
                spacingFactor: 1.5,
                avoidOverlap: true,
                nodeDimensionsIncludeLabels: true
            };
        case 'dagre':
            return {
                name: 'dagre',
                ...baseLayout,
                rankDir: 'LR',
                nodeSep: 150,
                edgeSep: 50,
                rankSep: 200,
                ranker: 'network-simplex',
                nodeDimensionsIncludeLabels: true
            };
        case 'cose':
            return {
                name: 'cose-bilkent',
                ...baseLayout,
                nodeRepulsion: 4500,
                idealEdgeLength: 100,
                edgeElasticity: 0.45,
                nestingFactor: 0.1,
                gravity: 0.25,
                numIter: 2500,
                tile: true,
                tilingPaddingVertical: 10,
                tilingPaddingHorizontal: 10,
                gravityRangeCompound: 1.5,
                gravityCompound: 1.0,
                gravityRange: 3.8
            };
        case 'grid':
            return {
                name: 'grid',
                ...baseLayout,
                rows: undefined,
                cols: undefined,
                avoidOverlap: true,
                avoidOverlapPadding: 10,
                nodeDimensionsIncludeLabels: true
            };
        default:
            return {
                name: 'breadthfirst',
                ...baseLayout
            };
    }
}

/**
 * 局部视图入链/出链节点预排位
 */
export function presetInOutLinksPositions(data: GraphData): void {
    const hasInOutLinks = data.nodes.some(node =>
        node.ID.startsWith('inlink-') || node.ID.startsWith('outlink-') || node.ID === 'current'
    );
    if (!hasInOutLinks) return;

    const inlinks: ZKNode[] = [];
    const outlinks: ZKNode[] = [];

    data.nodes.forEach(node => {
        if (node.ID.startsWith('inlink-')) inlinks.push(node);
        else if (node.ID.startsWith('outlink-')) outlinks.push(node);
        else if (node.ID === 'current' && !node.savedPosition) node.savedPosition = { x: 0, y: 0 };
    });

    const COLS = 3;
    const COL_GAP = 180;
    const ROW_GAP = 100;
    const CENTER_GAP = 120;

    const assignGrid = (nodes: ZKNode[], startY: number, direction: 1 | -1) => {
        for (let i = 0; i < nodes.length; i++) {
            const row = Math.floor(i / COLS);
            const col = i % COLS;
            const colsInRow = Math.min(COLS, nodes.length - row * COLS);
            const x = (col - (colsInRow - 1) / 2) * COL_GAP;
            const y = startY + direction * row * ROW_GAP;
            if (!nodes[i].savedPosition) {
                nodes[i].savedPosition = { x, y };
            }
        }
    };

    const outlinkRows = Math.ceil(outlinks.length / COLS);
    const outlinkStartY = -CENTER_GAP - (outlinkRows - 1) * ROW_GAP;
    assignGrid(outlinks, outlinkStartY, 1);

    assignGrid(inlinks, CENTER_GAP, 1);
}

/**
 * 安全运行布局:首次失败回退到 grid,再失败回退到 preset
 */
export function runLayoutSafely(cy: cytoscape.Core | null, layoutConfig: LayoutConfig): void {
    if (!cy) return;

    const nodeCount = cy.nodes().length;
    if (nodeCount <= 1) {
        cy.layout({ name: 'preset' }).run();
        return;
    }

    try {
        const layout = cy.layout(layoutConfig as cytoscape.LayoutOptions);
        layout.run();
    } catch (error) {
        console.error('[CytoscapeRenderer] layout run failed, fallback to breadthfirst', {
            layout: layoutConfig?.name,
            error
        });
        try {
            const fallbackGrid = cy.layout({
                name: 'grid',
                fit: true,
                padding: 40
            });
            fallbackGrid.run();
        } catch (fallbackError) {
            console.error('[CytoscapeRenderer] grid fallback failed, fallback to preset', fallbackError);
            try {
                cy.layout({ name: 'preset' }).run();
            } catch (presetError) {
                console.error('[CytoscapeRenderer] preset fallback failed', presetError);
            }
        }
    }
}

/**
 * 处理完全位置重合的节点,微微径向散开避免视觉重叠
 */
export function resolveExactNodeOverlaps(cy: cytoscape.Core | null): void {
    if (!cy) return;

    const buckets = new Map<string, cytoscape.NodeSingular[]>();
    cy.nodes().forEach((node: cytoscape.NodeSingular) => {
        if (node.data('isGroup')) return;
        const pos = node.position();
        const key = `${Math.round(pos.x * 10) / 10}:${Math.round(pos.y * 10) / 10}`;
        const bucket = buckets.get(key);
        if (bucket) {
            bucket.push(node);
        } else {
            buckets.set(key, [node]);
        }
    });

    cy.batch(() => {
        buckets.forEach((nodes) => {
            if (nodes.length <= 1) return;
            const basePos = nodes[0].position();
            for (let i = 1; i < nodes.length; i++) {
                const angle = (2 * Math.PI * i) / (nodes.length - 1);
                const radius = 14 + i * 6;
                nodes[i].position({
                    x: basePos.x + Math.cos(angle) * radius,
                    y: basePos.y + Math.sin(angle) * radius
                });
            }
        });
    });
}

/**
 * 应用折叠状态:对 collapsedNodeIds 后代节点和相关边添加 zk-collapsed-hidden class
 * 返回过滤后的有效 collapsedNodeIds(剔除已不在图中的节点)
 */
export function applyCollapsedState(cy: cytoscape.Core, collapsedNodeIds: Set<string>): Set<string> {
    const existingIds = new Set<string>();
    cy.nodes().forEach((node: cytoscape.NodeSingular) => {
        const id = node.data()?.originalNode?.IDStr;
        if (id) existingIds.add(id);
    });
    const filtered = new Set(Array.from(collapsedNodeIds).filter((id) => existingIds.has(id)));

    cy.nodes().removeClass('zk-collapsed-hidden');
    cy.edges().removeClass('zk-collapsed-hidden');

    const hiddenIds = new Set<string>();
    filtered.forEach((collapsedId) => {
        cy.nodes().forEach((node: cytoscape.NodeSingular) => {
            const id = node.data()?.originalNode?.IDStr;
            if (!id) return;
            if (id !== collapsedId && id.startsWith(`${collapsedId}.`)) {
                hiddenIds.add(id);
                node.addClass('zk-collapsed-hidden');
            }
        });
    });

    cy.edges().forEach((edge: cytoscape.EdgeSingular) => {
        const sourceId = edge.data()?.originalSource;
        const targetId = edge.data()?.originalTarget;
        if ((sourceId && hiddenIds.has(sourceId)) || (targetId && hiddenIds.has(targetId))) {
            edge.addClass('zk-collapsed-hidden');
        }
    });

    cy.nodes('[?isGroup]').forEach((groupNode: cytoscape.NodeSingular) => {
        const groupNodeIds: string[] = groupNode.data('nodeIds') || [];
        if (groupNodeIds.length === 0) return;

        const hasVisibleMember = groupNodeIds.some((nodeId) => !hiddenIds.has(nodeId));
        if (!hasVisibleMember) {
            groupNode.addClass('zk-collapsed-hidden');
        }
    });

    return filtered;
}

/**
 * 重新布局判定:变化超过 20% 节点时重布局
 */
export function shouldRelayout(changes: GraphChanges, currentNodeCount: number): boolean {
    const totalChanges = changes.addedNodes.length +
        changes.removedNodes.length +
        changes.addedEdges.length +
        changes.removedEdges.length;

    const changeRatio = totalChanges / Math.max(currentNodeCount, 1);
    return changeRatio > 0.2;
}

// ============ 向量/几何工具 ============

export function normalizeVector(vx: number, vy: number): { x: number; y: number } {
    const len = Math.hypot(vx, vy);
    if (len < 1e-6) return { x: 1, y: 0 };
    return { x: vx / len, y: vy / len };
}

export function getPerpendicular(dir: { x: number; y: number }): { x: number; y: number } {
    return { x: -dir.y, y: dir.x };
}

export function getAutoLayoutStackDirection(dir: { x: number; y: number }): { x: number; y: number } {
    if (Math.abs(dir.x) > 0.5) {
        return { x: 0, y: 1 };
    }
    return { x: 1, y: 0 };
}

export function nextOffsetByProjection(
    points: cytoscape.NodeSingular[],
    anchor: { x: number; y: number },
    normal: { x: number; y: number },
    gap: number
): number {
    const projections = points.map((n: cytoscape.NodeSingular) => {
        const p = n.position();
        return (p.x - anchor.x) * normal.x + (p.y - anchor.y) * normal.y;
    });

    if (projections.length === 0) return 0;

    let offset = Math.max(...projections) + gap;
    const isOccupied = (candidate: number) => projections.some(v => Math.abs(v - candidate) < gap * 0.8);
    while (isOccupied(offset)) {
        offset += gap;
    }
    return offset;
}

export function estimateCollisionBox(referenceNode: cytoscape.NodeSingular): { width: number; height: number } {
    const bb = typeof referenceNode.boundingBox === 'function'
        ? referenceNode.boundingBox({ includeLabels: false })
        : null;
    const width = Math.max(
        Number(referenceNode.outerWidth?.() || 0),
        Number(referenceNode.width?.() || 0),
        Number(bb?.w || 0),
        120
    );
    const height = Math.max(
        Number(referenceNode.outerHeight?.() || 0),
        Number(referenceNode.height?.() || 0),
        Number(bb?.h || 0),
        64
    );
    return {
        width: width + 36,
        height: height + 30
    };
}

export function getAxisSpan(size: { width: number; height: number }, dir: { x: number; y: number }): number {
    return Math.abs(dir.x) >= Math.abs(dir.y) ? size.width : size.height;
}

export function getDirectionalDistance(
    referenceNode: cytoscape.NodeSingular,
    dir: { x: number; y: number },
    extraGap = 48
): number {
    const referenceSize = estimateCollisionBox(referenceNode);
    const estimatedNewSize = referenceSize;
    const referenceSpan = getAxisSpan(referenceSize, dir);
    const newSpan = getAxisSpan(estimatedNewSize, dir);
    return referenceSpan / 2 + newSpan / 2 + extraGap;
}

// ============ 方向推断 ============

export function getBranchDirection(activeNode: cytoscape.NodeSingular): { x: number; y: number } {
    const nodePos = activeNode.position();
    const parent = activeNode.incomers('edge').sources();
    if (parent.length > 0) {
        const parentPos = parent.first().position();
        return normalizeVector(nodePos.x - parentPos.x, nodePos.y - parentPos.y);
    }

    const children = activeNode.outgoers('edge').targets();
    if (children.length === 0) return { x: 1, y: 0 };

    const cardinal = [
        { x: 1, y: 0 },
        { x: -1, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: -1 }
    ];
    const score = [0, 0, 0, 0];

    children.forEach((child: cytoscape.NodeSingular) => {
        const cp = child.position();
        const dir = normalizeVector(cp.x - nodePos.x, cp.y - nodePos.y);
        let bestIndex = 0;
        let bestDot = -Infinity;
        cardinal.forEach((c, idx) => {
            const dot = dir.x * c.x + dir.y * c.y;
            if (dot > bestDot) {
                bestDot = dot;
                bestIndex = idx;
            }
        });
        score[bestIndex] += 1;
    });

    let minIdx = 0;
    for (let i = 1; i < score.length; i++) {
        if (score[i] < score[minIdx]) minIdx = i;
    }
    return cardinal[minIdx];
}

export function getAutoLayoutDirection(node: cytoscape.NodeSingular): { x: number; y: number } {
    const lineage: cytoscape.NodeSingular[] = [node];
    let current = node;
    while (true) {
        const parents = current.incomers('edge').sources().filter((n: cytoscape.NodeSingular) => !n.data('isGroup'));
        if (!parents || parents.length === 0) break;
        current = parents.first() as cytoscape.NodeSingular;
        lineage.push(current);
    }

    const root = lineage[lineage.length - 1];
    if (root.id() === node.id()) {
        return { x: 1, y: 0 };
    }

    const branchAnchor = lineage.length >= 2 ? lineage[lineage.length - 2] : node;
    const rootPos = root.position();
    const anchorPos = branchAnchor.position();
    const dx = anchorPos.x - rootPos.x;
    const dy = anchorPos.y - rootPos.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
        return { x: dx >= 0 ? 1 : -1, y: 0 };
    }
    return { x: 0, y: dy >= 0 ? 1 : -1 };
}

// ============ 节点布局风格判定(基于 RenderOptions) ============

export function isAutoNodeLayoutStyle(options: RenderOptions | null): boolean {
    const style = options?.nodeLayoutStyle;
    if (typeof style !== 'string') return false;
    return style.trim().toLowerCase() === 'auto';
}

/**
 * 沿 ID 父链向上查找 nodeLayoutOverrides 覆盖;未命中则回退到文件级默认
 */
export function isNodeAutoLayoutForId(nodeId: string, options: RenderOptions | null): boolean {
    const overrides = options?.nodeLayoutOverrides || {};
    let current = nodeId;
    while (current.length > 0) {
        const override = overrides[current];
        if (override !== undefined) return override === 'auto';
        const parts: string[] = current.split('.');
        if (parts.length <= 1) break;
        current = parts.slice(0, -1).join('.');
    }
    return isAutoNodeLayoutStyle(options);
}

// ============ 碰撞检测 ============

export function isPositionColliding(
    cy: cytoscape.Core | null,
    candidate: { x: number; y: number },
    size: { width: number; height: number },
    excludeNodeIds: string[] = []
): boolean {
    if (!cy) return false;

    const marginX = 26;
    const marginY = 22;
    const candidateRect = {
        x1: candidate.x - size.width / 2 - marginX,
        x2: candidate.x + size.width / 2 + marginX,
        y1: candidate.y - size.height / 2 - marginY,
        y2: candidate.y + size.height / 2 + marginY
    };

    return cy.nodes('[!isGroup]').some((node: cytoscape.NodeSingular) => {
        if (node.removed() || !node.visible()) return false;
        if (node.hasClass('zk-collapsed-hidden')) return false;
        if (node.data('isPlaceholder')) return false;
        if (excludeNodeIds.includes(node.id())) return false;

        const pos = node.position();
        const otherWidth = Math.max(Number(node.width?.() || 0), 80);
        const otherHeight = Math.max(Number(node.height?.() || 0), 44);
        const otherRect = {
            x1: pos.x - otherWidth / 2 - marginX,
            x2: pos.x + otherWidth / 2 + marginX,
            y1: pos.y - otherHeight / 2 - marginY,
            y2: pos.y + otherHeight / 2 + marginY
        };

        const separated =
            candidateRect.x2 <= otherRect.x1 ||
            candidateRect.x1 >= otherRect.x2 ||
            candidateRect.y2 <= otherRect.y1 ||
            candidateRect.y1 >= otherRect.y2;

        return !separated;
    });
}

export function resolveShortcutPosition(
    cy: cytoscape.Core,
    basePosition: { x: number; y: number },
    referenceNode: cytoscape.NodeSingular,
    primaryAxis: { x: number; y: number },
    step: number,
    secondaryAxis?: { x: number; y: number },
    maxAttempts = 7
): { x: number; y: number } {
    const size = estimateCollisionBox(referenceNode);
    const excludeNodeIds = [referenceNode.id()];
    const tryCandidate = (candidate: { x: number; y: number }) =>
        !isPositionColliding(cy, candidate, size, excludeNodeIds);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let candidate = { ...basePosition };

        if (attempt > 0) {
            const ring = Math.ceil(attempt / 2);
            const sign = attempt % 2 === 1 ? 1 : -1;
            candidate = {
                x: basePosition.x + primaryAxis.x * step * ring * sign,
                y: basePosition.y + primaryAxis.y * step * ring * sign
            };

            if (secondaryAxis && attempt >= 3) {
                candidate.x += secondaryAxis.x * step * 0.35 * ring;
                candidate.y += secondaryAxis.y * step * 0.35 * ring;
            }
        }

        if (tryCandidate(candidate)) {
            return candidate;
        }
    }

    const secondary = secondaryAxis || { x: -primaryAxis.y, y: primaryAxis.x };
    for (let ring = 1; ring <= maxAttempts + 14; ring++) {
        const offsets = [
            { a: ring, b: 0 },
            { a: ring, b: 1 },
            { a: ring, b: -1 },
            { a: ring, b: 2 },
            { a: ring, b: -2 },
            { a: -ring, b: 0 },
            { a: -ring, b: 1 },
            { a: -ring, b: -1 }
        ];

        for (const offset of offsets) {
            const candidate = {
                x: basePosition.x + primaryAxis.x * step * offset.a + secondary.x * step * 0.7 * offset.b,
                y: basePosition.y + primaryAxis.y * step * offset.a + secondary.y * step * 0.7 * offset.b
            };
            if (tryCandidate(candidate)) {
                return candidate;
            }
        }
    }

    return {
        x: basePosition.x + primaryAxis.x * step * (maxAttempts + 16) + secondary.x * step * 1.4,
        y: basePosition.y + primaryAxis.y * step * (maxAttempts + 16) + secondary.y * step * 1.4
    };
}

// ============ Tab/Enter/Shift+Tab 快捷键创建子/兄弟/父节点的目标位置 ============

export function getFreeChildShortcutPosition(cy: cytoscape.Core, activeNode: cytoscape.NodeSingular): { x: number; y: number } {
    const nodePos = activeNode.position();
    const children = activeNode.outgoers('edge').targets();
    const dir = getBranchDirection(activeNode);
    const normal = getPerpendicular(dir);
    const directionalDistance = getDirectionalDistance(
        activeNode,
        dir,
        activeNode.data?.('isRoot') ? 120 : 64
    );
    const anchor = {
        x: nodePos.x + dir.x * directionalDistance,
        y: nodePos.y + dir.y * directionalDistance
    };
    const offset = nextOffsetByProjection(children.toArray(), anchor, normal, VERTICAL_GAP);
    const rawPosition = {
        x: anchor.x + normal.x * offset,
        y: anchor.y + normal.y * offset
    };
    return resolveShortcutPosition(
        cy,
        rawPosition,
        activeNode,
        normal,
        VERTICAL_GAP,
        dir
    );
}

export function getAutoChildShortcutPosition(activeNode: cytoscape.NodeSingular): { x: number; y: number } {
    const nodePos = activeNode.position();
    const children = activeNode.outgoers('edge').targets();
    const dir = getAutoLayoutDirection(activeNode);
    const normal = getAutoLayoutStackDirection(dir);

    if (children.length > 0) {
        let lastChild: cytoscape.NodeSingular | null = null;
        let maxProj = -Infinity;
        children.forEach((child: cytoscape.NodeSingular) => {
            const cp = child.position();
            const proj = (cp.x - nodePos.x) * normal.x + (cp.y - nodePos.y) * normal.y;
            if (proj > maxProj) {
                maxProj = proj;
                lastChild = child;
            }
        });
        const lastPos = lastChild!.position();
        return {
            x: lastPos.x + normal.x * SIBLING_GAP,
            y: lastPos.y + normal.y * SIBLING_GAP
        };
    }

    const directionalDistance = getDirectionalDistance(
        activeNode,
        dir,
        activeNode.data?.('isRoot') ? 120 : 72
    );
    const anchor = {
        x: nodePos.x + dir.x * directionalDistance,
        y: nodePos.y + dir.y * directionalDistance
    };
    const offset = nextOffsetByProjection(children.toArray(), anchor, normal, VERTICAL_GAP);
    return {
        x: anchor.x + normal.x * offset,
        y: anchor.y + normal.y * offset
    };
}

export function getFreeSiblingShortcutPosition(cy: cytoscape.Core, activeNode: cytoscape.NodeSingular): { x: number; y: number } {
    const nodePos = activeNode.position();
    const parent = activeNode.incomers('edge').sources();
    if (parent.length === 0) {
        const downDir = { x: 0, y: 1 };
        const directionalDistance = getDirectionalDistance(activeNode, downDir, 36);
        const basePosition = { x: nodePos.x, y: nodePos.y + directionalDistance };
        return resolveShortcutPosition(
            cy,
            basePosition,
            activeNode,
            downDir,
            directionalDistance,
            { x: 1, y: 0 },
            5
        );
    }

    const dir = getBranchDirection(activeNode);
    const normal = getPerpendicular(dir);
    const siblingGap = getDirectionalDistance(activeNode, normal, 28);

    const basePosition = {
        x: nodePos.x + normal.x * siblingGap,
        y: nodePos.y + normal.y * siblingGap
    };

    return resolveShortcutPosition(
        cy,
        basePosition,
        activeNode,
        normal,
        siblingGap,
        dir,
        5
    );
}

export function getAutoSiblingShortcutPosition(activeNode: cytoscape.NodeSingular): { x: number; y: number } {
    const nodePos = activeNode.position();
    const parent = activeNode.incomers('edge').sources();
    const parentPos = parent.first().position();
    const siblings = parent.first().outgoers('edge').targets();
    const dir = getAutoLayoutDirection(activeNode);
    const normal = getAutoLayoutStackDirection(dir);
    const siblingGap = Math.max(SIBLING_GAP, VERTICAL_GAP + 40);
    const anchor = {
        x: parentPos.x + dir.x * HORIZONTAL_GAP,
        y: parentPos.y + dir.y * HORIZONTAL_GAP
    };
    const activeProj = (nodePos.x - anchor.x) * normal.x + (nodePos.y - anchor.y) * normal.y;
    let offset = activeProj + siblingGap;

    const projections = siblings.map((sib: cytoscape.NodeSingular) => {
        const p = sib.position();
        return (p.x - anchor.x) * normal.x + (p.y - anchor.y) * normal.y;
    });
    const isOccupied = (candidate: number) => projections.some((v: number) => Math.abs(v - candidate) < siblingGap * 0.8);
    while (isOccupied(offset)) {
        offset += siblingGap;
    }

    return {
        x: anchor.x + normal.x * offset,
        y: anchor.y + normal.y * offset
    };
}

export function getFreeParentShortcutPosition(cy: cytoscape.Core, activeNode: cytoscape.NodeSingular): { x: number; y: number } {
    const nodePos = activeNode.position();
    const dir = getBranchDirection(activeNode);
    const directionalDistance = getDirectionalDistance(activeNode, dir);
    const rawPosition = {
        x: nodePos.x - dir.x * directionalDistance,
        y: nodePos.y - dir.y * directionalDistance
    };
    return resolveShortcutPosition(
        cy,
        rawPosition,
        activeNode,
        getPerpendicular(dir),
        VERTICAL_GAP,
        { x: -dir.x, y: -dir.y }
    );
}

export function getAutoParentShortcutPosition(activeNode: cytoscape.NodeSingular): { x: number; y: number } {
    const nodePos = activeNode.position();
    const dir = getBranchDirection(activeNode);
    return {
        x: nodePos.x - dir.x * HORIZONTAL_GAP,
        y: nodePos.y - dir.y * HORIZONTAL_GAP
    };
}
