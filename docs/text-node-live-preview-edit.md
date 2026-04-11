# 文本节点编辑期 Live Preview 渲染技术方案

> 状态: 设计阶段 / 待实施
> 范围: `src/renderer/CytoscapeRenderer.ts` 中文本节点 (`isTextOnly`) 的双击编辑流程
> 方案选型: 反射 Obsidian 内部 `MarkdownEditView` 类，封装为可挂载到任意 DOM 的编辑器组件

---

## 1. 背景

### 1.1 现状

文本节点 (`isTextOnly: true`) 的当前编辑流程：

| 阶段 | 视觉 | 实现 |
|---|---|---|
| 非编辑态 | Live Preview 后的 HTML（标题/列表/加粗/wiki-link） | `MarkdownRenderer.render()` 渲染到 `.zk-text-md-overlay` |
| 编辑态 | **纯文本 textarea**（看到的是 Markdown 源码） | `startInPlaceTextEdit()` 在 overlay 内嵌 textarea |

用户痛点：编辑时**看不到所见即所得**——输入 `# 121` 看到的是字面量 `# 121`，而不是 Obsidian 笔记里那种"`#` 缩成行尾标记 + 121 显示成大字号 H1"的实时预览效果。

### 1.2 目标

让文本节点的编辑态与 Obsidian 笔记中的 Live Preview **视觉一致**：

- 输入 `# 标题` → 标题字号变大、`#` 缩成左侧灰色标记
- 输入 `**bold**` → 加粗，`**` 半透明
- 输入 `[[Note]]` → wiki-link 自动补全弹出
- 列表 `- ` 自动续行、Tab 缩进
- 光标所在行展示原始 Markdown 标记，离开行后只显示渲染结果

### 1.3 为什么没法用公开 API

| Obsidian 公开 API | 能做什么 | 不能做什么 |
|---|---|---|
| `MarkdownRenderer.render()` | 渲染 **只读** HTML | 不能编辑、无光标交互 |
| `MarkdownView` | 完整的笔记编辑视图 | 必须绑定一个 `TFile`，依赖 leaf 生命周期 |
| `Editor` 接口 | 获取/设置文本、操作选区 | 没有"独立创建一个编辑器"的入口 |

Obsidian 用于实现 Live Preview 的类是 **`MarkdownEditView`**（内部，未导出），它包装了 CodeMirror 6 + 一组私有装饰器扩展（`livePreviewExtension`、`tableEditor`、`embeddableEditor` 等）。这些都没有 `export`，但实例可以通过反射拿到构造器。

### 1.4 社区先例

下列插件都成功用了"反射 `MarkdownEditView`"方案，长期稳定运行：

- **Hover Editor** —— 在悬浮窗里复用编辑器
- **Inline Encrypter** —— 弹窗内编辑加密内容
- **Better Properties** —— 属性面板的内联富文本编辑
- **Outliner** / **Quick Latex** —— 各种小型嵌入编辑器

社区还沉淀出了一份事实标准的封装代码，叫 `EmbeddableMarkdownEditor`（约 200 行），多个插件直接拷贝复用。本方案按这个范式做。

---

## 2. 技术方案概览

### 2.1 整体结构

