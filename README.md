# 古船模型帆索校准（断网合并版）

船模修复车间断网期间，两位技师各自修改索具；恢复网络后把批次回传，合并到
**模型档案 / 帆索任务 / 校准结论**。

运行：

```bash
npm start
```

访问 `http://localhost:3038`。数据保存在 `data/`：

- `model-rigging-calibration.json`：主库（模型版本、字段来源、任务、墓碑、冲突、校准快照、操作历史）
- `sync-spool.json`：写入失败时保留的现场批次（成功归并后自动删除）

## 合并规则

1. **每笔带操作号、基准版本、来源**：批次 `{batchId, source, ops[]}`，每笔 op 含
   `opId`、`baseVersion`、`type` 及对应负载。页面、统计、校准记录只显示**当前有效**结果，
   并列出**待处理冲突数**。
2. **同号重传沿用首次结果**：相同 `opId` 再次回传（含重试）直接返回首次归并结果，不重复执行；
   相同 `batchId` 整批重传同样幂等。
3. **两边改同一字段保留两份待处理**：两个不同来源都基于同一旧版本改同一字段/同一索位，
   或用同一任务号各自新增索位时，双方的值都保留为冲突选项，不互相覆盖；可在页面逐条
   “采纳”裁决（裁决记录操作号与来源）。
4. **移除/新增不被迟到回传复活**：任务删除写墓碑（tombstone），之后迟到的修改、新增、备注
   一律忽略；任务不存在时迟到的新增/修改也不会凭空复活。
5. **依赖变更使校准结论失效重算**：桅杆数、索具材料、索位（任务增删/改名）任一变化，
   依赖旧版本的校准结论标记为 `stale`（原快照保留可查），并基于当前版本生成新的当前结论。
6. **写入失败保留现场批次**：回传先落独立 spool 文件，再写主库；主库写失败时批次留在
   `/api/sync/pending`，可用 `/api/sync/retry/:batchId`（或原样重发）**按原操作号重试**。
   spool 独立持久化，服务重启后仍在。
7. **旧数据迁移为首版**：没有版本号的旧档案在首次读取时自动迁移为 v1，字段与索位来源标记为
   “旧档迁移”，并生成基线校准结论。

## 回传操作类型

| type | 说明 | 关键负载 |
| --- | --- | --- |
| `item-create` | 断线端建档（落首版 v1） | `itemId`，档案字段或 `fields` |
| `field-update` | 改模型档案字段 | `field`、`value` |
| `task-add` | 新增帆索任务/索位 | `taskId`、`task:{position,tension,status}` |
| `task-update` | 改索位字段 | `taskId`、`field(position/tension/status)`、`value` |
| `task-log` | 追加索位调整备注 | `taskId`、`note` |
| `task-remove` | 移除索位（写墓碑） | `taskId` |
| `calibrate` | 技师记录校准结论 | `note` |

示例：

```bash
curl -X POST http://localhost:3038/api/sync -H 'Content-Type: application/json' -d '{
  "batchId": "B-20260621-east",
  "source": "技师甲-船坞东",
  "ops": [
    {"opId":"op-1001","type":"field-update","itemId":"MR-001","field":"riggingMaterial","value":"尼龙线","baseVersion":1},
    {"opId":"op-1002","type":"task-update","itemId":"MR-001","taskId":"T-1","field":"tension","value":"适中","baseVersion":1}
  ]
}'
```

## 其它接口

- `GET /api/items` / `GET /api/items/:id`：当前有效档案（含版本、字段来源、任务、冲突数、当前校准）
- `GET /api/items/:id/calibrations`：当前结论 + 全部历史快照（含失效的旧结论）
- `GET /api/stats`：状态统计、待处理冲突数、失效校准快照数
- `POST /api/items/:id/conflicts/:cid/resolve`：裁决冲突（`{optionIndex, by}`）
- `GET /api/sync/pending`、`POST /api/sync/retry/:batchId`：现场批次与重试
- `GET /api/history`：全部操作号的归并结果（审计）
- `POST /api/fault` `{on:true/false}`：演练用，模拟主库写入失败（不影响 spool）
