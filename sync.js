// 断网回传合并引擎
// 每笔操作带：操作号(opId)、基准版本(baseVersion)、来源(source)
// 核心规则：
//   1. 同号重传沿用首次结果（幂等）
//   2. 两边基于同一版本改同一字段 → 保留两份待处理（冲突）
//   3. 移除/新增不被迟到回传复活（墓碑 + 存在性冲突）
//   4. 桅杆数 / 索具材料 / 索位改动 → 依赖旧版本的校准结论失效重算，原快照仍可查

// ---------- 校准 ----------
const materialFactors = { "蜡线": 1.0, "尼龙": 1.2, "钢丝": 0.8, "麻绳": 0.9 };

// 校准结论只依赖三样：桅杆数、索具材料、索位
export function computeCalibration(item) {
  const positions = (item.tasks || []).map(t => t.position).filter(Boolean);
  const positionSet = [...new Set(positions)];
  const mastCount = Number(item.mastCount) || 0;
  const material = item.riggingMaterial || "蜡线";
  const factor = materialFactors[material] ?? 1.0;
  const recommendedTension = Math.round(mastCount * 10 * factor + positionSet.length * 2);
  return {
    summary: `${mastCount}桅·${material}·${positionSet.length}处索位，建议配重${recommendedTension}g`,
    recommendedTension,
    factors: { mastCount, riggingMaterial: material, positions: positionSet, factor }
  };
}

// ---------- ID 生成 ----------
let counter = 0;
const seq = () => ++counter;
export const newId = () => "MR-" + Date.now() + "-" + seq();
export const newConflictId = () => "CONF-" + Date.now() + "-" + seq();
export const newCalId = () => "CAL-" + Date.now() + "-" + seq();
export const newBatchId = () => "BATCH-" + Date.now() + "-" + seq();

// ---------- 快照 ----------
// 只保留与冲突判定 / 校准相关的核心字段，避免快照无限膨胀
export function snapshotData(item) {
  return {
    code: item.code,
    shipType: item.shipType,
    scale: item.scale,
    mastCount: item.mastCount,
    riggingMaterial: item.riggingMaterial,
    owner: item.owner,
    dueDate: item.dueDate,
    status: item.status,
    tasks: (item.tasks || []).map(t => ({
      id: t.id, position: t.position, tension: t.tension, status: t.status
    }))
  };
}

export function getFieldAtVersion(item, field, version) {
  const snap = (item.snapshots || []).find(s => s.version === version);
  return snap ? snap.data[field] : undefined;
}

export function getTaskFieldAtVersion(item, taskId, field, version) {
  const snap = (item.snapshots || []).find(s => s.version === version);
  const task = snap?.data?.tasks?.find(t => t.id === taskId);
  return task ? task[field] : undefined;
}

export function bumpVersion(item, op) {
  item.version += 1;
  item.snapshots = item.snapshots || [];
  item.snapshots.push({
    version: item.version,
    at: new Date().toISOString(),
    data: snapshotData(item),
    opId: op?.opId || null
  });
}

// ---------- 校准结论失效重算 ----------
export function recalibrate(item, op) {
  const result = computeCalibration(item);
  // 依赖旧版本的结论全部失效
  for (const c of (item.calibrations || [])) c.valid = false;
  const cal = {
    id: newCalId(),
    dependsOnVersion: item.version,
    valid: true,
    result,
    inputs: {
      mastCount: item.mastCount,
      riggingMaterial: item.riggingMaterial,
      positions: (item.tasks || []).map(t => t.position).filter(Boolean)
    },
    createdAt: new Date().toISOString(),
    opId: op?.opId || null
  };
  item.calibrations = item.calibrations || [];
  item.calibrations.push(cal);
  return cal;
}

// ---------- 冲突记录 ----------
function recordFieldConflict(item, { kind, field, taskId, baseVersion, currentValue, proposedValue, source, opId }) {
  item.conflicts = item.conflicts || [];
  item.conflicts.push({
    id: newConflictId(),
    kind, field, taskId: taskId || null,
    baseVersion, currentValue, proposedValue,
    sources: [source],
    status: "pending",
    createdAt: new Date().toISOString(),
    opId
  });
}

function recordExistenceConflict(item, { kind, targetKind, targetId, reason, baseVersion, source, opId }) {
  item.conflicts = item.conflicts || [];
  item.conflicts.push({
    id: newConflictId(),
    kind: "existence",
    targetKind, targetId, reason,
    baseVersion,
    sources: [source],
    status: "pending",
    createdAt: new Date().toISOString(),
    opId
  });
}

