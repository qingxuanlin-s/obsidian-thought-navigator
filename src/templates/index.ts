import { SpaceTemplate } from "src/types/folder";

const PARA: SpaceTemplate = {
    id: 'para',
    name: 'PARA',
    description: 'Projects · Areas · Resources · Archive,Tiago Forte 提倡的通用分类',
    icon: '📊',
    roots: [
        { name: 'Projects', icon: '📊', color: '#6ba3ff' },
        { name: 'Areas', icon: '🎯', color: '#7fd49a' },
        { name: 'Resources', icon: '📚', color: '#f2a65a' },
        { name: 'Archive', icon: '📦', color: '#8a8e98' },
    ],
};

const GTD: SpaceTemplate = {
    id: 'gtd',
    name: 'GTD',
    description: 'Getting Things Done 工作流的标准列表',
    icon: '✅',
    roots: [
        { name: 'Inbox', icon: '📥', color: '#ffb454' },
        { name: 'Next Actions', icon: '⚡', color: '#6ba3ff' },
        { name: 'Waiting For', icon: '⏳', color: '#cf94e5' },
        { name: 'Someday / Maybe', icon: '💭', color: '#8a8e98' },
        { name: 'Reference', icon: '📚', color: '#7fd49a' },
    ],
};

const BLANK: SpaceTemplate = {
    id: 'blank',
    name: '空白',
    description: '只创建一个空 Space,自己填内容',
    icon: '📁',
    roots: [
        { name: '我的 Space', icon: '📁' },
    ],
};

export const BUILTIN_TEMPLATES: SpaceTemplate[] = [PARA, GTD, BLANK];

export function findTemplate(id: string): SpaceTemplate | undefined {
    return BUILTIN_TEMPLATES.find(t => t.id === id);
}
