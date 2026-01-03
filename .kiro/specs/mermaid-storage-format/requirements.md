# Requirements Document

## Introduction

本功能旨在将 MOC（Map of Content）笔记的存储格式从当前的自定义列表格式迁移到标准的 Mermaid 图表格式。这将提高可读性、可维护性，并使图形结构更加直观。新格式将完全替代旧格式。

## Glossary

- **MOC**: Map of Content，内容地图，用于组织和连接笔记的结构化文档
- **System**: 指 ZK Navigation 插件系统
- **Parser**: 解析器，负责读取和解析 MOC 文件内容
- **Serializer**: 序列化器，负责将内部数据结构转换为文件格式
- **Node**: 节点，表示 MOC 中的一个笔记条目
- **Edge**: 边，表示节点之间的关系连接
- **Group**: 分组，表示多个节点的逻辑集合
- **Mermaid**: 一种基于文本的图表生成工具

## Requirements

### Requirement 1: 解析 Mermaid 格式的 MOC 文件

**User Story:** 作为用户，我希望系统能够解析 Mermaid 格式的 MOC 文件，以便我可以使用标准的图表语法来组织笔记结构。

#### Acceptance Criteria

1. WHEN 系统读取包含 Mermaid 代码块的 MOC 文件 THEN THE Parser SHALL 正确识别 \`\`\`mermaid 代码块
2. WHEN Parser 解析 Mermaid 图表 THEN THE Parser SHALL 提取所有节点定义（格式：nodeId["[[wikilink]]"]）
3. WHEN Parser 解析 Mermaid 图表 THEN THE Parser SHALL 提取所有边定义（格式：source --> target 或 source -->|label| target）
4. WHEN Parser 解析 Mermaid 图表 THEN THE Parser SHALL 识别 subgraph 定义并提取分组信息
5. WHEN Parser 解析 Mermaid 图表 THEN THE Parser SHALL 从注释中提取扩展元数据（node_positions、groups、edge_curvatures、node_colors）
6. WHEN Mermaid 代码块包含语法错误 THEN THE Parser SHALL 返回描述性错误信息

### Requirement 2: 生成 Mermaid 格式的 MOC 文件

**User Story:** 作为用户，我希望系统能够将内部数据结构序列化为 Mermaid 格式，以便我可以在标准编辑器中查看和编辑图形结构。

#### Acceptance Criteria

1. WHEN 系统保存 MOC 数据 THEN THE Serializer SHALL 生成有效的 Mermaid graph LR 语法
2. WHEN Serializer 生成节点定义 THEN THE Serializer SHALL 使用格式 nodeId["[[wikilink]]"]
3. WHEN Serializer 生成边定义 THEN THE Serializer SHALL 使用格式 source --> target 或 source -->|label| target
4. WHEN 存在分组信息 THEN THE Serializer SHALL 生成 subgraph 块包含相关节点
5. WHEN 存在扩展元数据 THEN THE Serializer SHALL 在注释中保存 node_positions、groups、edge_curvatures 和 node_colors
6. WHEN 生成的 Mermaid 代码 THEN THE Serializer SHALL 添加适当的注释说明各部分的作用

### Requirement 3: 数据完整性验证

**User Story:** 作为开发者，我希望系统能够验证数据转换的正确性，以确保没有信息丢失。

#### Acceptance Criteria

1. WHEN 解析 Mermaid 格式 THEN THE System SHALL 验证所有节点都有有效的 ID
2. WHEN 解析边定义 THEN THE System SHALL 验证源节点和目标节点都存在
3. WHEN 解析分组 THEN THE System SHALL 验证分组中的所有节点 ID 都存在
4. WHEN 序列化数据 THEN THE System SHALL 确保所有节点关系都被正确表示
5. WHEN 执行往返转换（parse → serialize → parse）THEN THE System SHALL 产生等效的数据结构

### Requirement 4: 用户界面集成

**User Story:** 作为用户，我希望能够通过简单的界面操作来使用新格式，而不需要手动编辑代码。

#### Acceptance Criteria

1. WHEN 用户创建新 MOC THEN THE System SHALL 提供 Mermaid 格式模板
2. WHEN 用户保存 MOC 文件 THEN THE System SHALL 自动序列化为 Mermaid 格式
3. WHEN 保存成功 THEN THE System SHALL 显示成功通知
4. WHEN 保存失败 THEN THE System SHALL 显示详细错误信息

### Requirement 5: 性能优化

**User Story:** 作为用户，我希望新格式的解析和渲染速度不低于旧格式，以保持良好的使用体验。

#### Acceptance Criteria

1. WHEN 解析大型 MOC 文件（>100 节点）THEN THE Parser SHALL 在 500ms 内完成
2. WHEN 序列化大型数据结构 THEN THE Serializer SHALL 在 300ms 内完成
3. WHEN 渲染 Mermaid 图表 THEN THE System SHALL 复用现有的渲染逻辑
4. WHEN 频繁切换 MOC 文件 THEN THE System SHALL 缓存解析结果以提高性能