// ---------- 迁移：旧数据没有版本 → 首版 ----------
export function migrateItem(item) {
  if (item.version == null) {
    item.version = 1;
    item.snapshots = item.snapshots || [];
    item.conflicts = item.conflicts || [];
    item.calibrations = item.calibrations || [];
    item.tombstones = item.tombstones || {};
    item.createdVersion = 1;
    for (const t of (item.tasks || [])) {
      if (t.createdVersion == null) t.createdVersion = 1;
    }
    if (!item.snapshots.find(s => s.version === 1)) {
      item.snapshots.push({ version: 1, at: new Date().toISOString(), data: snapshotData(item) });
    }
    if (!item.calibrations.some(c => c.valid)) {
      recalibrate(item, null);
    }
  }
  return item;
}

export function migrateDb(db) {
  db.ops = db.ops || [];
  db.pendingBatches = db.pendingBatches || [];
  for (const item of (db.items || [])) migrateItem(item);
  return db;
}

// ---------- 查找 ----------
export function findItem(db, idOrCode) {
  if (idOrCode == null) return undefined;
  return (db.items || []).find(i => i.id === idOrCode || i.code === idOrCode);
}

// ---------- 单笔操作 ----------
export function applyOp(db, op) {
  // 1. 同号重传沿用首次结果（幂等）
  const existing = (db.ops || []).find(o => o.opId === op.opId);
  if (existing) {
    return { opId: op.opId, duplicate: true, status: existing.result, result: existing.resultDetail };
  }

  let item = findItem(db, op.itemId || op.code);
  if (item) migrateItem(item);

  // 已删除的模型：迟到的非 remove 操作不得复活
  if (item && item._deleted && op.type !== "remove") {
    const tombVersion = item.tombstones?.__item__?.version;
    if (op.baseVersion != null && tombVersion != null && op.baseVersion < tombVersion) {
      recordExistenceConflict(item, {
        kind: "existence", targetKind: "item", targetId: item.id || item.code,
        reason: "item_removed_no_resurrect", baseVersion: op.baseVersion,
        source: op.source, opId: op.opId
      });
      bumpVersion(item, op);
      logOp(db, op, "conflict", { reason: "item_removed_no_resurrect" });
      return { opId: op.opId, status: "conflict", reason: "item_removed_no_resurrect", kept: "removed" };
    }
    logOp(db, op, "stale", { reason: "item_removed" });
    return { opId: op.opId, status: "stale", reason: "item_removed" };
  }

  let result;
  switch (op.type) {
    case "create": result = applyCreate(db, op); break;
    case "update": result = applyUpdate(db, op, item); break;
    case "remove": result = applyRemove(db, op, item); break;
    case "addTask": result = applyAddTask(db, op, item); break;
    case "updateTask": result = applyUpdateTask(db, op, item); break;
    case "removeTask": result = applyRemoveTask(db, op, item); break;
    case "calibrate": result = applyCalibrate(db, op, item); break;
    default: result = { status: "error", error: "unknown_op_type" };
  }

  logOp(db, op, result.status, result);
  return { opId: op.opId, ...result };
}

function logOp(db, op, status, detail) {
  db.ops = db.ops || [];
  db.ops.push({
    opId: op.opId, source: op.source, baseVersion: op.baseVersion,
    itemId: op.itemId || op.code || null, type: op.type,
    result: status, resultDetail: detail || null,
    receivedAt: new Date().toISOString()
  });
}

// ---------- create ----------
function applyCreate(db, op) {
  const code = op.payload?.code;
  if (code && (db.items || []).some(i => i.code === code && !i._deleted)) {
    return { status: "conflict", reason: "code_exists", code };
  }
  const now = new Date().toISOString();
  const item = {
    id: newId(),
    ...op.payload,
    version: 1,
    createdVersion: 1,
    tasks: [],
    logs: [{ at: now, step: "建档", note: "创建模型", opId: op.opId }],
    snapshots: [],
    conflicts: [],
    calibrations: [],
    tombstones: {}
  };
  item.snapshots.push({ version: 1, at: now, data: snapshotData(item), opId: op.opId });
  recalibrate(item, op);
  db.items = db.items || [];
  db.items.unshift(item);
  return { status: "applied", itemId: item.id, version: 1 };
}