```
┌─ CytoscapeRenderer ────────────────────────────────────────┐
│                                                            │
│  textMdOverlayCache (常驻 HTML overlay，渲染只读 MD)       │
│         │                                                  │
│         └─ 双击 → startInPlaceTextEdit()                   │
│                        │                                   │
│                        ├─ A 路径 (旧): 嵌入 <textarea>     │  ← 重命名为 legacy，作 fallback
│                        │                                   │
│                        └─ B 路径 (新): 嵌入                │
│                              EmbeddableMarkdownEditor      │
│                              (内含 Live Preview CM6)        │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 2.2 新增/修改文件

| 文件 | 作用 |
|---|---|
| `src/utils/EmbeddableMarkdownEditor.ts` 🆕 | 反射拿到 `MarkdownEditView`，封装成可挂载到任意 DOM 的编辑器组件 |
| `src/renderer/CytoscapeRenderer.ts` 🛠 | `startInPlaceTextEdit()` 改用新组件；类型导入；销毁逻辑 |
| `styles.css` 🛠 | 编辑期 overlay 的样式约束 (`max-height` / `overflow` / 边框) |
| `manifest.json` 🛠（可选） | 在 `description` 中标注"使用 Obsidian 内部 API"，便于审计 |

---

## 3. 实现细节

### 3.1 模块 1：`EmbeddableMarkdownEditor.ts`

#### 3.1.1 反射拿到内部类

Obsidian 注册了一个 embed registry，markdown 类型的 embed creator 内部会实例化一个 `MarkdownEditView` 子类。我们用一次性反射拿到构造器：

```ts
import { App, Component, MarkdownView, TFile } from 'obsidian';

let _MarkdownEditViewCtor: any = null;

function resolveMarkdownEditViewCtor(app: App): any {
    if (_MarkdownEditViewCtor) return _MarkdownEditViewCtor;

    // 方式 1：通过任意一个已存在的 MarkdownView 拿到 editMode 实例
    const mdLeaves = app.workspace.getLeavesOfType('markdown');
    for (const leaf of mdLeaves) {
        const view = leaf.view as MarkdownView;
        const editMode = (view as any).editMode ?? (view as any).modes?.source;
        if (editMode) {
            _MarkdownEditViewCtor = Object.getPrototypeOf(editMode).constructor;
            return _MarkdownEditViewCtor;
        }
    }

    // 方式 2 兜底：通过 embedRegistry（无现成 MarkdownView 时）
    const embedRegistry = (app as any).embedRegistry;
    const mdCreator = embedRegistry?.embedByExtension?.md;
    if (mdCreator) {
        const dummy = document.createElement('div');
        const sample = mdCreator({ app, containerEl: dummy }, null, '');
        const editMode = sample?.editMode ?? sample;
        if (editMode) {
            _MarkdownEditViewCtor = Object.getPrototypeOf(editMode).constructor;
            try { sample?.unload?.(); } catch {}
        }
    }

    return _MarkdownEditViewCtor;
}
```

要点：

- **结果缓存**到模块级变量，整个插件生命周期只反射一次
- 两种探测路径互为兜底，提升对不同 Obsidian 版本的鲁棒性
- 找不到时返回 `null`，调用方降级回 `<textarea>`

#### 3.1.2 编辑器封装类

```ts
export interface EmbeddableMarkdownEditorOptions {
    app: App;
    containerEl: HTMLElement;
    initialValue: string;
    sourcePath?: string;        // 用于解析 [[wiki link]] 的相对路径
    placeholder?: string;
    onChange?: (value: string) => void;
    onEnter?: (value: string, evt: KeyboardEvent) => boolean; // 返回 true 阻止换行
    onEscape?: (evt: KeyboardEvent) => void;
    onBlur?: (value: string) => void;
}

export class EmbeddableMarkdownEditor extends Component {
    private editView: any;       // MarkdownEditView 实例
    private cm: any;             // CodeMirror EditorView
    private opts: EmbeddableMarkdownEditorOptions;
    private destroyed = false;

    constructor(opts: EmbeddableMarkdownEditorOptions) {
        super();
        this.opts = opts;
        this.mount();
    }

    private mount() {
        const Ctor = resolveMarkdownEditViewCtor(this.opts.app);
        if (!Ctor) {
            throw new Error('MarkdownEditView constructor not found');
        }

        // 构造一个最小化的 "owner"，模仿 MarkdownView 的接口表面
        const owner = {
            app: this.opts.app,
            file: null as TFile | null,
            getMode: () => 'source' as const,
            getViewType: () => 'markdown',
            // 必须的 hook 方法
            onMarkdownScroll: () => {},
            getFoldInfo: () => null,
            applyFoldInfo: () => {},
            // sourcePath 用于 wiki-link 解析
            getDisplayText: () => '',
            // ...按运行时报错逐项补齐
        };

        this.editView = new Ctor(owner, this.opts.containerEl, this);
        this.editView.set(this.opts.initialValue ?? '', true); // (data, clear)

        // 取得底层 CodeMirror EditorView，用于绑定回调和扩展
        this.cm = this.editView.editor?.cm ?? this.editView.cm;
        this.bindCallbacks();
    }

