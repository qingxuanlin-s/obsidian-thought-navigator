import { SpaceTemplate } from "src/types/folder";

const PARA: SpaceTemplate = {
    id: 'para',
    name: 'PARA',
    description: 'Projects · Areas · Resources · Archive,Tiago Forte 提倡的通用分类',
    icon: 'bar-chart-3',
    roots: [
        { name: 'Projects', icon: 'folder', color: '#6ba3ff' },
        { name: 'Areas', icon: 'target', color: '#7fd49a' },
        { name: 'Resources', icon: 'book-open', color: '#f2a65a' },
        { name: 'Archive', icon: 'archive', color: '#8a8e98' },
    ],
};

const BLANK: SpaceTemplate = {
    id: 'blank',
    name: '空白',
    description: '只创建一个空 Space,自己填内容',
    icon: 'folder',
    roots: [
        { name: '我的 Space', icon: 'folder' },
    ],
};

const ZK_THREE_LAYER: SpaceTemplate = {
    id: 'zk-three-layer',
    name: '总览 / 主题 / 局部',
    description: '三层结构:总览作入口,主题分领域,局部知识沉淀细节',
    icon: 'compass',
    roots: [
        { name: '总览', icon: 'map', color: '#6ba3ff' },
        { name: '主题', icon: 'target', color: '#7fd49a' },
        { name: '局部知识', icon: 'map-pin', color: '#cf94e5' },
    ],
};

export const BUILTIN_TEMPLATES: SpaceTemplate[] = [PARA, ZK_THREE_LAYER, BLANK];

export function findTemplate(id: string): SpaceTemplate | undefined {
    return BUILTIN_TEMPLATES.find(t => t.id === id);
}