// ---------- update（顶层字段） ----------
function applyUpdate(db, op, item) {
  if (!item) return { status: "error", error: "item_not_found" };
  const applied = {};
  const conflicts = [];
  for (const [field, value] of Object.entries(op.payload || {})) {
    if (field === "id" || field === "code") continue;
    const oldVal = item[field];
    if (oldVal === value) continue;
    // 基准版本落后 → 检查该字段在我们这边是否已被改过
    if (op.baseVersion != null && op.baseVersion < item.version) {
      const oldAtBase = getFieldAtVersion(item, field, op.baseVersion);
      if (oldAtBase !== undefined && oldAtBase !== oldVal) {
        // 两边基于同一版本改了同一字段 → 保留两份待处理
        conflicts.push({ field, currentValue: oldVal, proposedValue: value });
        continue;
      }
    }
    applied[field] = value;
    item[field] = value;
  }
  if (Object.keys(applied).length === 0 && conflicts.length === 0) {
    return { status: "no_change" };
  }
  for (const c of conflicts) {
    recordFieldConflict(item, {
      kind: "field", field: c.field,
      baseVersion: op.baseVersion, currentValue: c.currentValue,
      proposedValue: c.proposedValue, source: op.source, opId: op.opId
    });
  }
  bumpVersion(item, op);
  // 桅杆数 / 索具材料改动 → 校准结论失效重算
  if ("mastCount" in applied || "riggingMaterial" in applied) {
    recalibrate(item, op);
  }
  return {
    status: conflicts.length ? "partial" : "applied",
    applied, conflicts, version: item.version
  };
}

// ---------- remove（模型） ----------
function applyRemove(db, op, item) {
  if (!item) return { status: "error", error: "item_not_found" };
  if (item._deleted) return { status: "duplicate", reason: "already_removed" };
  item._deleted = true;
  item.tombstones = item.tombstones || {};
  bumpVersion(item, op);
  item.tombstones.__item__ = {
    at: new Date().toISOString(), opId: op.opId, version: item.version // 移除后的版本
  };
  return { status: "applied", version: item.version };
}

// ---------- addTask ----------
function applyAddTask(db, op, item) {
  if (!item) return { status: "error", error: "item_not_found" };
  const now = new Date().toISOString();
  const task = {
    id: op.payload?.id || ("T-" + Date.now() + "-" + seq()),
    position: op.payload?.position,
    tension: op.payload?.tension,
    status: op.payload?.status || "待检查",
    logs: [{ at: now, note: op.payload?.note || "新增帆索任务", opId: op.opId }]
  };
  item.tasks = item.tasks || [];
  item.tasks.push(task);
  item.status = "校准中";
  item.logs = item.logs || [];
  item.logs.push({ at: now, step: "帆索", note: `${task.position} · ${task.tension}`, opId: op.opId });
  bumpVersion(item, op);
  task.createdVersion = item.version; // 任务存在的起始版本（事件后版本）
  recalibrate(item, op); // 索位改动 → 校准结论失效重算
  return { status: "applied", taskId: task.id, version: item.version };
}

// ---------- updateTask ----------
function applyUpdateTask(db, op, item) {
  if (!item) return { status: "error", error: "item_not_found" };
  const taskId = op.payload?.taskId;
  const task = (item.tasks || []).find(t => t.id === taskId);
  if (!task) {
    // 任务已被移除：迟到的编辑不得复活
    if (item.tombstones?.[taskId]) {
      const tombVersion = item.tombstones[taskId].version;
      if (op.baseVersion != null && op.baseVersion < tombVersion) {
        recordExistenceConflict(item, {
          kind: "existence", targetKind: "task", targetId: taskId,
          reason: "task_removed_no_resurrect", baseVersion: op.baseVersion,
          source: op.source, opId: op.opId
        });
        bumpVersion(item, op);
        return { status: "conflict", reason: "task_removed_no_resurrect", kept: "removed" };
      }
      return { status: "stale", reason: "task_removed" };
    }
    return { status: "error", error: "task_not_found" };
  }
  const applied = {};
  const conflicts = [];
  for (const [field, value] of Object.entries(op.payload || {})) {
    if (field === "taskId" || field === "id") continue;
    const oldVal = task[field];
    if (oldVal === value) continue;
    if (op.baseVersion != null && op.baseVersion < item.version) {
      const oldAtBase = getTaskFieldAtVersion(item, taskId, field, op.baseVersion);
      if (oldAtBase !== undefined && oldAtBase !== oldVal) {
        conflicts.push({ field, currentValue: oldVal, proposedValue: value });
        continue;
      }
    }
    applied[field] = value;
    task[field] = value;
  }
  if (Object.keys(applied).length === 0 && conflicts.length === 0) {
    return { status: "no_change" };
  }
  for (const c of conflicts) {
    recordFieldConflict(item, {
      kind: "task_field", field: c.field, taskId,
      baseVersion: op.baseVersion, currentValue: c.currentValue,
      proposedValue: c.proposedValue, source: op.source, opId: op.opId
    });
  }
  bumpVersion(item, op);
  if ("position" in applied) recalibrate(item, op); // 索位改动 → 校准结论失效重算
  return { status: conflicts.length ? "partial" : "applied", applied, conflicts, version: item.version };
}

