import { TFile } from "obsidian";
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
        arrowTarget: node.arrowTarget,
        isTextOnly: node.isTextOnly || false,  // 保留纯文字节点标记
        isEmbed: node.isEmbed || false
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
        nodeStyleColors: { ...(original as any).nodeStyleColors || {} },
        crossDomainLinks: original.crossDomainLinks ? JSON.parse(JSON.stringify(original.crossDomainLinks)) : {},
        embedNodeSizes: { ...(original as any).embedNodeSizes || {} },
        nodeRemarks: { ...(original as any).nodeRemarks || {} },
        nodeAnchors: { ...(original as any).nodeAnchors || {} },
        nodeLayoutStyle: original.nodeLayoutStyle,
        metadata: { ...original.metadata }
    };
}

/**
 * MOC (Map of Content) 处理器
 * 负责处理所有与 MOC 文件相关的操作
 */
export class MOCHandler {
    constructor(
        private plugin: ZKNavigationPlugin,
        private app: any,
        private hooks?: {
            onBeforeModify?: (payload: { filePath: string; content: string }) => void | Promise<void>;
        }
    ) {}

    private getBranchStylePalette(): string[] {
        return ['#ff5a5f', '#ff8a3d', '#f7c948', '#56d364', '#38d9a9', '#4dabf7', '#9775fa', '#f06595'];
    }

    private pickNextBranchStyleColor(existing: Record<string, string>): string {
        const palette = this.getBranchStylePalette();
        const used = new Set(Object.values(existing || {}).filter(Boolean));
        const unused = palette.find((c) => !used.has(c));
        if (unused) return unused;
        return palette[Math.floor(Math.random() * palette.length)];
    }

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
        const originalContent = await this.app.vault.read(mocFile);
        if (this.hooks?.onBeforeModify) {
            await this.hooks.onBeforeModify({ filePath: mocFile.path, content: originalContent });
        }

        // 使用 Mermaid 格式：通过 parse/modify/save 流程来保留所有 metadata
        const { parseMOCStructure, saveMOCStructure } = await import('src/utils/utils');
        const mocData = await parseMOCStructure(this.app, mocFile.path, headingTitle);

        // 深拷贝数据，避免修改缓存中的数据
        const mocDataCopy = deepCopyMOCResult(mocData);

        // 锁定文件级布局风格：若该 MOC 尚未持久化 nodeLayoutStyle，则在首次写入时补齐
        if (mocDataCopy.nodeLayoutStyle !== 'free' && mocDataCopy.nodeLayoutStyle !== 'auto') {
            mocDataCopy.nodeLayoutStyle = this.plugin.settings.nodeLayoutStyle === 'auto' ? 'auto' : 'free';
        }

        // 调用修改回调（操作的是拷贝，不影响缓存）
        await modifyCallback(mocDataCopy);

