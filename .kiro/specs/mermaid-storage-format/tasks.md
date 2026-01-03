# Implementation Plan: Mermaid Storage Format

## Overview

本实现计划将 MOC 存储格式从自定义列表格式迁移到 Mermaid 图表格式。实现将分为解析器、序列化器、集成和测试四个主要部分。

## Tasks

- [x] 1. 创建 MermaidParser 类
  - 实现 Mermaid 格式解析器
  - 创建文件：`src/utils/mermaidParser.ts`
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 1.1 实现 extractMermaidBlock 方法
  - 识别和提取 \`\`\`mermaid 代码块
  - 处理多个代码块的情况
  - _Requirements: 1.1_

- [x] 1.2 实现 parseNode 方法
  - 解析节点定义：`nodeId["[[wikilink]]"]`
  - 提取节点 ID 和 Wiki 链接
  - 验证节点 ID 格式
  - _Requirements: 1.2_

- [x] 1.3 实现 parseEdge 方法
  - 解析边定义：`source --> target` 和 `source -->|label| target`
  - 提取源节点、目标节点和标签
  - _Requirements: 1.3_

- [x] 1.4 实现 parseSubgraph 方法
  - 识别 subgraph 块
  - 提取分组 ID、标签和包含的节点
  - 处理嵌套的 subgraph
  - _Requirements: 1.4_

- [x] 1.5 实现 parseMetadata 方法
  - 解析元数据注释：`%% ext:{JSON} %%`
  - 提取 node_positions、groups、edge_curvatures、node_colors
  - 验证 JSON 格式
  - _Requirements: 1.5_

- [x] 1.6 实现 parse 主方法
  - 整合所有解析方法
  - 构建 MOCParseResult
  - 实现错误处理和验证
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 3.1, 3.2, 3.3_

- [ ]* 1.7 编写 MermaidParser 单元测试
  - 测试空文件、只有节点、只有边、包含分组、包含元数据的情况
  - 测试各种语法错误
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [ ]* 1.8 编写 Property 1 测试：Mermaid 代码块识别
  - **Property 1: Mermaid 代码块识别**
  - **Validates: Requirements 1.1**

- [ ]* 1.9 编写 Property 2 测试：完整元素解析
  - **Property 2: 完整元素解析**
  - **Validates: Requirements 1.2, 1.3, 1.4, 1.5**

- [ ]* 1.10 编写 Property 3 测试：错误处理
  - **Property 3: 错误处理**
  - **Validates: Requirements 1.6**

- [ ]* 1.11 编写 Property 7 测试：节点 ID 验证
  - **Property 7: 节点 ID 验证**
  - **Validates: Requirements 3.1**

- [ ]* 1.12 编写 Property 8 测试：边引用验证
  - **Property 8: 边引用验证**
  - **Validates: Requirements 3.2**

- [ ]* 1.13 编写 Property 9 测试：分组引用验证
  - **Property 9: 分组引用验证**
  - **Validates: Requirements 3.3**

- [x] 2. 创建 MermaidSerializer 类
  - 实现 Mermaid 格式序列化器
  - 创建文件：`src/utils/mermaidSerializer.ts`
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [x] 2.1 实现 serializeNode 方法
  - 生成节点定义：`nodeId["[[wikilink]]"]`
  - 处理特殊字符转义
  - _Requirements: 2.2_

- [x] 2.2 实现 serializeEdge 方法
  - 生成边定义：`source --> target` 或 `source -->|label| target`
  - 处理标签中的特殊字符
  - _Requirements: 2.3_

- [x] 2.3 实现 serializeSubgraph 方法
  - 生成 subgraph 块
  - 包含 direction TB 指令
  - 正确缩进节点定义
  - _Requirements: 2.4_

- [x] 2.4 实现 serializeMetadata 方法
  - 生成元数据注释：`%% ext:{JSON} %%`
  - 序列化 node_positions、groups、edge_curvatures、node_colors
  - _Requirements: 2.5_

- [x] 2.5 实现 serialize 主方法
  - 整合所有序列化方法
  - 生成完整的 Mermaid 代码
  - 添加注释说明各部分
  - 确保正确的顺序：根节点 → 分组 → 末端节点 → 边 → 元数据
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.4_

- [ ]* 2.6 编写 MermaidSerializer 单元测试
  - 测试空数据、单个节点、简单树、包含分组、包含元数据的情况
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [ ]* 2.7 编写 Property 4 测试：有效 Mermaid 语法生成
  - **Property 4: 有效 Mermaid 语法生成**
  - **Validates: Requirements 2.1**

- [ ]* 2.8 编写 Property 5 测试：正确格式序列化
  - **Property 5: 正确格式序列化**
  - **Validates: Requirements 2.2, 2.3, 2.4**

- [ ]* 2.9 编写 Property 6 测试：元数据保留
  - **Property 6: 元数据保留**
  - **Validates: Requirements 2.5**

- [ ]* 2.10 编写 Property 10 测试：关系完整性
  - **Property 10: 关系完整性**
  - **Validates: Requirements 3.4**

- [x] 3. Checkpoint - 确保解析器和序列化器测试通过
  - 确保所有测试通过，如有问题请询问用户

- [x] 4. 集成到现有系统
  - 更新 parseMOCStructure 函数使用 MermaidParser
  - 创建 saveMOCStructure 函数
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 4.1 更新 parseMOCStructure 函数
  - 在 `src/utils/utils.ts` 中更新函数
  - 使用 MermaidParser 解析 Mermaid 格式
  - 保持函数签名不变
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 4.2 创建 saveMOCStructure 函数
  - 在 `src/utils/utils.ts` 中创建新函数
  - 使用 MermaidSerializer 序列化数据
  - 实现 replaceHeadingContent 辅助函数
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 4.2_

- [x] 4.3 集成保存功能到 CytoscapeRenderer
  - 在 `src/renderer/CytoscapeRenderer.ts` 中添加保存逻辑
  - 当用户移动节点或修改分组时自动保存
  - 使用防抖避免频繁保存
  - _Requirements: 4.2_

- [x] 4.4 添加成功/失败通知
  - 保存成功时显示通知
  - 保存失败时显示详细错误信息
  - _Requirements: 4.3, 4.4_

- [ ]* 4.5 编写集成测试
  - 测试完整的读取-保存流程
  - 测试 UI 通知显示
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ]* 4.6 编写 Property 11 测试：往返一致性
  - **Property 11: 往返一致性（Round-trip）**
  - **Validates: Requirements 3.5**

- [ ]* 4.7 编写 Property 13 测试：自动序列化
  - **Property 13: 自动序列化**
  - **Validates: Requirements 4.2**

- [x] 5. 创建 MOC 模板功能
  - 提供 Mermaid 格式的 MOC 模板
  - _Requirements: 4.1_

- [x] 5.1 创建模板生成函数
  - 在 `src/utils/utils.ts` 中创建 createMOCTemplate 函数
  - 生成基本的 Mermaid 格式模板
  - 包含示例节点、边和注释
  - _Requirements: 4.1_

- [x] 5.2 集成模板到 UI
  - 在创建新 MOC 时使用模板
  - 提供模板选择选项（如果有多个模板）
  - _Requirements: 4.1_

- [ ]* 5.3 编写 Property 12 测试：模板有效性
  - **Property 12: 模板有效性**
  - **Validates: Requirements 4.1**

- [x] 6. Checkpoint - 确保集成测试通过
  - 确保所有测试通过，如有问题请询问用户

- [x] 7. 性能优化和测试
  - 实现性能优化措施
  - 编写性能测试
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 7.1 实现解析缓存
  - 缓存解析结果避免重复解析
  - 使用文件修改时间作为缓存键
  - _Requirements: 5.4_

- [x] 7.2 优化正则表达式
  - 预编译正则表达式
  - 使用更高效的匹配策略
  - _Requirements: 5.1, 5.2_

- [ ]* 7.3 编写性能测试
  - 测试大型文件（100+ 节点）的解析性能
  - 测试大型数据结构的序列化性能
  - 测试缓存效果
  - _Requirements: 5.1, 5.2, 5.4_

- [x] 8. 最终验证和文档
  - 确保所有功能正常工作
  - 更新相关文档

- [x] 8.1 手动测试完整流程
  - 创建新 MOC 文件
  - 添加节点、边、分组
  - 保存并重新加载
  - 验证数据完整性

- [x] 8.2 更新用户文档
  - 在 README.md 中添加 Mermaid 格式说明
  - 提供示例和最佳实践

- [x] 8.3 更新开发者文档
  - 在 docs/ 目录中添加技术文档
  - 说明解析器和序列化器的工作原理

- [x] 9. Final checkpoint - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户

## Notes

- 任务标记 `*` 的为可选任务，可以跳过以加快 MVP 开发
- 每个任务都引用了具体的需求以便追溯
- Checkpoint 任务确保增量验证
- 属性测试验证通用正确性属性
- 单元测试验证特定示例和边缘情况
- 使用 fast-check 库进行属性测试
- 每个属性测试运行 100 次迭代
