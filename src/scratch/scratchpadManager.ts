import ZKNavigationPlugin from "main";
import { ZKNode } from "src/view/indexView";

export type ScratchpadOperation = "cut" | "copy";
export type ScratchpadKind = "file" | "text" | "embed";

export interface ScratchpadEntry {
    tempId: string;
    kind: ScratchpadKind;
    target: string;
    alias?: string;
    displayText: string;
    origin: {
        nodeId: string;
        mocPath: string;
        mocName: string;
        operation: ScratchpadOperation;
    };
    addedAt: number;
}

export interface Scratchpad {
    id: string;
    name: string;
    items: ScratchpadEntry[];
    createdAt: number;
}

const TEMP_ID_PREFIX = "scratch-";
const PAD_ID_PREFIX = "pad-";

function genTempId(): string {
    return `${TEMP_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function genPadId(): string {
    return `${PAD_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function deriveDisplayText(node: ZKNode): string {
    if (node.displayText && node.displayText.trim()) return node.displayText;
    if (node.title && node.title.trim()) return node.title;
    if (node.file?.basename) return node.file.basename;
    return node.IDStr || node.ID || "(untitled)";
}

function deriveTarget(node: ZKNode): string {
    if (node.isTextOnly) return node.displayText || node.title || "";
    if (node.wikiLink) return node.wikiLink;
    if (node.file) return node.file.basename;
    return node.displayText || "";
}

function deriveKind(node: ZKNode): ScratchpadKind {
    if (node.isTextOnly) return "text";
    if (node.isEmbed) return "embed";
    return "file";
}

export class ScratchpadManager {
    private plugin: ZKNavigationPlugin;
    private listeners: Set<() => void> = new Set();
    private saveTimer: number | null = null;

    constructor(plugin: ZKNavigationPlugin) {
        this.plugin = plugin;
    }

    // ---------- pad 管理 ----------

    listPads(): Scratchpad[] {
        return this.plugin.settings.scratchpads ?? [];
    }

    activePadId(): string {
        return this.plugin.settings.activeScratchpadId || "";
    }

    activePad(): Scratchpad | null {
        const pads = this.listPads();
        if (pads.length === 0) return null;
        const id = this.activePadId();
        return pads.find((p) => p.id === id) ?? pads[0];
    }

    setActivePad(id: string): void {
        const pad = this.listPads().find((p) => p.id === id);
        if (!pad) return;
        this.plugin.settings.activeScratchpadId = pad.id;
        this.scheduleSave();
        this.notify();
    }

    createPad(name: string): Scratchpad {
        const trimmed = (name || "").trim() || "新工作区";
        const id = genPadId();
        const pad: Scratchpad = { id, name: trimmed, items: [], createdAt: Date.now() };
        if (!Array.isArray(this.plugin.settings.scratchpads)) {
            this.plugin.settings.scratchpads = [];
        }
        this.plugin.settings.scratchpads.push(pad);
        this.plugin.settings.activeScratchpadId = id;
        this.scheduleSave();
        this.notify();
        return pad;
    }

    renamePad(id: string, name: string): void {
        const trimmed = (name || "").trim();
        if (!trimmed) return;
        const pad = this.listPads().find((p) => p.id === id);
        if (!pad || pad.name === trimmed) return;
        pad.name = trimmed;
        this.scheduleSave();
        this.notify();
    }

    /**
     * 删除 pad。若删除的是 active,自动切到剩下的第一个;若删完了,自动新建一个空"默认"。
     */
    deletePad(id: string): void {
        const pads = this.listPads();
        const idx = pads.findIndex((p) => p.id === id);
        if (idx < 0) return;
        pads.splice(idx, 1);
        if (pads.length === 0) {
            const fresh: Scratchpad = {
                id: genPadId(),
                name: "默认",
                items: [],
                createdAt: Date.now(),
            };
            pads.push(fresh);
            this.plugin.settings.activeScratchpadId = fresh.id;
        } else if (this.plugin.settings.activeScratchpadId === id) {
            this.plugin.settings.activeScratchpadId = pads[Math.max(0, idx - 1)].id;
        }
        this.scheduleSave();
        this.notify();
    }

    // ---------- 条目管理(默认作用于 active pad) ----------

    list(padId?: string): ScratchpadEntry[] {
        if (padId) {
            return this.listPads().find((p) => p.id === padId)?.items ?? [];
        }
        return this.activePad()?.items ?? [];
    }

    /** active pad 的条目数 */
    size(): number {
        return this.list().length;
    }

    /** 所有 pad 的条目总数(toolbar 徽标用) */
    totalSize(): number {
        return this.listPads().reduce((sum, p) => sum + p.items.length, 0);
    }

    isEmpty(): boolean {
        return this.size() === 0;
    }

    /** 跨 pad 查找(拖拽 / 粘贴时用) */
    get(tempId: string): { entry: ScratchpadEntry; padId: string } | null {
        for (const pad of this.listPads()) {
            const entry = pad.items.find((e) => e.tempId === tempId);
            if (entry) return { entry, padId: pad.id };
        }
        return null;
    }

    has(tempId: string): boolean {
        return !!this.get(tempId);
    }

    onChange(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    private notify(): void {
        for (const cb of this.listeners) {
            try { cb(); } catch (e) { console.error("[scratchpad] listener error", e); }
        }
    }

    private scheduleSave(): void {
        if (this.saveTimer !== null) return;
        this.saveTimer = window.setTimeout(async () => {
            this.saveTimer = null;
            try {
                await this.plugin.saveData(this.plugin.settings);
            } catch (e) {
                console.error("[scratchpad] save failed", e);
            }
        }, 80);
    }

    /**
     * 从 ZKNode 构造一条暂存条目(不改任何状态;调用方再 add)
     */
    buildEntry(
        node: ZKNode,
        mocPath: string,
        mocName: string,
        operation: ScratchpadOperation
    ): ScratchpadEntry {
        return {
            tempId: genTempId(),
            kind: deriveKind(node),
            target: deriveTarget(node),
            alias: node.isTextOnly
                ? undefined
                : (node.displayText && node.displayText !== deriveTarget(node) ? node.displayText : undefined),
            displayText: deriveDisplayText(node),
            origin: {
                nodeId: node.IDStr || node.ID,
                mocPath,
                mocName,
                operation,
            },
            addedAt: Date.now(),
        };
    }

    /** 默认加入 active pad 顶部 */
    async add(entry: ScratchpadEntry, padId?: string): Promise<void> {
        const target = padId
            ? this.listPads().find((p) => p.id === padId)
            : this.activePad();
        if (!target) return;
        target.items.unshift(entry);
        this.scheduleSave();
        this.notify();
    }

    async remove(tempId: string): Promise<void> {
        for (const pad of this.listPads()) {
            const idx = pad.items.findIndex((e) => e.tempId === tempId);
            if (idx >= 0) {
                pad.items.splice(idx, 1);
                this.scheduleSave();
                this.notify();
                return;
            }
        }
    }

    /** 清空指定 pad(不传则清 active) */
    async clear(padId?: string): Promise<void> {
        const target = padId
            ? this.listPads().find((p) => p.id === padId)
            : this.activePad();
        if (!target || target.items.length === 0) return;
        target.items = [];
        this.scheduleSave();
        this.notify();
    }
}
