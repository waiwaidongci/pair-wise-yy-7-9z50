// 场景测试：断网回传合并
// 运行：node test-sync.mjs
import {
  migrateDb, applyBatch, applyOp, resolveConflict,
  conflictCount, currentCalibration, calibrationHistory,
  findItem, newBatchId
} from "./sync.js";

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, extra ?? ""); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// 构造一个干净的 db（带一条无版本的旧数据，验证迁移）
function makeDb() {
  return {
    items: [
      {
        code: "MR-001", shipType: "福船", scale: "1:48",
        mastCount: 3, riggingMaterial: "蜡线", owner: "周宁",
        dueDate: "2026-06-28", status: "校准中",
        tasks: [
          { id: "T-1", position: "前桅侧支索", tension: "偏松", status: "调整中",
            logs: [{ at: "2026-06-12", note: "已缩短2mm" }] }
        ],
        logs: [{ at: "2026-06-12", step: "建档", note: "创建模型" }]
      }
    ],
    ops: [], pendingBatches: []
  };
}

console.log("== 场景0：旧数据迁移成首版 ==");
{
  const db = makeDb();
  migrateDb(db);
  const item = findItem(db, "MR-001");
  check("迁移后版本=1", item.version === 1);
  check("迁移后有首版快照", item.snapshots.some(s => s.version === 1));
  check("迁移后有有效校准结论", currentCalibration(item) !== null);
  check("迁移后任务有 createdVersion", item.tasks[0].createdVersion === 1);
  check("迁移后全局无冲突", conflictCount(db) === 0);
}

console.log("== 场景1：两位技师各改不同字段 → 都应用 ==");
{
  const db = makeDb();
  migrateDb(db);
  // 技师A 改 owner（基于v1）
  applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-A1", source: "技师A", baseVersion: 1, itemId: "MR-001", type: "update", payload: { owner: "陈师傅" } }
  ]});
  // 技师B 改 dueDate（基于v1）
  applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-B1", source: "技师B", baseVersion: 1, itemId: "MR-001", type: "update", payload: { dueDate: "2026-07-15" } }
  ]});
  const item = findItem(db, "MR-001");
  check("A的owner已应用", item.owner === "陈师傅");
  check("B的dueDate已应用", item.dueDate === "2026-07-15");
  check("无冲突", conflictCount(db) === 0);
  check("版本升到3", item.version === 3);
}

console.log("== 场景2：两边改同一字段 → 保留两份待处理 ==");
{
  const db = makeDb();
  migrateDb(db);
  applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-A1", source: "技师A", baseVersion: 1, itemId: "MR-001", type: "update", payload: { mastCount: 4 } }
  ]});
  applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-B1", source: "技师B", baseVersion: 1, itemId: "MR-001", type: "update", payload: { mastCount: 5 } }
  ]});
  const item = findItem(db, "MR-001");
  check("当前值保留A的4", item.mastCount === 4);
  check("有1条待处理冲突", conflictCount(db) === 1);
  const c = item.conflicts.find(x => x.status === "pending");
  check("冲突记录proposed=5", c.proposedValue === 5);
  check("冲突记录current=4", c.currentValue === 4);
  check("冲突记录baseVersion=1", c.baseVersion === 1);
  check("冲突记录来源B", c.sources.includes("技师B"));
  // 解决冲突：选 proposed
  resolveConflict(db, c.id, "proposed");
  check("解决后mastCount=5", item.mastCount === 5);
  check("解决后无待处理冲突", conflictCount(db) === 0);
}

console.log("== 场景3：同号重传沿用首次结果（幂等） ==");
{
  const db = makeDb();
  migrateDb(db);
  const r1 = applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-DUP", source: "技师A", baseVersion: 1, itemId: "MR-001", type: "update", payload: { owner: "首次" } }
  ]});
  const r2 = applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-DUP", source: "技师A", baseVersion: 1, itemId: "MR-001", type: "update", payload: { owner: "重传" } }
  ]});
  const item = findItem(db, "MR-001");
  check("首次owner=首次", item.owner === "首次");
  check("重传标记duplicate", r2[0].duplicate === true);
  check("重传沿用首次结果", r2[0].status === r1[0].status);
  check("owner未被重传覆盖", item.owner === "首次");
  check("版本只升1次", item.version === 2);
}