    private bindCallbacks() {
        const cm = this.cm;
        if (!cm) return;

        // 1) 内容变化
        // 通过 cm.dom 上的 'input' 事件做兜底监听
        cm.dom.addEventListener('input', () => {
            this.opts.onChange?.(this.getValue());
        });

        // 2) Enter / Escape 拦截
        cm.dom.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey && this.opts.onEnter) {
                if (this.opts.onEnter(this.getValue(), e)) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            } else if (e.key === 'Escape' && this.opts.onEscape) {
                this.opts.onEscape(e);
            }
        }, true);

        // 3) Blur
        cm.dom.addEventListener('focusout', (e: FocusEvent) => {
            // 延迟：避免误判内部点击（如 link suggester）
            setTimeout(() => {
                if (this.destroyed) return;
                if (this.opts.containerEl.contains(document.activeElement)) return;
                this.opts.onBlur?.(this.getValue());
            }, 50);
        });
    }

    getValue(): string {
        return this.editView?.get?.() ?? '';
    }

    setValue(v: string) {
        this.editView?.set?.(v, true);
    }

    focus() {
        try { this.cm?.focus?.(); } catch {}
    }

    onunload() {
        this.destroyed = true;
        try { this.editView?.destroy?.(); } catch {}
        try { this.editView?.unload?.(); } catch {}
        this.editView = null;
        this.cm = null;
    }
}
```

#### 3.1.3 已知的反射陷阱

实际写代码时，`new Ctor(owner, container, this)` 会因为 `owner` 缺方法而抛错。**调试策略**：

1. 第一次跑出来 `TypeError: owner.xxx is not a function`
2. 在 `owner` 上加 `xxx() {}`
3. 重复 2-5 次，直到能稳定 mount
4. 把所有补的方法注释 `// stub for MarkdownEditView` 标记好

社区版 `EmbeddableMarkdownEditor` 已经把这些 stub 收齐了，可以直接参考 GitHub 上 **Inline Encrypter** 或 **Better Properties** 仓库里的同名文件，省下试错时间。

---

### 3.2 模块 2：`CytoscapeRenderer.ts` 改造

#### 3.2.1 `startInPlaceTextEdit()` 改写

原 textarea 实现整段替换为：

