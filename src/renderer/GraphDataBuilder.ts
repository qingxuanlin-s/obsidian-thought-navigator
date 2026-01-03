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
     * 这个方法复制了原来 Mermaid 的边构建逻辑
     */
    buildMOCTreeEdges(reverseRelations: Map<string, any>): this {
        const nodeMap = new Map<string, ZKNode>();
        this.nodes.forEach(node => nodeMap.set(node.IDStr, node));

        // 构建 reverseRelationsMap（按 sourceID 和 targetID 索引）
        const reverseRelationsMap = new Map<string, any[]>();
        
        for (const [_, relation] of reverseRelations) {
            // 将关系添加到 sourceID 下
            if (reverseRelationsMap.has(relation.sourceID)) {
                reverseRelationsMap.get(relation.sourceID)!.push(relation);
            } else {
                reverseRelationsMap.set(relation.sourceID, [relation]);
            }
            
            // 将关系添加到 targetID 下
            if (reverseRelationsMap.has(relation.targetID)) {
                reverseRelationsMap.get(relation.targetID)!.push(relation);
            } else {
                reverseRelationsMap.set(relation.targetID, [relation]);
            }
        }

        // 添加父子关系连线（根据 IDArr 确定父子关系）
        for (const node of this.nodes) {
            // 跳过根节点（没有父节点）
            if (node.isRoot) {
                console.log(`[buildMOCTreeEdges] Skipping root node: ${node.IDStr}`);
                continue;
            }
            
            if (node.IDArr.length > 1) {
                const parentID = node.IDArr.at(-2);
                const parentNode = this.nodes.find(n => n.IDStr === parentID);
                
                if (parentNode) {
                    // 如果存在 relationText 就使用它
                    if (node.relationText) {
                        this.edges.push({
                            id: `edge-parent-${parentNode.ID}-${node.ID}`,
                            source: parentNode.ID,
                            target: node.ID,
                            type: 'parent',
                            label: node.relationText
                        });
                    } else {
                        // 检查是否有反向关系覆盖了这条边
                        const nodeRel = reverseRelationsMap.get(node.IDStr)?.find(n => {
                            return ((n.targetID === node.IDStr && n.sourceID === parentID) || 
                                    (n.targetID === parentID && n.sourceID === node.IDStr))
                        });
                        
                        // 如果没有反向关系，添加默认的父子边
                        if (!nodeRel) {
                            this.edges.push({
                                id: `edge-parent-${parentNode.ID}-${node.ID}`,
                                source: parentNode.ID,
                                target: node.ID,
                                type: 'parent',
                                label: ''
                            });
                        }
                    }
                }
            }
        }
        
        console.log(`[buildMOCTreeEdges] Total nodes: ${this.nodes.length}, Total edges: ${this.edges.length}`);
        console.log(`[buildMOCTreeEdges] Root nodes:`, this.nodes.filter(n => n.isRoot).map(n => n.IDStr));

        // 添加反向关系连线（箭头关系）
        // 所有箭头关系都使用虚线，方向按照 MOC 文件中定义的方向（source -> target）
        for (const relNode of reverseRelations.values()) { 
            const sourceNode = nodeMap.get(relNode.sourceID);
            if (sourceNode === undefined) continue;

            const targetNode = nodeMap.get(relNode.targetID);
            if (targetNode) {
                // 箭头关系：从 source 指向 target，使用虚线
                this.edges.push({
                    id: `edge-arrow-${sourceNode.ID}-${targetNode.ID}`,
                    source: sourceNode.ID,
                    target: targetNode.ID,
                    type: 'reverse',  // 使用虚线样式
                    label: relNode.relationText
                });
            }              
        }

        return this;
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
