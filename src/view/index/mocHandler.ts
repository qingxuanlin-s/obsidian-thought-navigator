import { Notice, TFile } from "obsidian";
import ZKNavigationPlugin from "main";
import { MOCFileUtils } from "./mocUtils";

/**
 * MOC (Map of Content) 处理器
 * 负责处理所有与 MOC 文件相关的操作
 */
export class MOCHandler {
    constructor(private plugin: ZKNavigationPlugin, private app: any) {}

    /**
     * 在 MOC 文件中更新节点颜色
     */
    async updateNodeColorInMOC(mocFile: TFile, nodeID: string, color: string): Promise<void> {
        try {
            const content = await this.app.vault.read(mocFile);
            const lines = content.split('\n');
            const headingTitle = this.plugin.settings.mocHeadingTitle;

            // 使用工具类查找 MOC 区域
            const sectionRange = MOCFileUtils.findMOCSectionRange(lines, headingTitle);
            if (!sectionRange) {
                MOCFileUtils.showMOCError('未找到标题', headingTitle);
                return;
            }

            // 解析 ext 数据
            const { extData, extLineIndex } = MOCFileUtils.parseExtData(lines, sectionRange);

            // 初始化 node_colors 对象
            if (!extData.node_colors) {
                extData.node_colors = {};
            }

            // 设置或删除颜色
            if (color) {
                extData.node_colors[nodeID] = color;
            } else {
                delete extData.node_colors[nodeID];
            }

            // 使用工具类保存 ext 数据
            const updatedLines = MOCFileUtils.saveExtData(
                lines,
                extData,
                extLineIndex,
                sectionRange.sectionEndIndex
            );

            await this.app.vault.modify(mocFile, updatedLines.join('\n'));
        } catch (error) {
            console.error('Failed to update node color:', error);
            throw error;
        }
    }

    /**
     * 在 MOC 文件中更新节点 ID
     */
    async updateNodeIDInMOC(mocFile: TFile, oldID: string, newID: string): Promise<void> {
        try {
            const content = await this.app.vault.read(mocFile);
            const lines = content.split('\n');
            const headingTitle = this.plugin.settings.mocHeadingTitle;

            // 使用工具类查找 MOC 区域
            const sectionRange = MOCFileUtils.findMOCSectionRange(lines, headingTitle);
            if (!sectionRange) {
                MOCFileUtils.showMOCError('未找到标题', headingTitle);
                return;
            }

            // 更新节点行中的 ID
            const nodePattern = new RegExp(`${MOCFileUtils.escapeRegExp(oldID)}\\s*\\["(\\[\\[.*?\\]\\])"\\]`);
            let updated = false;

            for (let i = sectionRange.headingIndex + 1; i < sectionRange.sectionEndIndex; i++) {
                //更新节点
                if (nodePattern.test(lines[i])) {
                    lines[i] = lines[i].replace(nodePattern, `${newID} ["$1"]`);
                    updated = true;
                }

                //更新关系
                if (lines[i].includes(oldID) && lines[i].includes('-->')) {
                    lines[i] = lines[i].replace(new RegExp(MOCFileUtils.escapeRegExp(oldID), 'g'), newID);
                }
            }

            if (!updated) {
                new Notice(`未找到节点: ${oldID}`);
                return;
            }

            // 解析 ext 数据
            const { extData, extLineIndex } = MOCFileUtils.parseExtData(lines, sectionRange);

            // 更新节点位置
            if (extData.node_positions && extData.node_positions[oldID]) {
                extData.node_positions[newID] = extData.node_positions[oldID];
                delete extData.node_positions[oldID];
            }

            // 更新边弧度（需要更新包含该节点的所有边 key）
            if (extData.edge_curvatures) {
                const newCurvatures: Record<string, any> = {};
                Object.entries(extData.edge_curvatures).forEach(([key, value]) => {
                    const parts = key.split('-');
                    const newKey = parts.map(part => part === oldID ? newID : part).join('-');
                    newCurvatures[newKey] = value;
                });
                extData.edge_curvatures = newCurvatures;
            }

            // 使用工具类保存 ext 数据
            const updatedLines = MOCFileUtils.saveExtData(
                lines,
                extData,
                extLineIndex,
                sectionRange.sectionEndIndex
            );

            await this.app.vault.modify(mocFile, updatedLines.join('\n'));
        } catch (error) {
            console.error('Failed to update node ID:', error);
            throw error;
        }
    }

