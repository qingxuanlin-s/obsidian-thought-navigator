import JSZip from 'jszip';
import type { MOCTreeNode, ReverseRelation } from './utils';

export interface ImportedMOC {
    nodes: MOCTreeNode[];
    reverseRelations: Map<string, ReverseRelation>;
    nodeRemarks: Record<string, string>;
}

interface XMindTopic {
    id?: string;
    title?: string;
    href?: string;
    notes?: { plain?: { content?: string } };
    children?: { attached?: XMindTopic[] };
}

interface XMindSheet {
    title?: string;
    rootTopic?: XMindTopic;
    relationships?: Array<{ end1Id?: string; end2Id?: string; title?: string }>;
}

function makeNode(text: string, id: string, depth: number): MOCTreeNode {
    const wiki = /^(!?)\[\[([^\]]+)\]\]$/.exec(text.trim());
    const separator = wiki ? wiki[2].indexOf('|') : -1;
    const target = wiki ? wiki[2].slice(0, separator < 0 ? undefined : separator) : text.trim();
    const alias = separator >= 0 && wiki ? wiki[2].slice(separator + 1) : undefined;
    return {
        nodeID: id,
        nodeType: wiki ? (wiki[1] ? 'embed' : 'file') : 'text',
        target,
        ...(alias ? { alias } : {}),
        depth,
        children: [],
        file: null,
        relationText: '',
    };
}

