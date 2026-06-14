import { TFile } from "obsidian";
import { ZKNode } from "src/view/indexView";
import { GraphData, Edge, GraphMetadata } from "./types";

/**
 * 图形数据构建器
 * 帮助从现有数据结构构建 GraphData
 */
export class GraphDataBuilder {
    private nodes: ZKNode[] = [];
    private edges: Edge[] = [];
    private metadata: Partial<GraphMetadata> = {};

    /**
     * 添加节点
     */
    addNodes(nodes: ZKNode[]): this {
        this.nodes.push(...nodes);
        return this;
    }

    /**
     * 推断父节点 ID（兼容不同 ID 编码方式）
     * - MOC 树：优先使用 IDStr 的点号层级（如 a.1.b -> a.1）
     * - 旧数据：回退到 IDArr 前缀（逗号拼接）
     */
    private getParentId(node: ZKNode): string | null {
        if (node.IDStr && node.IDStr.includes('.')) {
            const parentByDot = node.IDStr.split('.').slice(0, -1).join('.');
            if (parentByDot) return parentByDot;
        }

        if (node.IDArr && node.IDArr.length > 1) {
            const parentByArr = node.IDArr.slice(0, -1).toString();
            if (parentByArr) return parentByArr;
        }

        return null;
    }

    /**
     * 从家族节点构建边（父子关系）
     */
    buildFamilyEdges(): this {
        const nodeMap = new Map<string, ZKNode>();
        this.nodes.forEach(node => {
            nodeMap.set(node.ID, node);
            if (node.IDStr) nodeMap.set(node.IDStr, node);
        });

        this.nodes.forEach(node => {
            // 构建父子关系边
            const parentID = this.getParentId(node);
            if (!parentID) return;

            // O(1) 查找父节点（支持 ID 和 IDStr）
            const parent = nodeMap.get(parentID);

            if (parent) {
                this.edges.push({
                    id: `edge-${parent.ID}-${node.ID}`,
                    source: parent.ID,
                    target: node.ID,
                    type: 'parent',
                    label: node.relationText || ''
                });
            }
        });

        return this;
    }

    /**
     * 从 MOC 树节点构建边（包含 reverseRelations）
     * 只根据 Mermaid 文件中的箭头关系来生成边
     * - 如果箭头是父->子关系，使用实线（type: 'parent'）
     * - 其他情况使用虚线（type: 'reverse'）
     */
    buildMOCTreeEdges(reverseRelations: Map<string, any>, groups: any[] = []): this {
        const nodeMap = new Map<string, ZKNode>();
        this.nodes.forEach(node => {
            nodeMap.set(node.IDStr, node);
            if (node.ID) nodeMap.set(node.ID, node);
        });
        const groupIdSet = new Set<string>((groups || []).map((group: any) => String(group.id || '').trim()).filter(Boolean));
        const edgeKeySet = new Set<string>();

        // 只根据 reverseRelations（Mermaid 文件中的箭头）来生成边
        for (const relNode of reverseRelations.values()) {
            const sourceId = String(relNode.sourceID || '').trim();
            const targetId = String(relNode.targetID || '').trim();
            if (!sourceId || !targetId) {
                continue;
            }

            const sourceNode = nodeMap.get(sourceId) || (groupIdSet.has(sourceId) ? ({ ID: sourceId, IDStr: sourceId } as ZKNode) : undefined);
            const targetNode = nodeMap.get(targetId) || (groupIdSet.has(targetId) ? ({ ID: targetId, IDStr: targetId } as ZKNode) : undefined);
            if (sourceNode && targetNode) {
                // 判断是否是父子关系：仅在普通节点之间生效
                const isParentChild = nodeMap.has(sourceId) && nodeMap.has(targetId)
                    ? this.isParentChildRelation(sourceId, targetId)
                    : false;

                // 如果是父子关系，使用实线；否则使用虚线
                const edgeType = isParentChild ? 'parent' : 'reverse';

                this.edges.push({
                    id: `edge-${sourceNode.ID}-${targetNode.ID}`,
                    source: sourceNode.ID,
                    target: targetNode.ID,
                    type: edgeType,
                    label: relNode.relationText || ''
                });
                edgeKeySet.add(`${sourceNode.ID}->${targetNode.ID}`);
            }
        }

        // 兜底：补充层级父子边，避免 reverseRelations 为空/不完整时图上无连线
        this.nodes.forEach(node => {
            const parentID = this.getParentId(node);
            if (!parentID) return;

            const parentNode = nodeMap.get(parentID);
            if (!parentNode) return;

            const key = `${parentNode.ID}->${node.ID}`;
            if (edgeKeySet.has(key)) return;

            this.edges.push({
                id: `edge-${parentNode.ID}-${node.ID}`,
                source: parentNode.ID,
                target: node.ID,
                type: 'parent',
                label: node.relationText || ''
            });
            edgeKeySet.add(key);
        });

        return this;
    }

