import { Notice, TFile } from "obsidian";
import ZKNavigationPlugin from "main";
import { MOCParseResult, CrossDomainLink, MOCTreeNode } from "src/utils/utils";

/**
 * 深拷贝 MOCTreeNode 树结构
 */
function deepCopyMOCTreeNode(node: MOCTreeNode): MOCTreeNode {
    return {
        wikiLink: node.wikiLink,
        nodeID: node.nodeID,
        displayText: node.displayText,
        depth: node.depth,
        children: node.children.map(child => deepCopyMOCTreeNode(child)),
        file: node.file,
        relationText: node.relationText,
        isArrowRelation: node.isArrowRelation,
        arrowSource: node.arrowSource,
        arrowTarget: node.arrowTarget
    };
}

/**
 * 深拷贝 MOCParseResult，避免修改缓存中的数据
 */
function deepCopyMOCResult(original: MOCParseResult): MOCParseResult {
    return {
        nodes: original.nodes.map(node => deepCopyMOCTreeNode(node)),
        reverseRelations: new Map(Array.from(original.reverseRelations.entries())),
        nodePositions: { ...original.nodePositions },
        groups: original.groups.map(g => ({ ...g, nodeIds: [...g.nodeIds] })),
        edgeCurvatures: { ...original.edgeCurvatures },
        nodeColors: { ...original.nodeColors },
        crossDomainLinks: original.crossDomainLinks ? JSON.parse(JSON.stringify(original.crossDomainLinks)) : {},
        metadata: { ...original.metadata }
    };
}

/**
 * MOC (Map of Content) 处理器
 * 负责处理所有与 MOC 文件相关的操作
 */
export class MOCHandler {
    constructor(private plugin: ZKNavigationPlugin, private app: any) {}

    /**
     * 通用 MOC 数据修改方法
     * 用于 Mermaid 格式的 MOC 文件，确保所有 metadata 被正确保留
     * @param mocFile - MOC 文件
     * @param modifyCallback - 修改数据的回调函数
     */
    async modifyMOCData(
        mocFile: TFile,
        modifyCallback: (data: MOCParseResult) => void | Promise<void>
    ): Promise<void> {
        const headingTitle = this.plugin.settings.mocHeadingTitle;

        // 使用 Mermaid 格式：通过 parse/modify/save 流程来保留所有 metadata
        const { parseMOCStructure, saveMOCStructure } = await import('src/utils/utils');
        const mocData = await parseMOCStructure(this.app, mocFile.path, headingTitle);

        // 深拷贝数据，避免修改缓存中的数据
        const mocDataCopy = deepCopyMOCResult(mocData);

        // 调用修改回调（操作的是拷贝，不影响缓存）
        await modifyCallback(mocDataCopy);

        // 保存更新后的数据（这会保留 crossDomainLinks 等所有 metadata）
        await saveMOCStructure(this.app, mocFile.path, headingTitle, mocDataCopy);
    }

