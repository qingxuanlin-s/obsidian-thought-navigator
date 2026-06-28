import { TFile } from "obsidian";
import ZKNavigationPlugin from "main";
import { ZKNode } from "src/view/indexView";
import { t } from "src/lang/helper";

export type ScratchpadOperation = "cut" | "copy";
export type ScratchpadKind = "file" | "text" | "embed";
export type ScratchpadSplitRule = "heading" | "line";

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
    boundMocPath?: string;
}

const TEMP_ID_PREFIX = "scratch-";
const PAD_ID_PREFIX = "pad-";

function genTempId(): string {
    return `${TEMP_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function genPadId(): string {
    return `${PAD_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function stripLeadingNodeId(text: string, nodeId?: string): string {
    const trimmed = (text || "").trim();
    if (!trimmed) return "";

    if (nodeId) {
        const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const stripped = trimmed
            .replace(new RegExp(`^${escaped}\\s*[:：\\-_\\s]\\s*`), '')
            .trim();
        if (stripped) return stripped;
    }

    return trimmed.replace(/^[a-zA-Z0-9._]+\s*[:：]\s*/, '').trim() || trimmed;
}

function deriveDisplayText(node: ZKNode): string {
    // 卡片下方已经有独立的 ID 徽章,这里只取干净的标题部分,避免出现 "ID: 标题" 的重复
    const id = node.IDStr || node.ID;
    if (node.title && node.title.trim()) return stripLeadingNodeId(node.title, id);
    if (node.file?.basename) return node.file.basename;
    if (node.displayText && node.displayText.trim()) {
        // 兜底:displayText 形如 "ID: 标题" 时,剥掉前缀的 ID
        return stripLeadingNodeId(node.displayText, id);
    }
    return node.IDStr || node.ID || "(untitled)";
}

function deriveTarget(node: ZKNode): string {
    if (node.isTextOnly) return deriveDisplayText(node);
    if (node.wikiLink) return node.wikiLink;
    if (node.file) return node.file.basename;
    return node.displayText || "";
}

function deriveKind(node: ZKNode): ScratchpadKind {
    if (node.isTextOnly) return "text";
    if (node.isEmbed) return "embed";
    return "file";
}

function normalizeSplitPart(text: string): string {
    return (text || "").trim();
}

function splitTextByLine(text: string): string[] {
    return text
        .split(/\r?\n+/)
        .map(normalizeSplitPart)
        .filter(Boolean);
}

function splitTextByHeading(text: string): string[] {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const parts: string[] = [];
    let current: string[] = [];

    const flush = () => {
        const part = normalizeSplitPart(current.join("\n"));
        if (part) parts.push(part);
        current = [];
    };

    for (const line of lines) {
        if (/^#{1,6}\s+\S/.test(line) && current.length > 0) {
            flush();
        }
        current.push(line);
    }

    flush();
    return parts;
}

function splitText(text: string, rule: ScratchpadSplitRule): string[] {
    return rule === "heading" ? splitTextByHeading(text) : splitTextByLine(text);
}

function entryToMergedText(entry: ScratchpadEntry): string {
    if (entry.kind === "text") {
        return normalizeSplitPart(entry.target || entry.displayText);
    }

    const target = normalizeSplitPart(entry.target || entry.displayText);
    if (!target) return normalizeSplitPart(entry.displayText);

    const alias = normalizeSplitPart(entry.alias || "");
    const link = alias && alias !== target ? `${target}|${alias}` : target;
    return entry.kind === "embed" ? `![[${link}]]` : `[[${link}]]`;
}

interface ScratchpadStore {
    scratchpads: Scratchpad[];
    activeScratchpadId: string;
}

/** 旧版本遗留在 plugin data.json(settings)里的暂存字段,迁移时按需读取/清理 */
interface LegacyScratchpadSettings {
    scratchpads?: Scratchpad[];
    activeScratchpadId?: string;
    scratchpadItems?: ScratchpadEntry[];
}

const STORE_FILENAME = "scratchpads.json";

export class ScratchpadManager {
    private plugin: ZKNavigationPlugin;
    private store: ScratchpadStore = { scratchpads: [], activeScratchpadId: "" };
    private storePath: string;
    private listeners: Set<() => void> = new Set();
    private saveTimer: number | null = null;

    constructor(plugin: ZKNavigationPlugin) {
        this.plugin = plugin;
        this.storePath = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/${STORE_FILENAME}`;
    }

    // ---------- 持久化(独立文件 scratchpads.json,不与 plugin data.json 混存) ----------

    /**
     * 从独立的 scratchpads.json 读取;文件不存在时,从旧版 plugin data.json(settings)迁移过来,
     * 迁移后清掉 data.json 里的旧字段,避免双写。
     */
    async load(): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        let loaded: ScratchpadStore | null = null;

        try {
            if (await adapter.exists(this.storePath)) {
                const parsed = JSON.parse(await adapter.read(this.storePath));
                if (parsed && Array.isArray(parsed.scratchpads)) {
                    loaded = {
                        scratchpads: parsed.scratchpads as Scratchpad[],
                        activeScratchpadId: typeof parsed.activeScratchpadId === "string" ? parsed.activeScratchpadId : "",
                    };
                }
            }
        } catch (e) {
            console.warn("[scratchpad] scratchpads.json 读取失败", this.storePath, e);
        }

        let migratedFromSettings = false;
        if (!loaded) {
            // 旧版本:暂存数据存在 plugin data.json 的 settings 里,迁移到独立文件
            const settings = this.plugin.settings as unknown as LegacyScratchpadSettings;
            loaded = {
                scratchpads: Array.isArray(settings.scratchpads) ? settings.scratchpads : [],
                activeScratchpadId: typeof settings.activeScratchpadId === "string" ? settings.activeScratchpadId : "",
            };
            migratedFromSettings = true;
        }

        this.store = loaded;
        this.normalize();

        if (migratedFromSettings) {
            // 清掉 data.json 里的旧字段,避免与 scratchpads.json 双写
            const settings = this.plugin.settings as unknown as LegacyScratchpadSettings;
            delete settings.scratchpads;
            delete settings.activeScratchpadId;
            delete settings.scratchpadItems;
            try { await this.plugin.saveData(this.plugin.settings); } catch (e) { console.warn("[scratchpad] 清理旧 data.json 字段失败", e); }
        }

        // 落盘一次,确保新文件存在并保存规范化结果
        await this.flush();
    }

    /** 规范化:旧 scratchpadItems 迁移 / 默认名本地化 / 至少一个 pad / active 指向有效 pad */
    private normalize(): void {
        const localizedDefaultName = t("scratch default pad name");
        const shouldLocalizeLegacy = localizedDefaultName !== "未命名";

        if (!Array.isArray(this.store.scratchpads)) {
            this.store.scratchpads = [];
        }

        // 旧版 scratchpadItems(单一暂存区)迁移为单 pad
        const legacyItems = (this.plugin.settings as unknown as LegacyScratchpadSettings).scratchpadItems;
        if (Array.isArray(legacyItems) && legacyItems.length > 0 && this.store.scratchpads.length === 0) {
            this.store.scratchpads.push({
                id: `pad-legacy-${Date.now().toString(36)}`,
                name: localizedDefaultName,
                items: legacyItems as ScratchpadEntry[],
                createdAt: Date.now(),
            });
        }

        if (shouldLocalizeLegacy) {
            this.store.scratchpads.forEach((pad) => {
                if (pad.name === "默认") {
                    pad.name = localizedDefaultName;
                }
            });
        }

        // 至少保证有一个 pad
        if (this.store.scratchpads.length === 0) {
            this.store.scratchpads.push({
                id: `pad-default-${Date.now().toString(36)}`,
                name: localizedDefaultName,
                items: [],
                createdAt: Date.now(),
            });
        }

        // active id 必须指向已有 pad
        if (!this.store.scratchpads.some((p) => p.id === this.store.activeScratchpadId)) {
            this.store.activeScratchpadId = this.store.scratchpads[0].id;
        }
    }

    private async flush(): Promise<void> {
        try {
            await this.plugin.app.vault.adapter.write(this.storePath, JSON.stringify(this.store, null, 2));
        } catch (e) {
            console.error("[scratchpad] save failed", e);
        }
    }

    // ---------- pad 管理 ----------

    listPads(): Scratchpad[] {
        return this.store.scratchpads;
    }

    listPadsForMOC(mocPath: string): Scratchpad[] {
        const normalized = this.normalizeMocPath(mocPath);
        const pads = [...this.listPads()];
        if (!normalized) return pads;

        return pads.sort((a, b) => {
            const aBound = this.normalizeMocPath(a.boundMocPath) === normalized;
            const bBound = this.normalizeMocPath(b.boundMocPath) === normalized;
            if (aBound === bBound) return 0;
            return aBound ? -1 : 1;
        });
    }

    getBoundPadForMOC(mocPath: string): Scratchpad | null {
        const normalized = this.normalizeMocPath(mocPath);
        if (!normalized) return null;
        return this.listPads().find((p) => this.normalizeMocPath(p.boundMocPath) === normalized) ?? null;
    }

    activePadId(): string {
        return this.store.activeScratchpadId || "";
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
        this.store.activeScratchpadId = pad.id;
        this.scheduleSave();
        this.notify();
    }

    createPad(name: string): Scratchpad {
        const trimmed = (name || "").trim() || "新工作区";
        const id = genPadId();
        const pad: Scratchpad = { id, name: trimmed, items: [], createdAt: Date.now() };
        this.store.scratchpads.push(pad);
        this.store.activeScratchpadId = id;
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

    bindPadToMOC(padId: string, mocPath: string): boolean {
        const normalized = this.normalizeMocPath(mocPath);
        if (!normalized) return false;

        const pad = this.listPads().find((p) => p.id === padId);
        if (!pad) return false;

        for (const item of this.listPads()) {
            if (this.normalizeMocPath(item.boundMocPath) === normalized) {
                delete item.boundMocPath;
            }
        }

        pad.boundMocPath = normalized;
        this.scheduleSave();
        this.notify();
        return true;
    }

    unbindPadFromMOC(padId: string, mocPath?: string): boolean {
        const pad = this.listPads().find((p) => p.id === padId);
        if (!pad?.boundMocPath) return false;

        const normalized = this.normalizeMocPath(mocPath);
        if (normalized && this.normalizeMocPath(pad.boundMocPath) !== normalized) return false;

        delete pad.boundMocPath;
        this.scheduleSave();
        this.notify();
        return true;
    }

    isPadBoundToMOC(pad: Scratchpad, mocPath: string): boolean {
        const normalized = this.normalizeMocPath(mocPath);
        return !!normalized && this.normalizeMocPath(pad.boundMocPath) === normalized;
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
                name: t("scratch default pad name"),
                items: [],
                createdAt: Date.now(),
            };
            pads.push(fresh);
            this.store.activeScratchpadId = fresh.id;
        } else if (this.store.activeScratchpadId === id) {
            this.store.activeScratchpadId = pads[Math.max(0, idx - 1)].id;
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

    /** 当前 MOC 可见的条目数:未绑定 pad + 绑定当前 MOC 的 pad */
    visibleSizeForMOC(mocPath: string): number {
        const normalized = this.normalizeMocPath(mocPath);
        return this.listPads().reduce((sum, pad) => {
            const boundPath = this.normalizeMocPath(pad.boundMocPath);
            if (!boundPath || (normalized && boundPath === normalized)) {
                return sum + pad.items.length;
            }
            return sum;
        }, 0);
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
        this.saveTimer = window.setTimeout(() => { void (async () => {
            this.saveTimer = null;
            await this.flush();
        })(); }, 80);
    }

    private normalizeMocPath(path?: string): string {
        return (path || "").trim();
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

    /**
     * 从 vault 中拖入的文件构造一条暂存条目(operation 总是 copy,不改原文件)。
     * 没有节点 ID 概念,用 file.basename 占位。
     */
    buildEntryFromFile(
        file: TFile,
        mocPath: string,
        mocName: string,
    ): ScratchpadEntry {
        return {
            tempId: genTempId(),
            kind: "file",
            target: file.basename,
            displayText: file.basename,
            origin: {
                nodeId: file.basename,
                mocPath,
                mocName,
                operation: "copy",
            },
            addedAt: Date.now(),
        };
    }

    /**
     * 从抽屉内手动输入的文本构造暂存条目。
     * 只进入 scratchpad,不修改当前 MOC;真正拖放/粘贴时再生成节点 ID。
     */
    buildEntryFromText(
        text: string,
        mocPath: string,
        mocName: string,
    ): ScratchpadEntry | null {
        return this.buildEntriesFromText(text, mocPath, mocName)[0] ?? null;
    }

    buildEntriesFromText(
        text: string,
        mocPath: string,
        mocName: string,
        splitRule?: ScratchpadSplitRule,
    ): ScratchpadEntry[] {
        const parts = splitRule
            ? splitText(text, splitRule)
            : [normalizeSplitPart(text)].filter(Boolean);

        return parts.map((part, idx): ScratchpadEntry => ({
            tempId: genTempId(),
            kind: "text",
            target: part,
            displayText: part,
            origin: {
                nodeId: "draft",
                mocPath,
                mocName,
                operation: "copy",
            },
            addedAt: Date.now() + idx,
        }));
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

    async addMany(entries: ScratchpadEntry[], padId?: string): Promise<void> {
        if (entries.length === 0) return;
        const target = padId
            ? this.listPads().find((p) => p.id === padId)
            : this.activePad();
        if (!target) return;
        target.items.unshift(...entries);
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

    toEditableText(entry: ScratchpadEntry): string {
        return entryToMergedText(entry);
    }

    mergeEntries(sourceTempId: string, targetTempId: string): boolean {
        if (!sourceTempId || !targetTempId || sourceTempId === targetTempId) return false;

        let sourcePad: Scratchpad | null = null;
        let targetPad: Scratchpad | null = null;
        let sourceIdx = -1;
        let targetIdx = -1;

        for (const pad of this.listPads()) {
            if (sourceIdx < 0) {
                const idx = pad.items.findIndex((e) => e.tempId === sourceTempId);
                if (idx >= 0) {
                    sourcePad = pad;
                    sourceIdx = idx;
                }
            }
            if (targetIdx < 0) {
                const idx = pad.items.findIndex((e) => e.tempId === targetTempId);
                if (idx >= 0) {
                    targetPad = pad;
                    targetIdx = idx;
                }
            }
        }

        if (!sourcePad || !targetPad || sourceIdx < 0 || targetIdx < 0) return false;

        const source = sourcePad.items[sourceIdx];
        const target = targetPad.items[targetIdx];
        const mergedText = [entryToMergedText(target), entryToMergedText(source)]
            .map(normalizeSplitPart)
            .filter(Boolean)
            .join("\n");
        if (!mergedText) return false;

        const merged: ScratchpadEntry = {
            ...target,
            kind: "text",
            target: mergedText,
            alias: undefined,
            displayText: mergedText,
            origin: {
                ...target.origin,
                operation: target.origin.operation === source.origin.operation ? target.origin.operation : "copy",
            },
            addedAt: Date.now(),
        };

        targetPad.items[targetIdx] = merged;
        sourcePad.items.splice(sourceIdx, 1);
        this.scheduleSave();
        this.notify();
        return true;
    }

    splitTextEntry(tempId: string, rule: ScratchpadSplitRule): number {
        for (const pad of this.listPads()) {
            const idx = pad.items.findIndex((e) => e.tempId === tempId);
            if (idx < 0) continue;

            const entry = pad.items[idx];
            if (entry.kind !== "text") return 0;

            const sourceText = normalizeSplitPart(entry.target || entry.displayText || "");
            const parts = splitText(sourceText, rule);
            if (parts.length <= 1) return 0;

            const entries = parts.map((part, partIdx): ScratchpadEntry => ({
                ...entry,
                tempId: genTempId(),
                target: part,
                displayText: part,
                addedAt: Date.now() + partIdx,
            }));

            pad.items.splice(idx, 1, ...entries);
            this.scheduleSave();
            this.notify();
            return entries.length;
        }

        return 0;
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