// ---------- removeTask ----------
function applyRemoveTask(db, op, item) {
  if (!item) return { status: "error", error: "item_not_found" };
  const taskId = op.payload?.taskId;
  const task = (item.tasks || []).find(t => t.id === taskId);
  if (task) {
    // 任务在 op 基准版本之后才新增 → op 不知道它存在，不得移除（新增不被迟到回传杀死）
    if (op.baseVersion != null && op.baseVersion < task.createdVersion) {
      recordExistenceConflict(item, {
        kind: "existence", targetKind: "task", targetId: taskId,
        reason: "task_added_after_base_no_kill", baseVersion: op.baseVersion,
        source: op.source, opId: op.opId
      });
      bumpVersion(item, op);
      return { status: "conflict", reason: "task_added_after_base_no_kill", kept: "alive" };
    }
    const idx = item.tasks.findIndex(t => t.id === taskId);
    const [removed] = item.tasks.splice(idx, 1);
    bumpVersion(item, op);
    item.tombstones[taskId] = {
      at: new Date().toISOString(), opId: op.opId,
      version: item.version, data: removed // 移除后的版本
    };
    recalibrate(item, op);
    return { status: "applied", version: item.version };
  }
  if (item.tombstones?.[taskId]) return { status: "duplicate", reason: "already_removed" };
  return { status: "error", error: "task_not_found" };
}

// ---------- calibrate ----------
function applyCalibrate(db, op, item) {
  if (!item) return { status: "error", error: "item_not_found" };
  const cal = recalibrate(item, op);
  return { status: "applied", calibrationId: cal.id, version: item.version };
}

// ---------- 批次 ----------
export function applyBatch(db, batch) {
  const results = [];
  for (const op of (batch.ops || [])) {
    results.push(applyOp(db, op));
  }
  return results;
}

// ---------- 冲突解决 ----------
export function resolveConflict(db, conflictId, choice) {
  for (const item of (db.items || [])) {
    const c = (item.conflicts || []).find(x => x.id === conflictId);
    if (!c) continue;
    if (choice === "proposed") {
      if (c.kind === "field") {
        item[c.field] = c.proposedValue;
      } else if (c.kind === "task_field") {
        const task = (item.tasks || []).find(t => t.id === c.taskId);
        if (task) task[c.field] = c.proposedValue;
      }
      // existence 冲突：选择 proposed 即按 proposed 执行（复活或移除）
      if (c.kind === "existence") {
        if (c.reason === "item_removed_no_resurrect") {
          delete item._deleted;
          delete item.tombstones.__item__;
        } else if (c.reason === "task_removed_no_resurrect") {
          const data = item.tombstones[c.targetId]?.data;
          if (data) { item.tasks = item.tasks || []; item.tasks.push(data); }
          delete item.tombstones[c.targetId];
        } else if (c.reason === "task_added_after_base_no_kill") {
          const idx = item.tasks.findIndex(t => t.id === c.targetId);
          if (idx >= 0) {
            const [removed] = item.tasks.splice(idx, 1);
            item.tombstones[c.targetId] = { at: new Date().toISOString(), opId: c.opId, version: item.version, data: removed };
          }
        }
      }
    }
    c.status = "resolved";
    c.resolvedChoice = choice;
    c.resolvedAt = new Date().toISOString();
    bumpVersion(item, null);
    if (["mastCount", "riggingMaterial"].includes(c.field) || c.field === "position") {
      recalibrate(item, null);
    }
    return { conflict: c, item };
  }
  return null;
}

// ---------- 汇总 ----------
export function pendingConflicts(db) {
  const out = [];
  for (const item of (db.items || [])) {
    for (const c of (item.conflicts || [])) {
      if (c.status === "pending") out.push({ ...c, itemId: item.id || item.code, itemCode: item.code });
    }
  }
  return out;
}

export function conflictCount(db) {
  return pendingConflicts(db).length;
}

export function currentCalibration(item) {
  return (item.calibrations || []).find(c => c.valid) || null;
}

export function calibrationHistory(item) {
  return (item.calibrations || []).slice().sort((a, b) => {
    if (a.valid === b.valid) return new Date(b.createdAt) - new Date(a.createdAt);
    return a.valid ? -1 : 1;
  });
}