```ts
private startInPlaceTextEdit(
    node: any,
    originalNode: ZKNode,
    entry: TextOverlayEntry
): void {
    if (!this.cy || !this.container) return;
    this.ensureNodeVisibleInViewport(node);

    const overlayEl = entry.el;
    const savedHtml = overlayEl.innerHTML;
    const savedWidth = entry.width;
    const savedHeight = entry.height;
    const rawSource = (originalNode.title || '').replace(/\\n/g, '\n');

    overlayEl.textContent = '';
    overlayEl.dataset.editing = '1';
    const prevPointerEvents = overlayEl.style.pointerEvents;
    overlayEl.style.pointerEvents = 'auto';

    // 给编辑器一个独立挂载容器，方便回滚
    const editorHost = document.createElement('div');
    editorHost.className = 'zk-text-md-live-edit-host';
    editorHost.style.cssText = `
        position: absolute;
        inset: 0;
        border: 2px solid rgba(91, 143, 217, 0.95);
        border-radius: 12px;
        overflow: auto;
        background: var(--background-primary);
    `;
    overlayEl.appendChild(editorHost);

    let isSaved = false;
    let mdEditor: EmbeddableMarkdownEditor | null = null;
    const sourcePath = this.currentData?.metadata?.currentFile || '';

    // 容错：反射失败 → 降级回旧 textarea
    try {
        mdEditor = new EmbeddableMarkdownEditor({
            app: (window as any).app,
            containerEl: editorHost,
            initialValue: rawSource,
            sourcePath,
            onChange: () => autoGrow(),
            onEnter: (value, evt) => {
                if (evt.shiftKey) return false; // Shift+Enter 换行
                if (evt.metaKey || evt.ctrlKey) {
                    saveEdit();
                    return true;
                }
                return false; // 普通 Enter 在 Live Preview 里换行/续列表
            },
            onEscape: () => cancelEdit(),
            onBlur: () => { if (!isSaved) saveEdit(); },
        });
        // 把引用挂到 editorHost 上，便于销毁路径查找
        (editorHost as any)._mdEditor = mdEditor;
        mdEditor.focus();
    } catch (err) {
        console.warn('[ZK] Live preview unavailable, falling back to textarea', err);
        editorHost.remove();
        // 调用旧 textarea 实现（保留作为 fallback）
        this.startInPlaceTextEditLegacy(node, originalNode, entry);
        return;
    }

    // 自动增长：监听 editorHost 的 contentRect
    const ro = new ResizeObserver(() => autoGrow());
    ro.observe(editorHost);

    const autoGrow = () => {
        if (!this.cy || node.removed()) return;
        const contentH = editorHost.scrollHeight;
        const newH = Math.max(savedHeight, Math.min(contentH + 8, 720));
        if (newH !== entry.height) {
            entry.height = newH;
            this.cy.batch(() => {
                node.data('manualHeightModel', newH);
                node.style({ height: newH });
            });
        }
    };

    const saveEdit = () => {
        if (isSaved) return;
        const newValue = (mdEditor?.getValue() ?? '').trim();
        if (!newValue) { cancelEdit(); return; }
        isSaved = true;
        ro.disconnect();
        mdEditor?.unload();
        mdEditor = null;

        const nodePosition = node.position();
        this.container?.dispatchEvent(new CustomEvent('node-inline-edit-save', {
            detail: {
                node: originalNode,
                content: newValue,
                position: { x: nodePosition.x, y: nodePosition.y }
            }
        }));

        // 内容未变化兜底：50ms 后若 overlay 仍在编辑态，恢复原 HTML
        setTimeout(() => {
            if (overlayEl.isConnected && overlayEl.dataset.editing === '1') {
                overlayEl.innerHTML = savedHtml;
                delete overlayEl.dataset.editing;
                overlayEl.style.pointerEvents = prevPointerEvents || 'none';
            }
        }, 50);
    };

    const cancelEdit = () => {
        if (isSaved) return;
        isSaved = true;
        ro.disconnect();
        mdEditor?.unload();
        mdEditor = null;
        overlayEl.innerHTML = savedHtml;
        delete overlayEl.dataset.editing;
        overlayEl.style.pointerEvents = prevPointerEvents || 'none';
        // 恢复尺寸
        if (this.cy && !node.removed()) {
            entry.width = savedWidth;
            entry.height = savedHeight;
            this.cy.batch(() => {
                node.data('manualWidthModel', savedWidth);
                node.data('manualHeightModel', savedHeight);
                node.style({ width: savedWidth, height: savedHeight });
            });
        }
    };
}
```

#### 3.2.2 旧 textarea 路径作为 fallback 保留

把当前的 `startInPlaceTextEdit()` 重命名为 `startInPlaceTextEditLegacy()`，**保留**完整逻辑。当 `EmbeddableMarkdownEditor` 反射失败（例如 Obsidian 大版本升级破坏了内部 API）时自动降级。

这样升级失败不会让用户完全无法编辑，只是退回到当前的 textarea 体验。

#### 3.2.3 销毁路径

`destroy()` 方法里，遍历 `textMdOverlayCache`，对每个 entry：

- 调用 `entry.component.unload()`（已有）
- 检查 `entry.el.dataset.editing` —— 若为 `1`，说明编辑器正活着，强制 unload 当前 `EmbeddableMarkdownEditor`

