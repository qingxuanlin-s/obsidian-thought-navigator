# TODO / Nice-to-have

> llm-wiki 实战中发现的插件改进点。已解决的不再列。

## 低优先(nice-to-have)

- **原子 reparent API(保 ID + 保关系)** —— 把节点/子树移到新父时,当前只能 `deleteNode` + `addNodes` 重建,代价是被移动子树的 nodeID 漂移、其身上的关系边要手动重连。一个原子的"移动/重定父"方法可省掉这两点。
  非阻塞:delete+add 已能覆盖功能,只是不够干净。

## 已解决(留档)

- ~~草稿边(创造性横向关系走审批)~~ → `addDraftRelations` 已加,草稿节点+草稿边共用同一审批操作条。
- ~~重排须整树 overwrite~~ → `deleteNode` 已加,重排改用 delete+add 局部重接,不必 overwrite。
