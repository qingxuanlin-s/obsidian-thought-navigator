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
     * 从家族节点构建边（父子关系）
     */
    buildFamilyEdges(): this {
        const nodeMap = new Map<string, ZKNode>();
        this.nodes.forEach(node => nodeMap.set(node.ID, node));

        this.nodes.forEach(node => {
            // 构建父子关系边
            if (node.IDArr.length > 1) {
                const parentIDArr = node.IDArr.slice(0, -1);
                const parentIDStr = parentIDArr.toString();
                
                // 查找父节点
                const parent = Array.from(nodeMap.values()).find(n => n.IDStr === parentIDStr);
                
                if (parent) {
                    this.edges.push({
                        id: `edge-${parent.ID}-${node.ID}`,
                        source: parent.ID,
                        target: node.ID,
                        type: 'parent',
                        label: node.relationText || ''
                    });
                }
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
    buildMOCTreeEdges(reverseRelations: Map<string, any>): this {
        const nodeMap = new Map<string, ZKNode>();
        this.nodes.forEach(node => nodeMap.set(node.IDStr, node));

        // 只根据 reverseRelations（Mermaid 文件中的箭头）来生成边
        for (const relNode of reverseRelations.values()) { 
            const sourceNode = nodeMap.get(relNode.sourceID);
            if (sourceNode === undefined) continue;

            const targetNode = nodeMap.get(relNode.targetID);
            if (targetNode) {
                // 判断是否是父子关系：检查 target 的父节点 ID 是否等于 source 的 ID
                const isParentChild = this.isParentChildRelation(relNode.sourceID, relNode.targetID);
                
                // 如果是父子关系，使用实线；否则使用虚线
                const edgeType = isParentChild ? 'parent' : 'reverse';
                
                this.edges.push({
                    id: `edge-${sourceNode.ID}-${targetNode.ID}`,
                    source: sourceNode.ID,
                    target: targetNode.ID,
                    type: edgeType,
                    label: relNode.relationText || ''
                });
            }              
        }

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
        const currentNode = this.nodes.find(n => n.file.path === currentFile.path);
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
     * 静态工厂方法：从 MOC 树节点创建（包含 reverseRelations、groups、edgeCurvatures 和 nodeColors）
     */
    static fromMOCTree(
        nodes: ZKNode[], 
        reverseRelations: Map<string, any>, 
        currentFile: TFile | null, 
        groups: any[] = [], 
        edgeCurvatures: Record<string, { distance: number; weight: number }> = {},
        nodeColors: Record<string, string> = {}
    ): GraphData {
        const graphData = new GraphDataBuilder()
            .addNodes(nodes)
            .buildMOCTreeEdges(reverseRelations)
            .setMetadata({
                currentFile: currentFile?.path || '',
                renderType: 'moc-tree',
                groups: groups,  // 添加分组信息到元数据
                edgeCurvatures: edgeCurvatures,  // 添加边弧度信息到元数据
                nodeColors: nodeColors  // 添加节点颜色信息到元数据
            })
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