```ts
this.textMdOverlayCache.forEach(entry => {
    // 编辑期残留的 live-edit-host
    const liveHost = entry.el.querySelector('.zk-text-md-live-edit-host') as any;
    if (liveHost && liveHost._mdEditor) {
        try { liveHost._mdEditor.unload(); } catch {}
    }
    try { entry.component.unload(); } catch {}
    if (entry.el.parentNode) entry.el.remove();
});
```

为了让上面的查找成立，在创建时把 `mdEditor` 引用挂到 `editorHost._mdEditor`（已包含在 3.2.1 的代码示例里）。

---

### 3.3 模块 3：样式（`styles.css`）

```css
/* 编辑期容器 */
.zk-text-md-overlay[data-editing="1"] {
    pointer-events: auto;
    user-select: text;
    overflow: visible; /* 让 link suggester 可以溢出节点 */
}

/* 让 cm-editor 撑满 host 而不是用默认 min-height */
.zk-text-md-live-edit-host .cm-editor {
    height: 100%;
    background: transparent;
}
.zk-text-md-live-edit-host .cm-scroller {
    font-family: var(--font-text);
    font-size: 14px;
    line-height: 1.5;
}
.zk-text-md-live-edit-host .cm-content {
    padding: 8px 12px;
}
```

---

### 3.4 模块 4：MOC 数据回写

**完全无需改动**。`saveEdit()` 触发的 `node-inline-edit-save` 事件已经由 `indexView.ts` 接管：

1. `indexView.ts` 收到 → `saveNodeContent()` → `MOCHandler.modifyMOCData()`
2. MOC 文件被改写 → `vault.modify` 触发 `refreshIndexGraph`
3. 整张图重建 → `buildTextMarkdownOverlays()` 重新跑 → 缓存命中或重渲染
4. 新内容以**只读 Live Preview** 形态再次出现

唯一要确认的是：换行编码 `\n ↔ \\n` 在 `saveNodeContent()` 里已经做了（之前的工作里验证过），所以 Live Preview 编辑器输出的真实换行能被正确序列化进 Mermaid。

---

## 4. 边界情况与风险

| 风险点 | 触发场景 | 缓解 |
|---|---|---|
| **Obsidian 升级破坏反射** | 大版本改 `MarkdownEditView` 类名/位置 | Fallback 到 legacy textarea；插件正常运行不中断 |
| **多节点同时编辑** | 用户点开 A 后又点开 B | `existingEditor` 检查（已有），保证只活一个 |
| **CM6 焦点丢失误判** | 点 link suggester 弹层时被判定为 blur | `onBlur` 用 50ms 延迟 + 检查 `containerEl.contains(activeElement)` |
| **编辑器尺寸抖动** | autoGrow 频繁触发 → cy.batch → rAF → 再次测量 | 用 `entry.height !== newH` 守卫；ResizeObserver 自带防抖 |
| **wiki-link 跳转误开 leaf** | Cmd+Click 链接 | Live Preview 默认行为正确，不需要拦截 |
| **撤销 Cmd+Z 冲突** | CM6 自己有 undo，与插件全局 undo 系统冲突 | 编辑期 stopPropagation `Cmd+Z` 给 cm；保存后才进入插件 undo 栈 |
| **MutationObserver 副作用** | 项目里有 MutationObserver 监听 DOM 变化 | `exportMode` 已有跳过逻辑，编辑期复用 |
| **Canvas 文字与 cm-content 重叠** | overlay 半透明时 cytoscape canvas label 会透出 | 编辑期为节点临时设 `text-opacity: 0`，退出编辑恢复 |
| **性能** | CM6 实例化约 50-100ms，单节点编辑期一次性开销 | 可接受；不预热 |

---

## 5. 实施步骤（建议顺序）

> 不是工时估算，而是最小风险路径。