    /**
     * 在 MOC 文件中更新节点颜色
     */
    async updateNodeColorInMOC(mocFile: TFile, nodeID: string, color: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            // 初始化 nodeColors 对象
            if (!mocData.nodeColors) {
                mocData.nodeColors = {};
            }

            // 设置或删除颜色
            if (color) {
                mocData.nodeColors[nodeID] = color;
            } else {
                delete mocData.nodeColors[nodeID];
            }
        });
    }

    /**
     * 在 MOC 文件中更新节点 ID
     */
    async updateNodeIDInMOC(mocFile: TFile, oldID: string, newID: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            // 更新节点树中的 ID
            const updateNodeIDInTree = (nodes: any[], oldID: string, newID: string): boolean => {
                for (const node of nodes) {
                    if (node.nodeID === oldID) {
                        node.nodeID = newID;
                        return true;
                    }
                    if (node.children && node.children.length > 0) {
                        if (updateNodeIDInTree(node.children, oldID, newID)) {
                            return true;
                        }
                    }
                }
                return false;
            };

            const updated = updateNodeIDInTree(mocData.nodes, oldID, newID);

            if (!updated) {
                throw new Error(`未找到节点: ${oldID}`);
            }

            // 更新 reverseRelations 中的节点 ID
            const newReverseRelations = new Map();
            for (const [, relation] of mocData.reverseRelations) {
                const newSourceID = relation.sourceID === oldID ? newID : relation.sourceID;
                const newTargetID = relation.targetID === oldID ? newID : relation.targetID;
                const newKey = `${newSourceID}->${newTargetID}`;
                newReverseRelations.set(newKey, {
                    sourceID: newSourceID,
                    targetID: newTargetID,
                    relationText: relation.relationText
                });
            }
            mocData.reverseRelations = newReverseRelations;

            // 更新节点位置
            if (mocData.nodePositions && mocData.nodePositions[oldID]) {
                mocData.nodePositions[newID] = mocData.nodePositions[oldID];
                delete mocData.nodePositions[oldID];
            }

            // 更新边弧度（需要更新包含该节点的所有边 key）
            if (mocData.edgeCurvatures) {
                const newCurvatures: Record<string, any> = {};
                Object.entries(mocData.edgeCurvatures).forEach(([key, value]) => {
                    const parts = key.split('-');
                    const newKey = parts.map(part => part === oldID ? newID : part).join('-');
                    newCurvatures[newKey] = value;
                });
                mocData.edgeCurvatures = newCurvatures;
            }

            // 更新节点颜色
            if (mocData.nodeColors && mocData.nodeColors[oldID]) {
                mocData.nodeColors[newID] = mocData.nodeColors[oldID];
                delete mocData.nodeColors[oldID];
            }

            // 更新跨领域链接中的节点 ID（如果 oldID 是 sourceNodeId）
            if (mocData.crossDomainLinks && mocData.crossDomainLinks[oldID]) {
                mocData.crossDomainLinks[newID] = mocData.crossDomainLinks[oldID];
                delete mocData.crossDomainLinks[oldID];
            }
        });
    }

    /**
     * 从 MOC 文件中删除节点
     */
    async deleteNodeFromMOC(mocFile: TFile, nodeID: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            let deleted = false;

            // 1. 先尝试在节点树中查找并删除
            const deleteNodeFromTree = (nodes: any[], targetID: string): boolean => {
                for (let i = 0; i < nodes.length; i++) {
                    const node = nodes[i];
                    if (node.nodeID === targetID) {
                        nodes.splice(i, 1);
                        return true;
                    }
                    if (node.children && node.children.length > 0) {
                        if (deleteNodeFromTree(node.children, targetID)) {
                            return true;
                        }
                    }
                }
                return false;
            };

            deleted = deleteNodeFromTree(mocData.nodes, nodeID);

            // 2. 如果在节点树中没找到，尝试从跨领域链接中删除
            if (!deleted && mocData.crossDomainLinks) {
                // 检查是否为跨思维树节点 ID（格式：cd-{nodeId}-{mocName}）
                const isCrossDomainNode = nodeID.startsWith('cd-');

                for (const sourceNodeId in mocData.crossDomainLinks) {
                    const links = mocData.crossDomainLinks[sourceNodeId];
                    const initialLength = links.length;

                    // 过滤掉匹配的跨领域节点（匹配 nodeId 或完整 ID）
                    mocData.crossDomainLinks[sourceNodeId] = links.filter(
                        (link: CrossDomainLink) => {
                            // 检查是否匹配
                            if (link.nodeId === nodeID) {
                                return false;  // 删除这个链接
                            }
                            // 如果是跨思维树节点，尝试提取原始 nodeId 并匹配
                            if (isCrossDomainNode) {
                                // cd-a-测试 -> a-测试
                                const originalNodeId = nodeID.substring(3);
                                if (link.nodeId === originalNodeId) {
                                    return false;  // 删除这个链接
                                }
                            }
                            return true;
                        }
                    );

                    // 如果删除了链接，说明找到了
                    if (mocData.crossDomainLinks[sourceNodeId].length < initialLength) {
                        deleted = true;

                        // 如果该源节点的所有跨领域链接都被删除了，删除这个键
                        if (mocData.crossDomainLinks[sourceNodeId].length === 0) {
                            delete mocData.crossDomainLinks[sourceNodeId];
                        }

                        break;
                    }
                }
            }

            if (!deleted) {
                throw new Error(`未找到节点: ${nodeID}`);
            }

            // 清理相关数据
            if (mocData.nodePositions && mocData.nodePositions[nodeID]) {
                delete mocData.nodePositions[nodeID];
            }

            if (mocData.nodeColors && mocData.nodeColors[nodeID]) {
                delete mocData.nodeColors[nodeID];
            }

            // 清理包含该节点的边弧度
            if (mocData.edgeCurvatures) {
                Object.keys(mocData.edgeCurvatures).forEach(key => {
                    const parts = key.split('-');
                    if (parts.includes(nodeID)) {
                        delete mocData.edgeCurvatures[key];
                    }
                });
            }
        });

        new Notice(`已删除节点: ${nodeID}`);
    }

    /**
     * 从 MOC 文件中删除跨思维树节点
     */
    async deleteCrossDomainNodeFromMOC(mocFile: TFile, nodeID: string, crossDomainLinkInfo: any): Promise<void> {
        console.log(`[deleteCrossDomainNodeFromMOC] 正在删除文件: ${mocFile.path}`);

        await this.modifyMOCData(mocFile, (mocData) => {
            console.log(`[deleteCrossDomainNodeFromMOC] 文件: ${mocFile.path}`);
            console.log('[deleteCrossDomainNodeFromMOC] 删除前 crossDomainLinks:', JSON.stringify(mocData.crossDomainLinks, null, 2));

            if (!mocData.crossDomainLinks) {
                throw new Error(`未找到跨领域链接数据`);
            }

            // 从 crossDomainLinkInfo 中获取 sourceNodeId 和原始的 link.nodeId
            const sourceNodeId = crossDomainLinkInfo.sourceNodeId;
            const originalNodeId = crossDomainLinkInfo.nodeId;

            console.log(`[deleteCrossDomainNodeFromMOC] 删除: sourceNodeId=${sourceNodeId}, originalNodeId=${originalNodeId}, nodeID=${nodeID}`);

            if (!sourceNodeId || !mocData.crossDomainLinks[sourceNodeId]) {
                throw new Error(`未找到跨领域链接: sourceNodeId=${sourceNodeId}`);
            }

            const links = mocData.crossDomainLinks[sourceNodeId];
            const initialLength = links.length;

            // 根据 nodeId 过滤删除对应的链接
            mocData.crossDomainLinks[sourceNodeId] = links.filter(
                (link: CrossDomainLink) => link.nodeId !== originalNodeId
            );

            // 如果删除了链接
            if (mocData.crossDomainLinks[sourceNodeId].length < initialLength) {
                // 如果该源节点的所有跨领域链接都被删除了，删除这个键
                if (mocData.crossDomainLinks[sourceNodeId].length === 0) {
                    delete mocData.crossDomainLinks[sourceNodeId];
                }

                // 清理节点位置
                if (mocData.nodePositions && mocData.nodePositions[nodeID]) {
                    delete mocData.nodePositions[nodeID];
                }

                // 清理节点颜色
                if (mocData.nodeColors && mocData.nodeColors[nodeID]) {
                    delete mocData.nodeColors[nodeID];
                }

                // 清理边弧度
                if (mocData.edgeCurvatures) {
                    Object.keys(mocData.edgeCurvatures).forEach(key => {
                        const parts = key.split('-');
                        if (parts.includes(nodeID)) {
                            delete mocData.edgeCurvatures[key];
                        }
                    });
                }

                console.log('[deleteCrossDomainNodeFromMOC] 删除后 crossDomainLinks:', JSON.stringify(mocData.crossDomainLinks, null, 2));
            } else {
                throw new Error(`未找到跨领域节点链接: ${originalNodeId}`);
            }
        });

        new Notice(`已删除跨思维树节点: ${nodeID}`);
    }

    /**
     * 保存节点位置到 MOC 文件
     */
    async saveNodePositionToMOC(
        mocFile: TFile,
        nodeID: string,
        position: { x: number; y: number }
    ): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            if (!mocData.nodePositions) {
                mocData.nodePositions = {};
            }

            mocData.nodePositions[nodeID] = position;
        });
    }

    /**
     * 保存边弧度到 MOC 文件
     */
    async saveEdgeCurvatureToMOC(
        mocFile: TFile,
        edgeId: string,
        curvature: { distance: number; weight: number }
    ): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            if (!mocData.edgeCurvatures) {
                mocData.edgeCurvatures = {};
            }

            mocData.edgeCurvatures[edgeId] = curvature;
        });
    }

    /**
     * 批量创建分组
     * @param mocFile - MOC 文件
     * @param nodeIds - 要包含在分组中的节点 ID 列表
     * @param groupName - 分组名称
     */
    async createGroupInMOC(
        mocFile: TFile,
        nodeIds: string[],
        groupName: string
    ): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            // 初始化 groups 数组
            if (!mocData.groups) {
                mocData.groups = [];
            }

            // 生成唯一的分组 ID
            const groupId = `group_${Date.now()}`;

            // 创建分组，包含所有指定的节点
            const newGroup: any = {
                id: groupId,
                label: groupName,
                nodeIds: nodeIds
            };

            // 添加到分组列表
            mocData.groups.push(newGroup);
        });
    }
}