        // 保存更新后的数据（这会保留 crossDomainLinks 等所有 metadata）
        await saveMOCStructure(this.app, mocFile.path, headingTitle, mocDataCopy);
    }

    async modifyMOCDataBatch(
        mocFile: TFile,
        modifyCallbacks: Array<(data: MOCParseResult) => void | Promise<void>>
    ): Promise<void> {
        await this.modifyMOCData(mocFile, async (mocData) => {
            for (const modifyCallback of modifyCallbacks) {
                await modifyCallback(mocData);
            }
        });
    }

    private updateNodeColorInData(mocData: MOCParseResult, nodeID: string, color: string): void {
        if (!mocData.nodeColors) {
            mocData.nodeColors = {};
        }

        if (color) {
            mocData.nodeColors[nodeID] = color;
        } else {
            delete mocData.nodeColors[nodeID];
        }
    }

    private deleteNodeFromData(mocData: MOCParseResult, nodeID: string): void {
        let deleted = false;

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

        if (!deleted && mocData.crossDomainLinks) {
            const isCrossDomainNode = nodeID.startsWith('cd-');

            for (const sourceNodeId in mocData.crossDomainLinks) {
                const links = mocData.crossDomainLinks[sourceNodeId];
                const initialLength = links.length;

                mocData.crossDomainLinks[sourceNodeId] = links.filter((link: CrossDomainLink) => {
                    if (link.nodeId === nodeID) {
                        return false;
                    }
                    if (isCrossDomainNode) {
                        const originalNodeId = nodeID.substring(3);
                        if (link.nodeId === originalNodeId) {
                            return false;
                        }
                    }
                    return true;
                });

                if (mocData.crossDomainLinks[sourceNodeId].length < initialLength) {
                    deleted = true;
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

        if (mocData.nodePositions && mocData.nodePositions[nodeID]) {
            delete mocData.nodePositions[nodeID];
        }
        if (mocData.nodeColors && mocData.nodeColors[nodeID]) {
            delete mocData.nodeColors[nodeID];
        }
        if ((mocData as any).nodeStyleColors && (mocData as any).nodeStyleColors[nodeID]) {
            delete (mocData as any).nodeStyleColors[nodeID];
        }
        if ((mocData as any).embedNodeSizes && (mocData as any).embedNodeSizes[nodeID]) {
            delete (mocData as any).embedNodeSizes[nodeID];
        }
        if ((mocData as any).nodeRemarks && (mocData as any).nodeRemarks[nodeID]) {
            delete (mocData as any).nodeRemarks[nodeID];
        }

        if (mocData.edgeCurvatures) {
            Object.keys(mocData.edgeCurvatures).forEach((key) => {
                const parts = key.split('-');
                if (parts.includes(nodeID)) {
                    delete mocData.edgeCurvatures[key];
                }
            });
        }

        const newReverseRelations = new Map();
        for (const [key, relation] of mocData.reverseRelations) {
            if (relation.sourceID !== nodeID && relation.targetID !== nodeID) {
                newReverseRelations.set(key, relation);
            }
        }
        mocData.reverseRelations = newReverseRelations;

        if (mocData.groups) {
            mocData.groups.forEach((group: any) => {
                if (Array.isArray(group.nodeIds)) {
                    group.nodeIds = group.nodeIds.filter((id: string) => id !== nodeID);
                }
            });
            mocData.groups = mocData.groups.filter((group: any) => group.nodeIds && group.nodeIds.length > 0);
        }
    }

    private deleteCrossDomainNodeFromData(mocData: MOCParseResult, nodeID: string, crossDomainLinkInfo: any): void {
        if (!mocData.crossDomainLinks) {
            throw new Error(`未找到跨领域链接数据`);
        }

        const sourceNodeId = crossDomainLinkInfo.sourceNodeId;
        const originalNodeId = crossDomainLinkInfo.nodeId;

        if (!sourceNodeId || !mocData.crossDomainLinks[sourceNodeId]) {
            throw new Error(`未找到跨领域链接: sourceNodeId=${sourceNodeId}`);
        }

        const links = mocData.crossDomainLinks[sourceNodeId];
        const initialLength = links.length;

        mocData.crossDomainLinks[sourceNodeId] = links.filter(
            (link: CrossDomainLink) => link.nodeId !== originalNodeId
        );

        if (mocData.crossDomainLinks[sourceNodeId].length < initialLength) {
            if (mocData.crossDomainLinks[sourceNodeId].length === 0) {
                delete mocData.crossDomainLinks[sourceNodeId];
            }

            if (mocData.nodePositions && mocData.nodePositions[nodeID]) {
                delete mocData.nodePositions[nodeID];
            }
            if (mocData.nodeColors && mocData.nodeColors[nodeID]) {
                delete mocData.nodeColors[nodeID];
            }
            if ((mocData as any).nodeStyleColors && (mocData as any).nodeStyleColors[nodeID]) {
                delete (mocData as any).nodeStyleColors[nodeID];
            }
            if ((mocData as any).embedNodeSizes && (mocData as any).embedNodeSizes[nodeID]) {
                delete (mocData as any).embedNodeSizes[nodeID];
            }
            if ((mocData as any).nodeRemarks && (mocData as any).nodeRemarks[nodeID]) {
                delete (mocData as any).nodeRemarks[nodeID];
            }

            if (mocData.edgeCurvatures) {
                Object.keys(mocData.edgeCurvatures).forEach(key => {
                    const parts = key.split('-');
                    if (parts.includes(nodeID)) {
                        delete mocData.edgeCurvatures[key];
                    }
                });
            }
        } else {
            throw new Error(`未找到跨领域节点链接: ${originalNodeId}`);
        }
    }

    /**
     * 在 MOC 文件中更新节点颜色
     */
    async updateNodeColorInMOC(mocFile: TFile, nodeID: string, color: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            this.updateNodeColorInData(mocData, nodeID, color);
        });
    }

    async updateNodeColorsInMOC(mocFile: TFile, nodeIDs: string[], color: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            nodeIDs.forEach((nodeID) => this.updateNodeColorInData(mocData, nodeID, color));
        });
    }

    /**
     * 在 MOC 文件中更新节点内容
     * - 纯文字节点：更新 wikiLink + displayText
     * - 文件节点：更新 displayText；若传入 newWikiLink，则同时更新 wikiLink
     */
    async updateNodeContentInMOC(
        mocFile: TFile,
        nodeID: string,
        newContent: string,
        newWikiLink?: string,
        newIsEmbed?: boolean
    ): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            const updateNodeContentInTree = (nodes: any[]): boolean => {
                for (const node of nodes) {
                    if (node.nodeID === nodeID) {
                        if (node.isTextOnly) {
                            node.wikiLink = newContent;
                            node.displayText = newContent;
                            return true;
                        }

                        // 文件节点：只改显示文本，不改 wikiLink
                        if (typeof newWikiLink === 'string') {
                            node.wikiLink = newWikiLink;
                        }
                        if (typeof newIsEmbed === 'boolean') {
                            node.isEmbed = newIsEmbed;
                        }
                        node.displayText = newContent;
                        return true;
                    }

                    // 递归搜索子节点
                    if (node.children && node.children.length > 0) {
                        if (updateNodeContentInTree(node.children)) {
                            return true;
                        }
                    }
                }
                return false;
            };

            const updated = updateNodeContentInTree(mocData.nodes);
            if (!updated) {
                throw new Error(`未找到节点: ${nodeID}`);
            }
        });
    }

    /**
     * 兼容旧调用：更新文本节点内容
     */
    async updateTextNodeContentInMOC(mocFile: TFile, nodeID: string, newContent: string): Promise<void> {
        await this.updateNodeContentInMOC(mocFile, nodeID, newContent);
    }

    async toggleNodeAnchorInMOC(mocFile: TFile, nodeID: string, anchor: boolean): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            if (!(mocData as any).nodeAnchors) {
                (mocData as any).nodeAnchors = {};
            }
            if (anchor) {
                (mocData as any).nodeAnchors[nodeID] = true;
            } else {
                delete (mocData as any).nodeAnchors[nodeID];
            }
        });
    }

    async updateNodeRemarkInMOC(mocFile: TFile, nodeID: string, remark: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            if (!(mocData as any).nodeRemarks) {
                (mocData as any).nodeRemarks = {};
            }

            const trimmedRemark = remark.trim();
            if (trimmedRemark) {
                (mocData as any).nodeRemarks[nodeID] = trimmedRemark;
            } else {
                delete (mocData as any).nodeRemarks[nodeID];
            }
        });
    }

    /**
     * 在 MOC 文件中更新节点 ID
     * 如果节点有子节点，也会递归更新子节点的 ID 前缀
     * 例如：1.a 改为 1.c，则 1.a.1 会改为 1.c.1
     * @returns 返回更新的节点数量（包括父节点和所有子节点）
     */
    async updateNodeIDInMOC(mocFile: TFile, oldID: string, newID: string): Promise<number> {
        let updateCount = 0;

        await this.modifyMOCData(mocFile, (mocData) => {
            // 存储所有需要更新的 ID 映射（包括子节点）
            const idMappings: Array<{ old: string; new: string }> = [];

            // 更新节点树中的 ID，并收集所有受影响的节点（包括子节点）
            const updateNodeIDInTree = (nodes: any[], oldID: string, newID: string): boolean => {
                for (const node of nodes) {
                    if (node.nodeID === oldID) {
                        // 找到直接匹配的节点
                        node.nodeID = newID;
                        idMappings.push({ old: oldID, new: newID });

                        // 递归更新所有子节点的 ID 前缀
                        const updateChildrenIDs = (children: any[], parentOldPrefix: string, parentNewPrefix: string) => {
                            for (const child of children) {
                                const oldChildID = child.nodeID;
                                // 检查子节点 ID 是否以父节点旧 ID 为前缀
                                if (oldChildID.startsWith(parentOldPrefix + '.')) {
                                    const newChildID = parentNewPrefix + oldChildID.substring(parentOldPrefix.length);
                                    child.nodeID = newChildID;
                                    idMappings.push({ old: oldChildID, new: newChildID });

                                    // 递归处理深层子节点
                                    if (child.children && child.children.length > 0) {
                                        updateChildrenIDs(child.children, parentOldPrefix, parentNewPrefix);
                                    }
                                }
                            }
                        };

                        // 更新所有子节点
                        if (node.children && node.children.length > 0) {
                            updateChildrenIDs(node.children, oldID, newID);
                        }

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

            // 保存更新数量（不包括父节点本身，只统计子节点）
            updateCount = idMappings.length - 1;

            // 更新 reverseRelations 中的节点 ID（处理所有映射）
            const newReverseRelations = new Map();
            for (const [, relation] of mocData.reverseRelations) {
                let newSourceID = relation.sourceID;
                let newTargetID = relation.targetID;

                // 检查是否需要更新 sourceID
                for (const mapping of idMappings) {
                    if (relation.sourceID === mapping.old) {
                        newSourceID = mapping.new;
                        break;
                    }
                }

                // 检查是否需要更新 targetID
                for (const mapping of idMappings) {
                    if (relation.targetID === mapping.old) {
                        newTargetID = mapping.new;
                        break;
                    }
                }

                const newKey = `${newSourceID}->${newTargetID}`;
                newReverseRelations.set(newKey, {
                    sourceID: newSourceID,
                    targetID: newTargetID,
                    relationText: relation.relationText
                });
            }
            mocData.reverseRelations = newReverseRelations;

            // 更新节点位置（处理所有映射）
            for (const mapping of idMappings) {
                if (mocData.nodePositions && mocData.nodePositions[mapping.old]) {
                    mocData.nodePositions[mapping.new] = mocData.nodePositions[mapping.old];
                    delete mocData.nodePositions[mapping.old];
                }
            }

            // 更新边弧度（需要更新包含该节点的所有边 key）
            if (mocData.edgeCurvatures) {
                const newCurvatures: Record<string, any> = {};
                Object.entries(mocData.edgeCurvatures).forEach(([key, value]) => {
                    let newKey = key;
                    // 对每个映射进行替换
                    for (const mapping of idMappings) {
                        newKey = newKey.split('-').map(part => part === mapping.old ? mapping.new : part).join('-');
                    }
                    newCurvatures[newKey] = value;
                });
                mocData.edgeCurvatures = newCurvatures;
            }

            // 更新节点颜色（处理所有映射）
            for (const mapping of idMappings) {
                if (mocData.nodeColors && mocData.nodeColors[mapping.old]) {
                    mocData.nodeColors[mapping.new] = mocData.nodeColors[mapping.old];
                    delete mocData.nodeColors[mapping.old];
                }
                if ((mocData as any).nodeStyleColors && (mocData as any).nodeStyleColors[mapping.old]) {
                    (mocData as any).nodeStyleColors[mapping.new] = (mocData as any).nodeStyleColors[mapping.old];
                    delete (mocData as any).nodeStyleColors[mapping.old];
                }
            }

            // 更新跨领域链接中的节点 ID（处理所有映射）
            for (const mapping of idMappings) {
                if (mocData.crossDomainLinks && mocData.crossDomainLinks[mapping.old]) {
                    mocData.crossDomainLinks[mapping.new] = mocData.crossDomainLinks[mapping.old];
                    delete mocData.crossDomainLinks[mapping.old];
                }
            }
        });

        return updateCount;
    }

    /**
     * 重定向父子边的终点：将 oldTarget 从父节点下移出（变为自由节点），
     * 将 newTarget 从当前位置移入 oldTarget 原来的父节点下（继承 oldTarget 的 ID）。
     * 所有操作在一次 modifyMOCData 中完成，避免多次写文件时 MermaidParser 缓存失效。
     */
    async redirectParentEdgeTarget(mocFile: TFile, oldTarget: string, newTarget: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            // ---- 辅助：从树中找节点并移除，返回 {node, parent} ----
            const findAndRemove = (targetID: string): { node: any; parent: any | null } => {
                // 在根层查找
                const rootIdx = mocData.nodes.findIndex((n: any) => n.nodeID === targetID);
                if (rootIdx !== -1) {
                    const [node] = mocData.nodes.splice(rootIdx, 1);
                    return { node, parent: null };
                }
                // 在子树中查找
                const search = (nodes: any[]): { node: any; parent: any } | null => {
                    for (const n of nodes) {
                        if (!n.children?.length) continue;
                        const idx = n.children.findIndex((c: any) => c.nodeID === targetID);
                        if (idx !== -1) {
                            const [node] = n.children.splice(idx, 1);
                            return { node, parent: n };
                        }
                        const found = search(n.children);
                        if (found) return found;
                    }
                    return null;
                };
                const result = search(mocData.nodes);
                if (result) return result;
                throw new Error(`未找到节点: ${targetID}`);
            };

            // ---- 辅助：对子树中所有节点做 ID 前缀替换，收集映射 ----
            const remapSubtree = (node: any, oldPrefix: string, newPrefix: string): Array<{ old: string; new: string }> => {
                const mappings: Array<{ old: string; new: string }> = [];
                const walk = (n: any) => {
                    const oldID = n.nodeID;
                    const newID = oldID === oldPrefix
                        ? newPrefix
                        : oldID.startsWith(oldPrefix + '.') ? newPrefix + oldID.slice(oldPrefix.length) : oldID;
                    if (oldID !== newID) {
                        mappings.push({ old: oldID, new: newID });
                        n.nodeID = newID;
                    }
                    n.children?.forEach(walk);
                };
                walk(node);
                return mappings;
            };

            // ---- 辅助：计算下一个可用的 free.N ID ----
            const nextFreeID = (): string => {
                const allIDs: string[] = [];
                const collect = (nodes: any[]) => { for (const n of nodes) { allIDs.push(n.nodeID); collect(n.children ?? []); } };
                collect(mocData.nodes);
                const nums = allIDs
                    .map(id => { const m = id.match(/^free\.(\d+)$/); return m ? parseInt(m[1]) : 0; })
                    .filter(n => n > 0);
                return `free.${nums.length ? Math.max(...nums) + 1 : 1}`;
            };

            // ---- 辅助：应用映射到元数据（不含 nodePositions，位置槽保持不动） ----
            const applyMappings = (mappings: Array<{ old: string; new: string }>) => {
                const applyMap = (id: string) => mappings.find(m => m.old === id)?.new ?? id;

                // reverseRelations
                const newRR = new Map<string, any>();
                for (const [, rel] of mocData.reverseRelations) {
                    const src = applyMap(rel.sourceID);
                    const tgt = applyMap(rel.targetID);
                    newRR.set(`${src}->${tgt}`, { sourceID: src, targetID: tgt, relationText: rel.relationText });
                }
                mocData.reverseRelations = newRR;

                // nodePositions：随 ID 一起重命名，每个节点保持自己的视觉位置
                if (mocData.nodePositions) {
                    const np: Record<string, any> = {};
                    for (const [k, v] of Object.entries(mocData.nodePositions)) np[applyMap(k)] = v;
                    mocData.nodePositions = np;
                }

                // edgeCurvatures
                if (mocData.edgeCurvatures) {
                    const nc: Record<string, any> = {};
                    for (const [k, v] of Object.entries(mocData.edgeCurvatures))
                        nc[k.split('-').map(applyMap).join('-')] = v;
                    mocData.edgeCurvatures = nc;
                }

                // 其他键值映射字段
                for (const field of ['nodeColors', 'nodeStyleColors', 'embedNodeSizes', 'nodeRemarks', 'crossDomainLinks']) {
                    const obj = (mocData as any)[field];
                    if (!obj) continue;
                    const nb: Record<string, any> = {};
                    for (const [k, v] of Object.entries(obj)) nb[applyMap(k)] = v;
                    (mocData as any)[field] = nb;
                }
            };

            // ======== 主逻辑 ========

            // 1. 取出 oldTarget，记下其父节点
            const { node: oldNode, parent: oldParent } = findAndRemove(oldTarget);

            // 2. 取出 newTarget，记下其旧父节点
            const { node: newNode, parent: newTargetOldParent } = findAndRemove(newTarget);

            // 3. 在 applyMappings 前，先删除两条失效的旧父子 reverseRelation：
            //    a) oldParent → oldTarget（oldTarget 将变为自由节点，该边不再有效）
            //    b) newTargetOldParent → newTarget（newTarget 将移入 oldParent，该边不再有效）
            if (oldParent) {
                mocData.reverseRelations.delete(`${oldParent.nodeID}->${oldTarget}`);
            }
            if (newTargetOldParent) {
                mocData.reverseRelations.delete(`${newTargetOldParent.nodeID}->${newTarget}`);
            }

            // 4. oldNode 变为自由节点，放到根层，重新分配 free.N ID
            const freeID = nextFreeID();
            const mappingsOld = remapSubtree(oldNode, oldTarget, freeID);
            mocData.nodes.push(oldNode);

            // 5. newNode 移入 oldTarget 原父节点的 children，继承 oldTarget 的 ID
            const mappingsNew = remapSubtree(newNode, newTarget, oldTarget);
            const parentDepth: number = oldParent ? (oldParent.depth ?? 0) : -1;
            const setDepth = (n: any, d: number) => { n.depth = d; n.children?.forEach((c: any) => setDepth(c, d + 1)); };
            setDepth(newNode, parentDepth + 1);

            if (oldParent) {
                oldParent.children.push(newNode);
            } else {
                mocData.nodes.push(newNode);
            }

            // 6. 更新所有元数据（两批映射合并应用）
            applyMappings([...mappingsOld, ...mappingsNew]);
        });
    }

    /**
     * 将自由节点移动为指定父节点的子节点
     * @param mocFile - MOC 文件
     * @param freeNodeID - 自由节点 ID（以 'free.' 开头）
     * @param parentID - 父节点 ID
     * @param newChildID - 新的子节点 ID
     */
    async moveNodeToParent(mocFile: TFile, freeNodeID: string, parentID: string, newChildID: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            const idMappings: Array<{ old: string; new: string }> = [];
            const remapSubtreeIDs = (node: any, oldPrefix: string, newPrefix: string, depth: number) => {
                const currentOldID = node.nodeID;
                const currentNewID = currentOldID === oldPrefix
                    ? newPrefix
                    : currentOldID.startsWith(`${oldPrefix}.`)
                        ? `${newPrefix}${currentOldID.substring(oldPrefix.length)}`
                        : currentOldID;

                if (currentOldID !== currentNewID) {
                    idMappings.push({ old: currentOldID, new: currentNewID });
                    node.nodeID = currentNewID;
                }

                node.depth = depth;

                if (node.children && node.children.length > 0) {
                    node.children.forEach((child: any) => remapSubtreeIDs(child, oldPrefix, newPrefix, depth + 1));
                }
            };

            // 1. 找到并移除节点（可能在根节点，也可能在某个父节点的 children 中）
            let nodeToMove: any = null;
            let foundInRoot = false;
            let foundInParent = null;
            let foundIndex = -1;

            // 先在根节点中查找
            for (let i = 0; i < mocData.nodes.length; i++) {
                if (mocData.nodes[i].nodeID === freeNodeID) {
                    nodeToMove = mocData.nodes[i];
                    foundInRoot = true;
                    foundIndex = i;
                    break;
                }
            }

            // 如果在根节点中没找到，递归在父节点的 children 中查找
            if (!nodeToMove) {
                const removeFromParent = (nodes: any[]): boolean => {
                    for (const node of nodes) {
                        if (node.children && node.children.length > 0) {
                            const childIndex = node.children.findIndex((child: any) => child.nodeID === freeNodeID);
                            if (childIndex !== -1) {
                                nodeToMove = node.children.splice(childIndex, 1)[0];
                                foundInParent = node;
                                return true;
                            }
                            // 递归查找
                            if (removeFromParent(node.children)) {
                                return true;
                            }
                        }
                    }
                    return false;
                };

                removeFromParent(mocData.nodes);
            }

            if (!nodeToMove) {
                throw new Error(`未找到节点: ${freeNodeID}`);
            }

            // 从原来的位置移除
            if (foundInRoot) {
                mocData.nodes.splice(foundIndex, 1);
            }
            // 如果 foundInParent 不为 null，节点已经在上面的递归函数中被移除了

            // 2. 找到父节点并添加为子节点
            const findNodeInTree = (nodes: any[], targetID: string): any => {
                for (const node of nodes) {
                    if (node.nodeID === targetID) {
                        return node;
                    }
                    if (node.children && node.children.length > 0) {
                        const found = findNodeInTree(node.children, targetID);
                        if (found) return found;
                    }
                }
                return null;
            };

            const parentNode = findNodeInTree(mocData.nodes, parentID);
            if (!parentNode) {
                throw new Error(`未找到父节点: ${parentID}`);
            }

            // 更新当前节点和整棵子树的 ID / 深度
            remapSubtreeIDs(nodeToMove, freeNodeID, newChildID, parentNode.depth + 1);

            // 添加到父节点的子节点列表
            if (!parentNode.children) {
                parentNode.children = [];
            }
            parentNode.children.push(nodeToMove);

            // 4. 更新节点位置、颜色和扩展信息
            idMappings.forEach((mapping) => {
                if (mocData.nodePositions && mocData.nodePositions[mapping.old]) {
                    mocData.nodePositions[mapping.new] = mocData.nodePositions[mapping.old];
                    delete mocData.nodePositions[mapping.old];
                }
                if (mocData.nodeColors && mocData.nodeColors[mapping.old]) {
                    mocData.nodeColors[mapping.new] = mocData.nodeColors[mapping.old];
                    delete mocData.nodeColors[mapping.old];
                }
                if ((mocData as any).nodeStyleColors && (mocData as any).nodeStyleColors[mapping.old]) {
                    (mocData as any).nodeStyleColors[mapping.new] = (mocData as any).nodeStyleColors[mapping.old];
                    delete (mocData as any).nodeStyleColors[mapping.old];
                }
                if ((mocData as any).embedNodeSizes && (mocData as any).embedNodeSizes[mapping.old]) {
                    (mocData as any).embedNodeSizes[mapping.new] = (mocData as any).embedNodeSizes[mapping.old];
                    delete (mocData as any).embedNodeSizes[mapping.old];
                }
                if ((mocData as any).nodeRemarks && (mocData as any).nodeRemarks[mapping.old]) {
                    (mocData as any).nodeRemarks[mapping.new] = (mocData as any).nodeRemarks[mapping.old];
                    delete (mocData as any).nodeRemarks[mapping.old];
                }
                if (mocData.crossDomainLinks && mocData.crossDomainLinks[mapping.old]) {
                    mocData.crossDomainLinks[mapping.new] = mocData.crossDomainLinks[mapping.old];
                    delete mocData.crossDomainLinks[mapping.old];
                }
            });

            // 为新建一级节点自动分配分支主题色
            if (newChildID.split('.').length === 2) {
                if (!(mocData as any).nodeStyleColors) {
                    (mocData as any).nodeStyleColors = {};
                }
                if (!(mocData as any).nodeStyleColors[newChildID]) {
                    (mocData as any).nodeStyleColors[newChildID] = this.pickNextBranchStyleColor((mocData as any).nodeStyleColors);
                }
            }

            // 5. 更新边弧度（需要更新包含该节点的所有边 key）
            if (mocData.edgeCurvatures) {
                const newCurvatures: Record<string, any> = {};
                Object.entries(mocData.edgeCurvatures).forEach(([key, value]) => {
                    let newKey = key;
                    for (const mapping of idMappings) {
                        newKey = newKey.split('-').map(part => part === mapping.old ? mapping.new : part).join('-');
                    }
                    newCurvatures[newKey] = value;
                });
                mocData.edgeCurvatures = newCurvatures;
            }

            // 6. 更新 reverseRelations 中的节点 ID
            // 同时删掉旧父节点 -> 移动节点 的父子关系边（移动后该边已失效）
            const oldParentID = freeNodeID.includes('.')
                ? freeNodeID.split('.').slice(0, -1).join('.')
                : null;

            const newReverseRelations = new Map();
            for (const [, relation] of mocData.reverseRelations) {
                let newSourceID = relation.sourceID;
                let newTargetID = relation.targetID;

                for (const mapping of idMappings) {
                    if (newSourceID === mapping.old) {
                        newSourceID = mapping.new;
                    }
                    if (newTargetID === mapping.old) {
                        newTargetID = mapping.new;
                    }
                }

                // 跳过旧父节点 -> 新子节点 ID 的失效关系（它是移动前的父子树边，现已无意义）
                if (oldParentID && newSourceID === oldParentID && newTargetID === newChildID) {
                    continue;
                }

                const newKey = `${newSourceID}->${newTargetID}`;
                newReverseRelations.set(newKey, {
                    sourceID: newSourceID,
                    targetID: newTargetID,
                    relationText: relation.relationText
                });
            }
            mocData.reverseRelations = newReverseRelations;
        });
    }

    /**
     * 检查节点是否有父节点（即在某个父节点的 children 数组中）
     * @param mocFile - MOC 文件
     * @param nodeID - 要检查的节点 ID
     * @returns 是否有父节点
     */
    async checkNodeHasParent(mocFile: TFile, nodeID: string): Promise<boolean> {
        let hasParent = false;

        await this.modifyMOCData(mocFile, (mocData) => {
            // 检查节点是否在根节点层级
            const isRootNode = mocData.nodes.some((node: any) => node.nodeID === nodeID);

            if (isRootNode) {
                // 节点在根层级，没有父节点
                hasParent = false;
                return;
            }

            // 递归查找节点是否在某个父节点的 children 中
            const findInChildren = (nodes: any[]): boolean => {
                for (const node of nodes) {
                    if (node.children && node.children.length > 0) {
                        // 检查是否在该节点的 children 中
                        if (node.children.some((child: any) => child.nodeID === nodeID)) {
                            return true;
                        }
                        // 递归查找
                        if (findInChildren(node.children)) {
                            return true;
                        }
                    }
                }
                return false;
            };

            hasParent = findInChildren(mocData.nodes);
        });

        return hasParent;
    }

    /**
     * 将子节点转换为自由节点（从父节点的 children 中移除，添加到根节点）
     * @param mocFile - MOC 文件
     * @param childID - 子节点 ID
     * @param newFreeID - 新的自由节点 ID
     */
    async convertChildToFreeNode(mocFile: TFile, childID: string, newFreeID: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            let nodeToConvert: any = null;
            const idMappings: Array<{ old: string; new: string }> = [];
            const remapSubtreeIDs = (node: any, oldPrefix: string, newPrefix: string, depth: number) => {
                const currentOldID = node.nodeID;
                const currentNewID = currentOldID === oldPrefix
                    ? newPrefix
                    : currentOldID.startsWith(`${oldPrefix}.`)
                        ? `${newPrefix}${currentOldID.substring(oldPrefix.length)}`
                        : currentOldID;

                if (currentOldID !== currentNewID) {
                    idMappings.push({ old: currentOldID, new: currentNewID });
                    node.nodeID = currentNewID;
                }

                node.depth = depth;

                if (node.children && node.children.length > 0) {
                    node.children.forEach((child: any) => remapSubtreeIDs(child, oldPrefix, newPrefix, depth + 1));
                }
            };

            // 1. 从父节点的 children 中找到并移除子节点
            const removeFromParent = (nodes: any[]): boolean => {
                for (const node of nodes) {
                    if (node.children && node.children.length > 0) {
                        const childIndex = node.children.findIndex((child: any) => child.nodeID === childID);
                        if (childIndex !== -1) {
                            // 找到子节点，移除它
                            nodeToConvert = node.children.splice(childIndex, 1)[0];
                            return true;
                        }
                        // 递归查找
                        if (removeFromParent(node.children)) {
                            return true;
                        }
                    }
                }
                return false;
            };

            if (!removeFromParent(mocData.nodes)) {
                throw new Error(`未找到子节点: ${childID}`);
            }

            if (!nodeToConvert) {
                throw new Error(`无法提取子节点: ${childID}`);
            }

            // 2. 更新节点 ID 和深度（整棵子树一起更新）
            remapSubtreeIDs(nodeToConvert, childID, newFreeID, 0);

            // 3. 添加到根节点
            mocData.nodes.push(nodeToConvert);

            // 4. 更新节点位置、颜色和扩展信息
            idMappings.forEach((mapping) => {
                if (mocData.nodePositions && mocData.nodePositions[mapping.old]) {
                    mocData.nodePositions[mapping.new] = mocData.nodePositions[mapping.old];
                    delete mocData.nodePositions[mapping.old];
                }
                if (mocData.nodeColors && mocData.nodeColors[mapping.old]) {
                    mocData.nodeColors[mapping.new] = mocData.nodeColors[mapping.old];
                    delete mocData.nodeColors[mapping.old];
                }
                if ((mocData as any).nodeStyleColors && (mocData as any).nodeStyleColors[mapping.old]) {
                    (mocData as any).nodeStyleColors[mapping.new] = (mocData as any).nodeStyleColors[mapping.old];
                    delete (mocData as any).nodeStyleColors[mapping.old];
                }
                if ((mocData as any).embedNodeSizes && (mocData as any).embedNodeSizes[mapping.old]) {
                    (mocData as any).embedNodeSizes[mapping.new] = (mocData as any).embedNodeSizes[mapping.old];
                    delete (mocData as any).embedNodeSizes[mapping.old];
                }
                if ((mocData as any).nodeRemarks && (mocData as any).nodeRemarks[mapping.old]) {
                    (mocData as any).nodeRemarks[mapping.new] = (mocData as any).nodeRemarks[mapping.old];
                    delete (mocData as any).nodeRemarks[mapping.old];
                }
                if (mocData.crossDomainLinks && mocData.crossDomainLinks[mapping.old]) {
                    mocData.crossDomainLinks[mapping.new] = mocData.crossDomainLinks[mapping.old];
                    delete mocData.crossDomainLinks[mapping.old];
                }
            });

            // 5. 更新边弧度（需要更新包含该节点的所有边 key）
            if (mocData.edgeCurvatures) {
                const newCurvatures: Record<string, any> = {};
                Object.entries(mocData.edgeCurvatures).forEach(([key, value]) => {
                    let newKey = key;
                    for (const mapping of idMappings) {
                        newKey = newKey.split('-').map(part => part === mapping.old ? mapping.new : part).join('-');
                    }
                    newCurvatures[newKey] = value;
                });
                mocData.edgeCurvatures = newCurvatures;
            }

            // 6. 更新 reverseRelations 中的节点 ID，但要移除父节点到该子节点的反向关系
            const newReverseRelations = new Map();

            // 找到原父节点 ID（从 childID 中提取）
            const idParts = childID.split('.');
            const originalParentId = idParts.length > 1 ? idParts.slice(0, -1).join('.') : null;

            for (const [, relation] of mocData.reverseRelations) {
                let newSourceID = relation.sourceID;
                let newTargetID = relation.targetID;

                for (const mapping of idMappings) {
                    if (newSourceID === mapping.old) {
                        newSourceID = mapping.new;
                    }
                    if (newTargetID === mapping.old) {
                        newTargetID = mapping.new;
                    }
                }

                // 如果这是原父节点到该子节点的关系，跳过不添加（相当于删除）
                if (newSourceID === originalParentId && newTargetID === newFreeID) {
                    continue;
                }

                const newKey = `${newSourceID}->${newTargetID}`;
                newReverseRelations.set(newKey, {
                    sourceID: newSourceID,
                    targetID: newTargetID,
                    relationText: relation.relationText
                });
            }
            mocData.reverseRelations = newReverseRelations;
        });
    }

    /**
     * 从 MOC 文件中删除节点
     */
    async deleteNodeFromMOC(mocFile: TFile, nodeID: string): Promise<void> {
        await this.modifyMOCData(mocFile, (mocData) => {
            this.deleteNodeFromData(mocData, nodeID);
        });
    }

    async deleteNodesFromMOC(
        mocFile: TFile,
        nodes: Array<{ nodeId: string; nodeData?: any }>
    ): Promise<void> {
        const sortedNodes = [...nodes].sort((a, b) => b.nodeId.split('.').length - a.nodeId.split('.').length);

        await this.modifyMOCData(mocFile, (mocData) => {
            for (const { nodeId, nodeData } of sortedNodes) {
                if (nodeData && nodeData.isCrossDomain) {
                    const crossDomainLinkInfo = {
                        sourceNodeId: nodeData.originalNode.crossDomainSourceNodeId,
                        nodeId: nodeData.originalNode.crossDomainOriginalNodeId
                    };
                    this.deleteCrossDomainNodeFromData(mocData, nodeId, crossDomainLinkInfo);
                } else {
                    this.deleteNodeFromData(mocData, nodeId);
                }
            }
        });
    }

    /**
     * 从 MOC 文件中删除跨思维树节点
     */
    async deleteCrossDomainNodeFromMOC(mocFile: TFile, nodeID: string, crossDomainLinkInfo: any): Promise<void> {

        await this.modifyMOCData(mocFile, (mocData) => {
            this.deleteCrossDomainNodeFromData(mocData, nodeID, crossDomainLinkInfo);
        });
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