    /**
     * 判断两个节点 ID 是否是父子关系
     * @param sourceID 源节点 ID（如 "a"）
     * @param targetID 目标节点 ID（如 "a.1"）
     * @returns 如果 target 是 source 的直接子节点，返回 true
     */
    private isParentChildRelation(sourceID: string, targetID: string): boolean {
        // 将 ID 按点号分割
        const targetParts = targetID.split('.');
        
        // 如果 target 只有一级（如 "a"），不可能是子节点
        if (targetParts.length <= 1) {
            return false;
        }
        
        // 获取 target 的父节点 ID（去掉最后一部分）
        const targetParentID = targetParts.slice(0, -1).join('.');
        
        // 如果 target 的父节点 ID 等于 source ID，则是父子关系
        return targetParentID === sourceID;
    }

    /**
     * 构建入链和出链的边
     */
    buildInOutLinksEdges(currentFile: TFile, inlinks: TFile[], outlinks: TFile[]): this {
        // 创建当前文件节点（如果不存在）
        const currentNode = this.nodes.find(n => n.file?.path === currentFile.path);
        if (!currentNode) {
            // 添加当前文件作为中心节点
            const centerNode: ZKNode = {
                ID: 'current',
                IDArr: ['current'],
                IDStr: 'current',
                position: 0,
                file: currentFile,
                title: currentFile.basename,
                displayText: currentFile.basename,
                relationText: '',
                ctime: currentFile.stat.ctime,
                randomId: Math.random().toString(36),
                nodeSons: 0,
                startY: 0,
                height: 0,
                isRoot: true,
                fixWidth: 0,
                branchName: '',
                gitNodePos: 0
            };
            this.nodes.push(centerNode);
        }

        // 添加入链节点和边
        inlinks.forEach((file, index) => {
            const nodeId = `inlink-${index}`;
            const node: ZKNode = {
                ID: nodeId,
                IDArr: [nodeId],
                IDStr: nodeId,
                position: index + 1,
                file: file,
                title: file.basename,
                displayText: file.basename,
                relationText: '',
                ctime: file.stat.ctime,
                randomId: Math.random().toString(36),
                nodeSons: 0,
                startY: 0,
                height: 0,
                isRoot: false,
                fixWidth: 0,
                branchName: '',
                gitNodePos: 0
            };
            this.nodes.push(node);

            // 入链指向当前文件
            this.edges.push({
                id: `edge-inlink-${index}`,
                source: nodeId,
                target: currentNode?.ID || 'current',
                type: 'inlink'
            });
        });

        // 添加出链节点和边
        outlinks.forEach((file, index) => {
            const nodeId = `outlink-${index}`;
            const node: ZKNode = {
                ID: nodeId,
                IDArr: [nodeId],
                IDStr: nodeId,
                position: inlinks.length + index + 2,
                file: file,
                title: file.basename,
                displayText: file.basename,
                relationText: '',
                ctime: file.stat.ctime,
                randomId: Math.random().toString(36),
                nodeSons: 0,
                startY: 0,
                height: 0,
                isRoot: false,
                fixWidth: 0,
                branchName: '',
                gitNodePos: 0
            };
            this.nodes.push(node);

            // 当前文件指向出链
            this.edges.push({
                id: `edge-outlink-${index}`,
                source: currentNode?.ID || 'current',
                target: nodeId,
                type: 'outlink'
            });
        });

        return this;
    }