    /**
     * 从 MOC 文件中删除节点
     */
    async deleteNodeFromMOC(mocFile: TFile, nodeID: string): Promise<void> {
        try {
            const content = await this.app.vault.read(mocFile);
            const headingTitle = this.plugin.settings.mocHeadingTitle;

            // 检测是否是 Mermaid 格式
            const { MermaidParser } = await import('src/utils/mermaidParser');
            const mermaidParser = new MermaidParser(this.app);
            const mermaidBlock = mermaidParser.extractMermaidBlock(content);

            if (mermaidBlock) {
                await this.deleteNodeFromMOCMermaid(mocFile, nodeID);
                return;
            }

            const lines = content.split('\n');

            // 使用工具类查找 MOC 区域
            const sectionRange = MOCFileUtils.findMOCSectionRange(lines, headingTitle);
            if (!sectionRange) {
                MOCFileUtils.showMOCError('未找到标题', headingTitle);
                return;
            }

            // 查找并删除节点行
            const nodePattern = new RegExp(`\\[\\[.*?\\]\\]\\s*\`${nodeID}\``);
            let nodeLineIndex = -1;

            for (let i = sectionRange.headingIndex + 1; i < sectionRange.sectionEndIndex; i++) {
                if (nodePattern.test(lines[i])) {
                    nodeLineIndex = i;
                    break;
                }
            }

            if (nodeLineIndex === -1) {
                new Notice(`未找到节点: ${nodeID}`);
                return;
            }

            // 删除节点行
            let newLines = [
                ...lines.slice(0, nodeLineIndex),
                ...lines.slice(nodeLineIndex + 1)
            ];

            // 删除所有与该节点相关的箭头关系
            const arrowPattern1 = new RegExp(`\`${nodeID}\`\\s*--.*?-->`);
            const arrowPattern2 = new RegExp(`-->\\s*\`${nodeID}\``);

            newLines = newLines.filter((line, index) => {
                if (index < sectionRange.headingIndex || index >= sectionRange.sectionEndIndex - 1) return true;
                return !arrowPattern1.test(line) && !arrowPattern2.test(line);
            });

            // 从 ext 数据中删除节点位置
            const { extData, extLineIndex } = MOCFileUtils.parseExtData(newLines, sectionRange);

            if (extData.node_positions && extData.node_positions[nodeID]) {
                delete extData.node_positions[nodeID];
            }

            // 使用工具类保存 ext 数据
            const updatedLines = MOCFileUtils.saveExtData(
                newLines,
                extData,
                extLineIndex,
                sectionRange.sectionEndIndex
            );

            await this.app.vault.modify(mocFile, updatedLines.join('\n'));
        } catch (error) {
            console.error('Failed to delete node:', error);
            throw error;
        }
    }

    /**
     * 从 MOC 文件中删除节点（Mermaid 格式）
     */
    private async deleteNodeFromMOCMermaid(mocFile: TFile, nodeID: string): Promise<void> {
        try {
            const mocHeadingTitle = this.plugin.settings.mocHeadingTitle;
            const { parseMOCStructure, saveMOCStructure } = await import('src/utils/utils');
            const mocData = await parseMOCStructure(this.app, mocFile.path, mocHeadingTitle);

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
                new Notice(`未找到节点: ${nodeID}`);
                return;
            }

            if (mocData.nodePositions && mocData.nodePositions[nodeID]) {
                delete mocData.nodePositions[nodeID];
            }

            await saveMOCStructure(this.app, mocFile.path, mocHeadingTitle, mocData);
            new Notice(`已删除节点: ${nodeID}`);
        } catch (error) {
            console.error('Failed to delete node from MOC:', error);
            throw error;
        }
    }

    /**
     * 保存节点位置到 MOC 文件
     */
    async saveNodePositionToMOC(
        mocFile: TFile,
        nodeID: string,
        position: { x: number; y: number }
    ): Promise<void> {
        try {
            const content = await this.app.vault.read(mocFile);
            const lines = content.split('\n');
            const headingTitle = this.plugin.settings.mocHeadingTitle;

            const sectionRange = MOCFileUtils.findMOCSectionRange(lines, headingTitle);
            if (!sectionRange) {
                console.warn(`未找到标题: # ${headingTitle}`);
                return;
            }

            // 解析并更新 ext 数据
            const { extData, extLineIndex } = MOCFileUtils.parseExtData(lines, sectionRange);

            if (!extData.node_positions) {
                extData.node_positions = {};
            }

            extData.node_positions[nodeID] = position;

            // 使用工具类保存 ext 数据
            const updatedLines = MOCFileUtils.saveExtData(
                lines,
                extData,
                extLineIndex,
                sectionRange.sectionEndIndex
            );

            await this.app.vault.modify(mocFile, updatedLines.join('\n'));
        } catch (error) {
            console.error('Failed to save node position:', error);
            throw error;
        }
    }

    /**
     * 保存边弧度到 MOC 文件
     */
    async saveEdgeCurvatureToMOC(
        mocFile: TFile,
        edgeId: string,
        curvature: { distance: number; weight: number }
    ): Promise<void> {
        try {
            const content = await this.app.vault.read(mocFile);
            const lines = content.split('\n');
            const headingTitle = this.plugin.settings.mocHeadingTitle;

            const sectionRange = MOCFileUtils.findMOCSectionRange(lines, headingTitle);
            if (!sectionRange) {
                console.warn(`未找到标题: # ${headingTitle}`);
                return;
            }

            // 解析并更新 ext 数据
            const { extData, extLineIndex } = MOCFileUtils.parseExtData(lines, sectionRange);

            if (!extData.edge_curvatures) {
                extData.edge_curvatures = {};
            }

            extData.edge_curvatures[edgeId] = curvature;

            // 使用工具类保存 ext 数据
            const updatedLines = MOCFileUtils.saveExtData(
                lines,
                extData,
                extLineIndex,
                sectionRange.sectionEndIndex
            );

            await this.app.vault.modify(mocFile, updatedLines.join('\n'));
        } catch (error) {
            console.error('Failed to save edge curvature:', error);
            throw error;
        }
    }
}