export function importMarkdown(content: string): ImportedMOC {
    const multipleRoots = content.includes('<!-- zk-moc: multiple-roots -->');
    content = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    const data: ImportedMOC = { nodes: [], reverseRelations: new Map(), nodeRemarks: {} };
    const headings: Array<{ depth: number; node: MOCTreeNode }> = [];
    const bullets: Array<{ indent: number; node: MOCTreeNode }> = [];
    const labels = new Map<string, string>();
    const pendingRelations: Array<{ source: string; target: string; title: string }> = [];
    let current: MOCTreeNode | null = null;
    let inRelations = false;
    let firstHeading = true;
    let syntheticTitle = '';

    const append = (text: string, parent: MOCTreeNode | null, depth: number): MOCTreeNode => {
        const id = parent
            ? `${parent.nodeID}.${parent.children.length + 1}`
            : String(data.nodes.length + 1);
        const node = makeNode(text, id, depth);
        (parent ? parent.children : data.nodes).push(node);
        labels.set(node.alias ?? node.target, id);
        current = node;
        return node;
    };
    const note = (line: string): void => {
        if (!current || !line.trim()) return;
        const previous = data.nodeRemarks[current.nodeID];
        data.nodeRemarks[current.nodeID] = previous ? `${previous}\n${line}` : line;
    };
    const setRelation = (line: string): void => {
        if (current) current.relationText = line;
    };

    for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
        const line = rawLine.trimEnd();
        if (!line.trim() || /^<!--.*-->$/.test(line.trim())) continue;

        const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
        if (heading) {
            const title = heading[2].trim();
            if (firstHeading && multipleRoots && heading[1].length === 1) {
                syntheticTitle = title;
                firstHeading = false;
                continue;
            }
            firstHeading = false;
            if (heading[1].length === 2 && (title === '关联关系' || title === 'Relationships')) {
                inRelations = true;
                current = null;
                continue;
            }
            inRelations = false;
            bullets.length = 0;
            const depth = heading[1].length;
            while (headings.length && headings[headings.length - 1].depth >= depth) headings.pop();
            const parent = headings[headings.length - 1]?.node ?? null;
            headings.push({ depth, node: append(title, parent, parent ? parent.depth + 1 : 0) });
            continue;
        }

        if (inRelations) {
            const relation = /^[-*+]\s+(.+?)\s+→\s+(.+?)(?:[：:]\s*(.*))?$/.exec(line.trim());
            if (relation) pendingRelations.push({ source: relation[1], target: relation[2], title: relation[3] || '' });
            continue;
        }

        const bullet = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
        if (bullet) {
            const indent = bullet[1].replace(/\t/g, '    ').length;
            while (bullets.length && bullets[bullets.length - 1].indent >= indent) bullets.pop();
            const parent = bullets[bullets.length - 1]?.node ?? headings[headings.length - 1]?.node ?? null;
            const node = append(bullet[2].trim(), parent, parent ? parent.depth + 1 : 0);
            bullets.push({ indent, node });
            continue;
        }

        const quoted = /^\s*>\s?(.*)$/.exec(line);
        const root = headings[headings.length - 1]?.node;
        if (quoted) {
            if (quoted[1].startsWith('zk-relation: ')) setRelation(quoted[1].slice('zk-relation: '.length));
            else note(quoted[1]);
        }
        else if (/^!?\[\[[^\]]+\]\]$/.test(line.trim()) && root?.nodeType === 'text' && root.depth === 0 && !bullets.length) {
            const linked = makeNode(line.trim(), root.nodeID, root.depth);
            root.nodeType = linked.nodeType;
            root.target = linked.target;
            root.alias = linked.alias;
        } else if (!/^(```|~~~)/.test(line)) note(line.trim());
    }

    for (const rel of pendingRelations) {
        const sourceID = labels.get(rel.source);
        const targetID = labels.get(rel.target);
        if (sourceID && targetID) data.reverseRelations.set(`${sourceID}->${targetID}`, {
            sourceID, targetID, relationText: rel.title,
        });
    }
    if (!data.nodes.length && syntheticTitle) data.nodes.push(makeNode(syntheticTitle, '1', 0));
    if (!data.nodes.length) throw new Error('No headings or list items found in Markdown');
    return data;
}

export async function importXMind(buffer: ArrayBuffer): Promise<ImportedMOC> {
    const zip = await JSZip.loadAsync(buffer);
    const json = zip.file('content.json');
    if (json) return importXMindJson(await json.async('string'));
    const xml = zip.file('content.xml');
    if (xml) return importXMindXml(await xml.async('string'));
    throw new Error('XMind content.json or content.xml is missing');
}

function importXMindJson(content: string): ImportedMOC {
    const sheets = JSON.parse(content) as XMindSheet[];
    if (!Array.isArray(sheets)) throw new Error('Invalid XMind content.json');
    const data: ImportedMOC = { nodes: [], reverseRelations: new Map(), nodeRemarks: {} };
    for (const sheet of sheets) {
        if (!sheet.rootTopic) continue;
        const ids = new Map<string, string>();
        const visit = (topic: XMindTopic, id: string, depth: number): MOCTreeNode => {
            if (topic.id) ids.set(topic.id, id);
            const note = topic.notes?.plain?.content || '';
            const firstLine = note.split(/\r?\n/)[0];
            const sourceLink = /^zk-link: (!?\[\[[^\]]+\]\])$/.exec(firstLine)?.[1];
            const node = makeNode(sourceLink || topic.title || '', id, depth);
            if (node.nodeType !== 'text' && topic.title && topic.title !== node.target) node.alias = topic.title;
            let remaining = sourceLink ? note.slice(firstLine.length).trim() : note;
            const relation = /^zk-relation: ([^\r\n]*)(?:\r?\n|$)/.exec(remaining);
            if (relation) {
                node.relationText = relation[1];
                remaining = remaining.slice(relation[0].length).trim();
            }
            if (remaining) data.nodeRemarks[id] = remaining;
            if (topic.href) data.nodeRemarks[id] = [data.nodeRemarks[id], topic.href].filter(Boolean).join('\n');
            node.children = (topic.children?.attached || [])
                .map((child, index) => visit(child, `${id}.${index + 1}`, depth + 1));
            return node;
        };
        if (sheet.rootTopic.notes?.plain?.content === 'zk-moc: multiple-roots') {
            const roots = sheet.rootTopic.children?.attached || [];
            if (roots.length) {
                data.nodes.push(...roots.map((root, index) => visit(root, String(data.nodes.length + index + 1), 0)));
            } else {
                data.nodes.push(makeNode(sheet.rootTopic.title || sheet.title || 'Untitled', String(data.nodes.length + 1), 0));
            }
        } else {
            data.nodes.push(visit(sheet.rootTopic, String(data.nodes.length + 1), 0));
        }
        for (const rel of sheet.relationships || []) {
            const sourceID = rel.end1Id ? ids.get(rel.end1Id) : undefined;
            const targetID = rel.end2Id ? ids.get(rel.end2Id) : undefined;
            if (sourceID && targetID) data.reverseRelations.set(`${sourceID}->${targetID}`, {
                sourceID, targetID, relationText: rel.title || '',
            });
        }
    }
    if (!data.nodes.length) throw new Error('XMind has no topics');
    return data;
}

function importXMindXml(content: string): ImportedMOC {
    const xml = new DOMParser().parseFromString(content, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) throw new Error('Invalid XMind content.xml');
    const children = (element: Element, name: string): Element[] =>
        Array.from(element.children).filter(child => child.localName === name);
    const child = (element: Element, name: string): Element | undefined => children(element, name)[0];
    const data: ImportedMOC = { nodes: [], reverseRelations: new Map(), nodeRemarks: {} };
    for (const sheet of Array.from(xml.documentElement.children).filter(el => el.localName === 'sheet')) {
        const root = child(sheet, 'topic');
        if (!root) continue;
        const ids = new Map<string, string>();
        const visit = (topic: Element, id: string, depth: number): MOCTreeNode => {
            const originalId = topic.getAttribute('id');
            if (originalId) ids.set(originalId, id);
            const title = child(topic, 'title')?.textContent || '';
            const node = makeNode(title, id, depth);
            const note = child(child(topic, 'notes') || topic, 'plain')?.textContent?.trim();
            if (note) data.nodeRemarks[id] = note;
            const attached = children(child(topic, 'children') || topic, 'topics')
                .filter(group => group.getAttribute('type') === 'attached');
            const topics = attached.flatMap(group => children(group, 'topic'));
            node.children = topics.map((item, index) => visit(item, `${id}.${index + 1}`, depth + 1));
            return node;
        };
        data.nodes.push(visit(root, String(data.nodes.length + 1), 0));
        for (const group of children(sheet, 'relationships')) {
            for (const rel of children(group, 'relationship')) {
                const sourceID = ids.get(rel.getAttribute('end1') || '');
                const targetID = ids.get(rel.getAttribute('end2') || '');
                if (sourceID && targetID) data.reverseRelations.set(`${sourceID}->${targetID}`, {
                    sourceID, targetID, relationText: child(rel, 'title')?.textContent || '',
                });
            }
        }
    }
    if (!data.nodes.length) throw new Error('XMind has no topics');
    return data;
}
