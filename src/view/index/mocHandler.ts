import { Notice, TFile } from "obsidian";
import ZKNavigationPlugin from "main";
import { MOCParseResult } from "src/utils/utils";

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

        // 调用修改回调
        await modifyCallback(mocData);

        // 保存更新后的数据（这会保留 crossDomainLinks 等所有 metadata）
        await saveMOCStructure(this.app, mocFile.path, headingTitle, mocData);
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
            // 递归查找并删除节点
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

            const deleted = deleteNodeFromTree(mocData.nodes, nodeID);

            if (!deleted) {
                throw new Error(`未找到节点: ${nodeID}`);
            }

            if (mocData.nodePositions && mocData.nodePositions[nodeID]) {
                delete mocData.nodePositions[nodeID];
            }

            if (mocData.nodeColors && mocData.nodeColors[nodeID]) {
                delete mocData.nodeColors[nodeID];
            }
        });

        new Notice(`已删除节点: ${nodeID}`);
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
}