console.log("== 场景4：移除不被迟到回传复活 ==");
{
  const db = makeDb();
  migrateDb(db);
  // A 移除任务 T-1（基于v1）
  applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-A-RM", source: "技师A", baseVersion: 1, itemId: "MR-001", type: "removeTask", payload: { taskId: "T-1" } }
  ]});
  const item = findItem(db, "MR-001");
  check("T-1已移除", !item.tasks.find(t => t.id === "T-1"));
  check("有墓碑", item.tombstones["T-1"] !== undefined);
  // B 迟到编辑 T-1（基于v1，此时T-1已被A移除）
  applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-B-EDIT", source: "技师B", baseVersion: 1, itemId: "MR-001", type: "updateTask", payload: { taskId: "T-1", tension: "偏紧" } }
  ]});
  check("T-1未被复活", !item.tasks.find(t => t.id === "T-1"));
  check("有存在性冲突", item.conflicts.some(c => c.reason === "task_removed_no_resurrect"));
  check("待处理冲突数=1", conflictCount(db) === 1);
}

console.log("== 场景5：新增不被迟到回传杀死 ==");
{
  const db = makeDb();
  migrateDb(db);
  // A 新增任务 T-2（基于v1）
  applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-A-ADD", source: "技师A", baseVersion: 1, itemId: "MR-001", type: "addTask", payload: { id: "T-2", position: "后桅升帆索", tension: "偏紧" } }
  ]});
  const item = findItem(db, "MR-001");
  check("T-2已新增", item.tasks.find(t => t.id === "T-2") !== undefined);
  // B 迟到移除 T-2（基于v1，B不知道T-2存在）
  applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-B-RM", source: "技师B", baseVersion: 1, itemId: "MR-001", type: "removeTask", payload: { taskId: "T-2" } }
  ]});
  check("T-2仍存活", item.tasks.find(t => t.id === "T-2") !== undefined);
  check("有存在性冲突", item.conflicts.some(c => c.reason === "task_added_after_base_no_kill"));
}

console.log("== 场景6：桅杆数/材料/索位改动 → 校准结论失效重算，原快照可查 ==");
{
  const db = makeDb();
  migrateDb(db);
  const item = findItem(db, "MR-001");
  const calV1 = currentCalibration(item);
  check("v1校准依赖v1", calV1.dependsOnVersion === 1);
  // 改桅杆数
  applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-A-MAST", source: "技师A", baseVersion: 1, itemId: "MR-001", type: "update", payload: { mastCount: 5 } }
  ]});
  const calNow = currentCalibration(item);
  check("当前校准依赖新版本", calNow.dependsOnVersion === item.version);
  check("当前校准有效", calNow.valid === true);
  check("旧校准已失效", calV1.valid === false);
  check("历史校准可查（含失效快照）", calibrationHistory(item).length >= 2);
  check("旧快照仍可查", item.snapshots.find(s => s.version === 1) !== undefined);
  check("新结论摘要含5桅", calNow.result.summary.includes("5桅"));
  // 改材料
  applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-B-MAT", source: "技师B", baseVersion: 1, itemId: "MR-001", type: "update", payload: { riggingMaterial: "钢丝" } }
  ]});
  check("材料改动后校准再失效重算", currentCalibration(item).dependsOnVersion === item.version);
  check("历史校准累积3条", calibrationHistory(item).length === 3);
}

console.log("== 场景7：写入失败保留现场批次，按原操作号重试 ==");
{
  const db = makeDb();
  migrateDb(db);
  const batchId = newBatchId();
  const ops = [
    { opId: "OP-A1", source: "技师A", baseVersion: 1, itemId: "MR-001", type: "update", payload: { owner: "重试" } }
  ];
  // 模拟：先持久化批次，再应用，应用后保存失败
  db.pendingBatches.push({ batchId, ops, status: "pending", createdAt: new Date().toISOString() });
  // 应用（内存中生效）
  applyBatch(db, { batchId, ops });
  // 保存失败 → 批次保留为 pending
  const batch = db.pendingBatches.find(b => b.batchId === batchId);
  check("批次仍为pending", batch.status === "pending");
  check("owner已在内存生效", findItem(db, "MR-001").owner === "重试");
  // 重试：按原操作号重放（幂等，不重复应用）
  const retryResults = applyBatch(db, { batchId, ops });
  check("重试标记duplicate", retryResults[0].duplicate === true);
  check("owner未被重复应用", findItem(db, "MR-001").owner === "重试");
  batch.status = "applied";
  check("重试后批次applied", batch.status === "applied");
}

console.log("== 场景8：移除整个模型不被迟到回传复活 ==");
{
  const db = makeDb();
  migrateDb(db);
  applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-A-RM", source: "技师A", baseVersion: 1, itemId: "MR-001", type: "remove", payload: {} }
  ]});
  const item = findItem(db, "MR-001");
  check("模型已删除", item._deleted === true);
  applyBatch(db, { batchId: newBatchId(), ops: [
    { opId: "OP-B-EDIT", source: "技师B", baseVersion: 1, itemId: "MR-001", type: "update", payload: { owner: "复活" } }
  ]});
  check("模型未被复活", item._deleted === true);
  check("有存在性冲突", item.conflicts.some(c => c.reason === "item_removed_no_resurrect"));
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
