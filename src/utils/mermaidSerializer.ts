import { MOCTreeNode, MOCParseResult, ReverseRelation, GroupInfo } from "./utils";

/**
 * Mermaid 格式序列化器
 * 负责将内部数据结构序列化为 Mermaid 格式
 */
export class MermaidSerializer {
    /**
     * 生成节点定义
     * @param node - 节点信息
     * @returns Mermaid 节点定义字符串
     */
    serializeNode(node: MOCTreeNode): string {
        // 转义特殊字符
        const escapedWikiLink = node.wikiLink.replace(/"/g, '\\"');

        // 纯文字节点：显示为纯文本（无 [[]]）
        if (node.isTextOnly) {
            return `${node.nodeID}["${escapedWikiLink}"]`;
        }

        // 文件节点：显示为 wiki link
        const displayText = node.displayText || node.wikiLink;
        const escapedDisplayText = displayText.replace(/"/g, '\\"');
        const linkPrefix = node.isEmbed ? '!' : '';

        // 显示文本和 wikiLink 不同时，使用 alias 语法：[[link|alias]]
        if (displayText !== node.wikiLink) {
            return `${node.nodeID}["${linkPrefix}[[${escapedWikiLink}|${escapedDisplayText}]]"]`;
        }

        return `${node.nodeID}["${linkPrefix}[[${escapedWikiLink}]]"]`;
    }

    /**
     * 生成边定义
     * @param source - 源节点 ID
     * @param target - 目标节点 ID
     * @param label - 边标签（可选）
     * @returns Mermaid 边定义字符串
     */
    serializeEdge(source: string, target: string, label?: string): string {
        if (label && label.trim() !== '') {
            // 有标签：source -->|label| target
            const escapedLabel = label.replace(/\|/g, '\\|');
            return `${source} -->|${escapedLabel}| ${target}`;
        } else {
            // 无标签：source --> target
            return `${source} --> ${target}`;
        }
    }

    /**
     * 生成分组定义
     * @param group - 分组信息
     * @param nodes - 所有节点的 Map
     * @returns Mermaid subgraph 字符串
     */
    serializeSubgraph(group: GroupInfo, nodesMap: Map<string, MOCTreeNode>): string {
        const lines: string[] = [];
        
        // subgraph 开始
        lines.push(`subgraph ${group.id} [${group.label}]`);
        lines.push('    direction TB');
        
        // 添加分组中的节点
        for (const nodeId of group.nodeIds) {
            const node = nodesMap.get(nodeId);
            if (node) {
                lines.push(`    ${this.serializeNode(node)}`);
            }
        }
        
        // subgraph 结束
        lines.push('end');
        
        return lines.join('\n');
    }

    /**
     * 生成元数据注释
     * @param data - MOC 解析结果
     * @returns 元数据注释字符串
     */
    serializeMetadata(data: MOCParseResult): string {
        const metadata: any = {
            node_positions: data.nodePositions || {},
            groups: data.groups || [],
            edge_curvatures: data.edgeCurvatures || {},
            node_colors: data.nodeColors || {},
            node_style_colors: (data as any).nodeStyleColors || {},
            cross_domain_links: data.crossDomainLinks || {}  // 始终包含 cross_domain_links，即使为空
        };

        const jsonStr = JSON.stringify(metadata);
        return `%% ext:${jsonStr} %%`;
    }

    /**
     * 序列化 MOC 数据为 Mermaid 格式
     * @param data - MOC 解析结果
     * @returns Mermaid 格式的字符串
     */
    serialize(data: MOCParseResult): string {
        const lines: string[] = [];

        // 添加 graph 声明
        lines.push('```mermaid');
        lines.push('graph LR');
        lines.push('');

        // 构建节点 Map
        const nodesMap = new Map<string, MOCTreeNode>();
        const allNodes: MOCTreeNode[] = [];
        
        const collectNodes = (nodes: MOCTreeNode[]) => {
            for (const node of nodes) {
                nodesMap.set(node.nodeID, node);
                allNodes.push(node);
                if (node.children && node.children.length > 0) {
                    collectNodes(node.children);
                }
            }
        };
        
        collectNodes(data.nodes);
        
        // 确定哪些节点在分组中
        const nodesInGroups = new Set<string>();
        for (const group of data.groups) {
            for (const nodeId of group.nodeIds) {
                nodesInGroups.add(nodeId);
            }
        }
        
        // 1. 定义根节点（不在分组中的根节点）
        lines.push('%% 1. 定义根节点 (在分组之外)');
        const rootNodes = allNodes.filter(n => {
            const idParts = n.nodeID.split('.');
            return idParts.length === 1 && !nodesInGroups.has(n.nodeID);
        });
        
        for (const node of rootNodes) {
            lines.push(this.serializeNode(node));
        }
        
        if (rootNodes.length > 0) {
            lines.push('');
        }
        
        // 2. 定义分组
        if (data.groups.length > 0) {
            lines.push('%% 2. 定义分组 (根据 JSON 中的 groups 数据)');
            for (const group of data.groups) {
                lines.push(this.serializeSubgraph(group, nodesMap));
                lines.push('');
            }
        }
        
        // 3. 定义其他节点（不在分组中的非根节点）
        lines.push('%% 3. 定义末端节点 (在分组之外)');
        const otherNodes = allNodes.filter(n => {
            const idParts = n.nodeID.split('.');
            return idParts.length > 1 && !nodesInGroups.has(n.nodeID);
        });
        
        if (otherNodes.length > 0) {
            for (const node of otherNodes) {
                lines.push(this.serializeNode(node));
            }
        }
        lines.push('');
        
        // 4. 定义连线关系
        lines.push('%% 4. 定义连线关系');

        // 构建父子关系边
        const edges: Array<{ source: string; target: string; label: string; comment: string }> = [];

        for (const node of allNodes) {
            const idParts = node.nodeID.split('.');

            if (idParts.length > 1) {
                // 有父节点
                const parentId = idParts.slice(0, -1).join('.');
                const parentNode = nodesMap.get(parentId);

                if (parentNode) {
                    // 检查：只有当节点真正在父节点的 children 中时，才创建父子边
                    const isReallyChild = parentNode.children &&
                                          parentNode.children.some((child: MOCTreeNode) => child.nodeID === node.nodeID);

                    if (isReallyChild) {
                        edges.push({
                            source: parentId,
                            target: node.nodeID,
                            label: node.relationText || '',
                            comment: `${parentId} 和 ${node.nodeID} 的父子关系`
                        });
                    }
                }
            }
        }

        // 添加反向关系边
        for (const [, relation] of data.reverseRelations) {
            // 检查这是否已经是父子边
            const targetIdParts = relation.targetID.split('.');
            const isParentChildEdge = targetIdParts.length > 1 &&
                                     targetIdParts.slice(0, -1).join('.') === relation.sourceID;

            if (!isParentChildEdge) {
                edges.push({
                    source: relation.sourceID,
                    target: relation.targetID,
                    label: relation.relationText,
                    comment: `${relation.sourceID} 到 ${relation.targetID} 的连接`
                });
            }
        }
        
        // 输出边
        for (const edge of edges) {
            if (edge.comment) {
                lines.push(`%% ${edge.comment}`);
            }
            lines.push(this.serializeEdge(edge.source, edge.target, edge.label));
        }
        
        if (edges.length > 0) {
            lines.push('');
        }
        
        // 5. 添加元数据
        lines.push(this.serializeMetadata(data));
        
        // 结束代码块
        lines.push('```');
        
        return lines.join('\n');
    }
}
