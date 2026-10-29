# 图谱主题与风格

明暗模式和视觉风格是两个独立维度。视图先通过 `resolveThemeMode()` 解析 `auto`，渲染层接收明确的 `light` 或 `dark`。

- `src/renderer/theme.ts`：主题类型、`GRAPH_STYLES` 注册表和统一解析入口。
- `src/renderer/themes/base.ts`：默认明暗配色，现代风格复用这些配色。
- `src/renderer/themes/nebula.ts`：星云配色、各明暗模式的视觉参数，以及星云专属 Canvas 规则。
- `src/renderer/themes/appearance.ts`：分支配色策略和 HTML 预览卡片的普通、选中表现。
- `src/renderer/colorMath.ts`：独立的颜色计算，不依赖视图或主题注册表。
- `src/renderer/stylesheet.ts`：通用节点尺寸、结构和交互规则，通过注册表插入风格规则。
- `styles.css`：容器、工具栏、Markdown 内容层及缩略图的风格变量和布局。

## 调用约定

`getGraphTheme(options)` 提供明暗配色；`getGraphStyle(options)` 提供风格的分支、预览、早期规则和最终规则。未知风格回退到现代风格。

`applyViewTheme(element, options)` 清理上一套明暗/风格类，再应用新组合。主视图、局部图谱和 PNG 导出统一使用此入口，不在视图中判断 `themeStyle === 'nebula'`。

Canvas 和 HTML 内容层分别绘制，但文字颜色必须来自插件主题；显式深色模式不能继续继承宿主浅色界面的深色文字。星云深色的内容、链接、代码、选中态和缩略导航在插件容器内定义，不改动 Obsidian 全局主题。

## 新增风格

1. 增加风格的明暗配色与专属规则模块，复用通用尺寸和交互规则。
2. 在 `RenderOptions.themeStyle` 的类型及设置选项中声明名称。
3. 在 `GRAPH_STYLES` 登记配色、分支策略、预览策略、早期和最终规则。
4. 增加容器 CSS 变量和必要的 DOM 表现。
5. 验证明暗组合、普通/选中状态、预览、宿主主题与插件模式不一致的场景。

数据判断（如节点是否有自定义颜色）留在规则函数中；风格选择集中在注册表，避免重新散落到渲染器和视图。