1. **写 `EmbeddableMarkdownEditor.ts`** —— 单独建文件，跑一个最小 demo（在 plugin onload 里 mount 到一个临时 div 看效果），确认反射通路工作
2. **跑通 stub 补齐流程** —— 把所有 owner 缺失方法补上，直到 `editor.set('# hello', true)` 后能看到 H1 渲染
3. **接入 CytoscapeRenderer 但走开关** —— 加一个 `settings.enableLivePreviewEdit`，默认 `false`，开关开启时走新路径
4. **手动验证 5 个关键场景**：
   - 输入 `# 标题` 看到 Live Preview 效果
   - 输入 `[[` 触发 wiki-link suggester
   - 列表续行（`- ` 换行后自动 `- `）
   - Cmd+Enter 保存、Esc 取消
   - 拖拽节点时编辑器位置正确跟随
5. **降级路径测试** —— 临时把反射函数返回 `null`，确认 fallback 到 legacy textarea
6. **资源泄漏检测** —— 编辑 → 保存 → 切换 MOC 文件 → 检查 `document.querySelectorAll('.cm-editor').length` 应该归零
7. **去掉开关，默认启用**；保留 `settings.disableLivePreviewEdit` 作为应急回滚开关

---

## 6. 验证清单

- [ ] `npm run build` 通过
- [ ] 输入 `# H1`、`## H2`、`**bold**`、`*italic*`、`==高亮==` 都有正确的 Live Preview 视觉
- [ ] `[[` 弹出 Obsidian 原生的 wiki-link suggester，可选择文件
- [ ] `- ` 列表 + Enter 自动续行；Tab 缩进；Shift+Tab 反缩进
- [ ] Cmd+Enter 保存；Esc 取消还原
- [ ] 编辑期节点高度跟随内容自动增长（最大 720）
- [ ] 编辑期可拖动节点位置时编辑器跟随
- [ ] 编辑期 zoom 时编辑器同步缩放
- [ ] 切换 MOC 文件后无 `cm-editor` DOM 残留
- [ ] 反射失败时降级到 legacy textarea，无报错
- [ ] Cmd+Z 在编辑期作用于 CM6，退出编辑后作用于插件全局 undo

---

## 7. 关键决策点

| # | 决策 | 当前选择 |
|---|---|---|
| 1 | 是否接受私有 API 反射的长期维护成本 | ✅ 接受（升级 Obsidian 时可能要修反射点） |
| 2 | 是否保留 legacy textarea 作为 fallback | ✅ 保留 |
| 3 | 是否需要 settings 开关 | 上线初期保留，稳定后删掉 |
| 4 | 保存触发键 | Cmd+Enter（与现有保持一致） |
| 5 | 是否同步给 embed 节点用 | ❌ 暂不（embed 编辑更适合纯 link 输入） |

---

## 8. 关键文件速查

| 作用 | 文件 | 行号 |
|---|---|---|
| 现有 `startInPlaceTextEdit` | `src/renderer/CytoscapeRenderer.ts` | 6425 |
| 现有 `buildTextMarkdownOverlays` | `src/renderer/CytoscapeRenderer.ts` | 4263 |
| 现有 overlay 位置 updater | `src/renderer/CytoscapeRenderer.ts` | 4371 |
| `textMdOverlayCache` 字段 | `src/renderer/CytoscapeRenderer.ts` | ~104 |
| 新增编辑器封装 | `src/utils/EmbeddableMarkdownEditor.ts` | 🆕 |
| 编辑期样式 | `styles.css` | 文件末尾追加 |
| MOC 保存事件接收 | `src/view/indexView.ts` (`saveNodeContent`) | ~3753 |

---

## 一句话总结

> **把 Obsidian 内部的 `MarkdownEditView` 反射出来封成一个 `EmbeddableMarkdownEditor` 组件，编辑文本节点时把它挂在已有的 MD overlay 里，保存时通过现有事件回写 MOC——核心改动一个新文件 + `startInPlaceTextEdit` 改写 + 旧路径保留作降级。**