    /**
     * 跨领域关联不再物化为画布上的虚拟节点 + 虚线边。
     * 新设计:链接列表通过 metadata.crossDomainLinks(已由 setMetadata 写入)直接挂在
     * 源节点上,由 badge 层渲染成源节点右下角的「出口角标」(↗),hover 展开链接列表、点击跳转。
     * 见 renderPipeline.convertNodesToElements(写入 node.data.crossDomainLinks)与 nodeBadges。
     */
    buildCrossDomainEdges(_crossDomainLinks: Record<string, any[]>): this {
        return this;
    }

    /**
     * 设置元数据
     */
    setMetadata(metadata: Partial<GraphMetadata>): this {
        this.metadata = { ...this.metadata, ...metadata };
        return this;
    }

    /**
     * 构建 GraphData
     */
    build(): GraphData {
        return {
            nodes: this.nodes,
            edges: this.edges,
            metadata: {
                currentFile: this.metadata.currentFile || '',
                timestamp: this.metadata.timestamp || Date.now(),
                hash: this.metadata.hash || this.computeHash(),
                renderType: this.metadata.renderType || 'family',
                ...this.metadata  // 保留所有其他 metadata 字段（如 groups）
            }
        };
    }

    /**
     * 计算数据哈希
     */
    private computeHash(): string {
        const data = {
            nodes: this.nodes.map(n => ({ id: n.ID, text: n.displayText })),
            edges: this.edges.map(e => ({ source: e.source, target: e.target }))
        };
        return JSON.stringify(data);
    }

    /**
     * 静态工厂方法：从家族节点创建
     */
    static fromFamilyNodes(nodes: ZKNode[], currentFile: TFile | null): GraphData {
        return new GraphDataBuilder()
            .addNodes(nodes)
            .buildFamilyEdges()
            .setMetadata({
                currentFile: currentFile?.path || '',
                renderType: 'family'
            })
            .build();
    }

    /**
     * 静态工厂方法：从 MOC 树节点创建（包含 reverseRelations、groups、edgeCurvatures 和颜色信息）
     */
    static fromMOCTree(
        nodes: ZKNode[],
        reverseRelations: Map<string, any>,
        currentFile: TFile | null,
        groups: any[] = [],
        edgeCurvatures: Record<string, { distance: number; weight: number }> = {},
        nodeColors: Record<string, string> = {},
        nodeStyleColors: Record<string, string> = {},
        crossDomainLinks: Record<string, any[]> = {},
        nodePositions: Record<string, { x: number; y: number }> = {},
        embedNodeSizes: Record<string, { width: number; height: number }> = {},
        nodeRemarks: Record<string, string> = {},
        nodeAnchors: Record<string, boolean> = {},
        collapsedNodeIds: string[] = []
    ): GraphData {
        const graphData = new GraphDataBuilder()
            .addNodes(nodes)
            .buildMOCTreeEdges(reverseRelations, groups)
            // 先设置元数据（包含 nodePositions），这样 buildCrossDomainEdges 才能访问
            .setMetadata({
                currentFile: currentFile?.path || '',
                renderType: 'moc-tree',
                groups: groups,
                edgeCurvatures: edgeCurvatures,
                nodeColors: nodeColors,
                nodeStyleColors: nodeStyleColors,
                crossDomainLinks: crossDomainLinks,
                nodePositions: nodePositions,
                embedNodeSizes: embedNodeSizes,
                nodeRemarks: nodeRemarks,
                nodeAnchors: nodeAnchors,
                collapsedNodeIds: collapsedNodeIds
            })
            .buildCrossDomainEdges(crossDomainLinks)
            .build();

        return graphData;
    }

    /**
     * 静态工厂方法：从入链和出链创建
     */
    static fromInOutLinks(currentFile: TFile, inlinks: TFile[], outlinks: TFile[]): GraphData {
        return new GraphDataBuilder()
            .buildInOutLinksEdges(currentFile, inlinks, outlinks)
            .setMetadata({
                currentFile: currentFile.path,
                renderType: 'inoutlinks'
            })
            .build();
    }
}
