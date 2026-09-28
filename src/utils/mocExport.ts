import JSZip from 'jszip';
import type { MOCParseResult, MOCTreeNode } from './utils';

interface XMindTopic {
    id: string;
    title: string;
    children?: { attached: XMindTopic[] };
    notes?: { plain: { content: string } };
}

function nodeTitle(node: MOCTreeNode): string {
    return (node.alias ?? node.target).replace(/\r?\n/g, ' ');
}

function nodeNotes(node: MOCTreeNode, data: MOCParseResult): string {
    return [
        node.nodeType !== 'text'
            ? `zk-link: ${node.nodeType === 'embed' ? '!' : ''}[[${node.target}${node.alias ? `|${node.alias}` : ''}]]`
            : '',
        node.relationText ? `zk-relation: ${node.relationText}` : '',
        data.nodeRemarks?.[node.nodeID] || '',
    ].filter(Boolean).join('\n\n');
}

export function exportMOCAsMarkdown(data: MOCParseResult, title: string): string {
    const singleRoot = data.nodes.length === 1 ? data.nodes[0] : null;
    const lines = [`# ${singleRoot ? nodeTitle(singleRoot) : title}`, ''];
    if (!singleRoot) lines.push('<!-- zk-moc: multiple-roots -->', '');
    const labels = new Map<string, string>();
    const parentIds = new Map<string, string>();

    const writeNodes = (nodes: MOCTreeNode[], depth: number, parentId?: string): void => {
        for (const node of nodes) {
            const display = nodeTitle(node);
            labels.set(node.nodeID, display);
            if (parentId) parentIds.set(node.nodeID, parentId);
            const text = node.nodeType === 'text'
                ? display
                : `${node.nodeType === 'embed' ? '!' : ''}[[${node.target}${node.alias ? `|${node.alias}` : ''}]]`;
            const indent = '  '.repeat(depth);
            lines.push(`${indent}- ${text}`);
            const notes = [node.relationText ? `zk-relation: ${node.relationText}` : '', data.nodeRemarks?.[node.nodeID] || ''].filter(Boolean);
            for (const note of notes) {
                for (const line of note.split(/\r?\n/)) lines.push(`${indent}  > ${line}`);
            }
            writeNodes(node.children, depth + 1, node.nodeID);
        }
    };
    if (singleRoot) {
        labels.set(singleRoot.nodeID, nodeTitle(singleRoot));
        if (singleRoot.nodeType !== 'text') {
            lines.push(`${singleRoot.nodeType === 'embed' ? '!' : ''}[[${singleRoot.target}${singleRoot.alias ? `|${singleRoot.alias}` : ''}]]`, '');
        }
        if (singleRoot.relationText) lines.push(`> zk-relation: ${singleRoot.relationText}`);
        if (data.nodeRemarks?.[singleRoot.nodeID]) {
            for (const line of data.nodeRemarks[singleRoot.nodeID].split(/\r?\n/)) lines.push(`> ${line}`);
        }
        writeNodes(singleRoot.children, 0, singleRoot.nodeID);
    } else {
        writeNodes(data.nodes, 0);
    }

    const relationships = Array.from(data.reverseRelations.values()).filter(rel =>
        labels.has(rel.sourceID) && labels.has(rel.targetID) && parentIds.get(rel.targetID) !== rel.sourceID
    );
    if (relationships.length) {
        lines.push('', '## 关联关系', '');
        for (const rel of relationships) {
            lines.push(`- ${labels.get(rel.sourceID)} → ${labels.get(rel.targetID)}${rel.relationText ? `：${rel.relationText}` : ''}`);
        }
    }
    return `${lines.join('\n')}\n`;
}

export async function exportMOCAsXMind(data: MOCParseResult, title: string): Promise<Blob> {
    const topicIds = new Map<string, string>();
    const parentIds = new Map<string, string>();
    let nextId = 0;
    const makeTopic = (node: MOCTreeNode, parentId?: string): XMindTopic => {
        const id = `topic-${++nextId}`;
        topicIds.set(node.nodeID, id);
        if (parentId) parentIds.set(node.nodeID, parentId);
        const topic: XMindTopic = { id, title: nodeTitle(node) };
        const notes = nodeNotes(node, data);
        if (notes) topic.notes = { plain: { content: notes } };
        if (node.children.length) topic.children = { attached: node.children.map(child => makeTopic(child, node.nodeID)) };
        return topic;
    };

    const rootTopic: XMindTopic = data.nodes.length === 1
        ? makeTopic(data.nodes[0])
        : {
            id: `topic-${++nextId}`,
            title,
            notes: { plain: { content: 'zk-moc: multiple-roots' } },
            children: { attached: data.nodes.map(node => makeTopic(node)) },
        };
    const relationships = Array.from(data.reverseRelations.values())
        .filter(rel => topicIds.has(rel.sourceID) && topicIds.has(rel.targetID) && parentIds.get(rel.targetID) !== rel.sourceID)
        .map((rel, index) => ({
            id: `relationship-${index + 1}`,
            title: rel.relationText || '',
            end1Id: topicIds.get(rel.sourceID),
            end2Id: topicIds.get(rel.targetID),
        }));
    const sheet = {
        id: 'sheet-1',
        class: 'sheet',
        title,
        rootTopic: { ...rootTopic, class: 'topic', structureClass: 'org.xmind.ui.map.unbalanced' },
        ...(relationships.length ? { relationships } : {}),
    };

    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([sheet]));
    zip.file('metadata.json', '{}');
    zip.file('manifest.json', JSON.stringify({
        'file-entries': { 'content.json': {}, 'metadata.json': {} },
    }));
    return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.xmind.workbook' });
}
