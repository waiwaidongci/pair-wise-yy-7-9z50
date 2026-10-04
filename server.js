import http from "node:http";
import { mkdir, readFile, writeFile, rename as renameFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "data");
const dbPath = join(dataDir, "model-rigging-calibration.json");
const spoolPath = join(dataDir, "sync-spool.json");
const port = Number(process.env.PORT || 3038);

const SCHEMA_VERSION = 2;
const ITEM_FIELDS = ["code", "shipType", "scale", "mastCount", "riggingMaterial", "owner", "dueDate", "status"];
const TASK_FIELDS = ["position", "tension", "status"];
const DEP_FIELDS = new Set(["mastCount", "riggingMaterial"]);
const STAGES = ["待检查", "校准中", "待复核", "已交付"];
const TASK_STAGES = ["待检查", "调整中", "已完成"];
const MIG_SOURCE = "旧档迁移";
const SYSTEM_SOURCE = "系统重算";

/* ---------------- 存储：主库 + 断线回传暂存（spool，分开写） ---------------- */

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dataDir, { recursive: true });
    const fresh = { schemaVersion: SCHEMA_VERSION, items: [], history: {}, completedBatches: {}, fault: false };
    await saveDb(fresh, { force: true });
    return fresh;
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  await migrate(db);
  return db;
}

async function saveDb(db, { force = false } = {}) {
  // 故障开关只影响主库写入；spool 走独立文件，保证“写失败也能保留现场批次”
  if (db.fault && !force) throw new Error("simulated_write_fault");
  const tmp = dbPath + ".tmp-" + process.pid + "-" + randomUUID();
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await renameFile(tmp, dbPath);
}

async function loadSpool() {
  if (!existsSync(spoolPath)) return { batches: {} };
  try {
    return JSON.parse(await readFile(spoolPath, "utf8"));
  } catch {
    return { batches: {} };
  }
}
async function saveSpool(spool) {
  const tmp = spoolPath + ".tmp-" + process.pid + "-" + randomUUID();
  await writeFile(tmp, JSON.stringify(spool, null, 2));
  await renameFile(tmp, spoolPath);
}

/* ---------------- 旧数据迁移：没有版本的档案迁成首版 ---------------- */

async function migrate(db) {
  let touched = false;
  if (!db.schemaVersion) db.schemaVersion = SCHEMA_VERSION;
  db.history ||= {};
  db.completedBatches ||= {};
  for (const raw of db.items || []) {
    if (raw.version) continue;
    touched = true;
    const id = raw.id || raw.code || "MR-" + randomUUID();
    const now = "2026-06-12T00:00:00.000Z";
    const fields = {};
    for (const key of ITEM_FIELDS) fields[key] = raw[key];
    fields.status ||= "校准中";
    if (raw.mastCount != null) fields.mastCount = Number(raw.mastCount);
    const fieldProvenance = {};
    for (const key of ITEM_FIELDS) {
      if (fields[key] !== undefined) {
        fieldProvenance[key] = { opId: "mig-v1-" + id + "-" + key, source: MIG_SOURCE, baseVersion: 0, version: 1, at: now };
      }
    }
    const tasks = (raw.tasks || []).map((t) => {
      const fp = {};
      for (const key of TASK_FIELDS) {
        if (t[key] !== undefined) fp[key] = { opId: "mig-v1-" + id + "-" + t.id + "-" + key, source: MIG_SOURCE, baseVersion: 0, version: 1, at: now };
      }
      return {
        id: t.id,
        position: t.position,
        tension: t.tension,
        status: t.status || "待检查",
        logs: t.logs || [],
        addedBy: { opId: "mig-v1-" + id + "-" + t.id, source: MIG_SOURCE, baseVersion: 0, version: 1, at: now },
        fieldProvenance: fp,
      };
    });
    const item = {
      id,
      code: raw.code || id,
      version: 1,
      fields,
      fieldProvenance,
      tasks,
      taskTombstones: raw.taskTombstones || [],
      logs: raw.logs || [],
      calibrations: [],
      conflicts: [],
    };
    item.calibrations.push({
      id: "CAL-mig-" + id,
      state: "current",
      basis: { itemVersion: 1, signature: signatureOf(item) },
      conclusion: conclude(item),
      opId: "mig-cal-" + id,
      source: MIG_SOURCE,
      at: now,
      note: "旧档无版本号，迁移为首版并生成基线校准结论",
    });
    const idx = db.items.indexOf(raw);
    db.items[idx] = item;
  }
  if (touched) {
    try { await saveDb(db, { force: true }); } catch { /* 迁移落盘失败则下次重试 */ }
  }
  return db;
}

/* ---------------- 校准结论：依赖 桅杆数 / 材料 / 索位 ---------------- */

function signatureOf(item) {
  const f = item.fields;
  const positions = item.tasks
    .map((t) => t.id + "@" + String(t.position || ""))
    .sort()
    .join(";");
  return `mast=${f.mastCount ?? ""}|material=${f.riggingMaterial ?? ""}|positions=${positions}`;
}

function conclude(item) {
  const f = item.fields;
  const n = item.tasks.length;
  if (n === 0) {
    return `暂无帆索任务：桅杆 ${f.mastCount ?? "?"} 根、${f.riggingMaterial ?? "?"}索，档案参数可作静态基线，待拆索具任务`;
  }
  const done = item.tasks.filter((t) => t.status === "已完成").length;
  const adjusting = item.tasks.filter((t) => t.status === "调整中").length;
  const loose = item.tasks.filter((t) => String(t.tension || "").includes("松")).length;
  const tight = item.tasks.filter((t) => String(tensionOf(t)).includes("紧")).length;
  if (done === n) return `全部 ${n} 条帆索（${positionsDigest(item)}）校准完成，可进入复核`;
  if (adjusting > 0) return `${adjusting}/${n} 条索具仍在调整（${positionsDigest(item)}），暂缓复核`;
  if (loose || tight) return `松紧不均：偏松 ${loose} 条、偏紧 ${tight} 条（${positionsDigest(item)}），需复测`;
  return `${n} 条索具状态稳定（${positionsDigest(item)}），建议复核`;
}
function tensionOf(t) { return t.tension || ""; }
function positionsDigest(item) {
  const p = item.tasks.map((t) => t.position).filter(Boolean);
  return p.length <= 3 ? p.join("、") : p.slice(0, 3).join("、") + " 等";
}
function currentCal(item) {
  for (let i = item.calibrations.length - 1; i >= 0; i--) {
    if (item.calibrations[i].state === "current") return item.calibrations[i];
  }
  return null;
}

function pushCalibration(item, { opId, source, at, note, basisVersion = item.version }) {
  const prev = currentCal(item);
  const cal = {
    id: "CAL-" + randomUUID(),
    state: "current",
    basis: { itemVersion: basisVersion, signature: signatureOf(item) },
    conclusion: conclude(item),
    opId,
    source,
    at,
    note: note || "",
  };
  if (prev) {
    prev.state = "superseded";
    prev.supersededBy = cal.id;
    prev.valid = false;
  }
  cal.valid = true;
  item.calibrations.push(cal);
  return cal;
}

/** 依赖（桅杆数/材料/索位）一旦变化，旧版校准结论失效并基于当前版本重算；旧快照保留 */
function recalibrateIfNeeded(item, cause) {
  const cur = currentCal(item);
  const sig = signatureOf(item);
  if (!cur) {
    pushCalibration(item, { opId: cause.opId + "#recalc", source: SYSTEM_SOURCE, at: cause.at, note: `由操作 ${cause.opId} 建立首个校准结论（v${item.version}）` });
    return "created";
  }
  if (cur.basis.signature === sig) return "unchanged";
  cur.state = "stale";
  cur.valid = false;
  cur.invalidatedBy = { opId: cause.opId, source: cause.source, at: cause.at };
  const fresh = pushCalibration(item, {
    opId: cause.opId + "#recalc",
    source: SYSTEM_SOURCE + "（源自" + cause.source + "）",
    at: cause.at,
    basisVersion: item.version,
    note: `桅杆数/索具材料/索位变化，基于 v${item.version} 自动重算；原快照 ${cur.id} 仍可查`,
  });
  fresh.supersedes = cur.id;
  return "recalculated";
}

/* ---------------- 冲突：同字段两边都改，保留两份（或多份）待裁决 ---------------- */

function openFieldConflict(item, field) {
  return item.conflicts.find((c) => c.status === "open" && c.kind === "field" && c.field === field);
}
function openTaskConflict(item, taskId, field) {
  if (field) return item.conflicts.find((c) => c.status === "open" && c.kind === "task-field" && c.taskId === taskId && c.field === field);
  return item.conflicts.find((c) => c.status === "open" && c.kind === "task-add" && c.taskId === taskId);
}
function optionOf(value, op) {
  return { opId: op.opId, source: op.source, baseVersion: op.baseVersion, at: op.at, value };
}

function logOnItem(item, op, status, message) {
  item.logs.push({
    at: op.at,
    opId: op.opId,
    type: op.type,
    source: op.source,
    baseVersion: op.baseVersion,
    itemVersionAfter: item.version,
    status,
    message,
  });
}

/* ---------------- 单条操作归并 ---------------- */

function findItem(db, itemId) {
  return db.items.find((x) => x.id === itemId || x.code === itemId);
}
function findTask(item, taskId) {
  return item.tasks.find((t) => t.id === taskId);
}
function tombstoneOf(item, taskId) {
  return item.taskTombstones.find((t) => t.id === taskId);
}
function bump(item) { item.version += 1; }

function normalizeValue(field, value) {
  if (field === "mastCount") return value === "" || value == null ? null : Number(value);
  return value;
}

function applyOp(db, op) {
  const result = { opId: op.opId, type: op.type, status: "error" };

  if (op.type === "item-create") {
    const existing = findItem(db, op.itemId);
    if (existing) {
      // 同号迟到重传不新建；建档只认首次，迟到建档不复活/不覆盖
      result.itemId = existing.id;
      result.status = "ignored";
      result.reason = "already_exists: 迟到建档不复活/不覆盖已有档案";
      result.itemVersionAfter = existing.version;
      logOnItem(existing, op, "ignored", "迟到的建档操作，模型已存在，忽略");
      return result;
    }
    const id = op.itemId || "MR-" + randomUUID().slice(0, 8);
    const fields = {
      code: op.fields?.code || op.code || id,
      shipType: op.fields?.shipType ?? op.shipType ?? "",
      scale: op.fields?.scale ?? op.scale ?? "",
      mastCount: op.fields?.mastCount ?? op.mastCount ?? null,
      riggingMaterial: op.fields?.riggingMaterial ?? op.riggingMaterial ?? "",
      owner: op.fields?.owner ?? op.owner ?? "",
      dueDate: op.fields?.dueDate ?? op.dueDate ?? "",
      status: op.fields?.status ?? op.status ?? "待检查",
    };
    if (fields.mastCount != null) fields.mastCount = Number(fields.mastCount);
    const prov = {};
    for (const key of ITEM_FIELDS) {
      if (fields[key] !== undefined && fields[key] !== null) {
        prov[key] = { opId: op.opId, source: op.source, baseVersion: 0, version: 1, at: op.at };
      }
    }
    const item = {
      id, code: fields.code || id, version: 1, fields,
      fieldProvenance: prov, tasks: [], taskTombstones: [],
      logs: [{ at: op.at, opId: op.opId, type: "item-create", source: op.source, baseVersion: 0, itemVersionAfter: 1, status: "applied", message: "断线端建档回传，落为首版 v1" }],
      calibrations: [], conflicts: [],
    };
    pushCalibration(item, { opId: op.opId, source: op.source, at: op.at, note: "建档基线校准结论" });
    db.items.unshift(item);
    result.itemId = id;
    result.status = "applied";
    result.itemVersionAfter = 1;
    return result;
  }

  const item = findItem(db, op.itemId);
  if (!item) {
    result.status = "error";
    result.reason = "item_not_found";
    return result;
  }
  result.itemId = item.id;
  result.baseVersion = op.baseVersion;

  switch (op.type) {

    case "field-update": {
      const field = op.field;
      if (!ITEM_FIELDS.includes(field)) { result.reason = "unknown_field"; return result; }
      const value = normalizeValue(field, op.value);
      const existing = openFieldConflict(item, field);
      if (existing) {
        const dup = existing.options.find((o) => String(o.value) === String(value));
        if (dup) (dup.aliasOpIds ||= []).push(op.opId);
        else existing.options.push(optionOf(value, op));
        result.status = "conflict";
        result.conflictId = existing.id;
        logOnItem(item, op, "conflict", `字段「${field}」已有待裁决冲突，${dup ? "意见与 " + dup.opId + " 相同" : "追加第 " + existing.options.length + " 份意见"}：${value}`);
        return result;
      }
      const prov = item.fieldProvenance[field];
      // 该字段在本操作所依据的基准版本之后，被“其他来源”改过 → 两边同改，挂冲突
      const changedElsewhere = prov && prov.version > op.baseVersion && prov.source !== op.source;
      if (changedElsewhere) {
        const c = {
          id: "CF-" + randomUUID(),
          kind: "field",
          field,
          target: `模型档案.${field}`,
          status: "open",
          createdAt: op.at,
          options: [
            { opId: prov.opId, source: prov.source, baseVersion: prov.baseVersion, at: prov.at, value: item.fields[field] },
            optionOf(value, op),
          ],
        };
        item.conflicts.push(c);
        result.status = "conflict";
        result.conflictId = c.id;
        logOnItem(item, op, "conflict", `字段「${field}」两边同改：保留两份待裁决（${prov.source}=${item.fields[field]} / ${op.source}=${value}）`);
        return result;
      }
      if (String(item.fields[field]) === String(value)) {
        result.status = "applied";
        result.itemVersionAfter = item.version;
        logOnItem(item, op, "applied", `字段「${field}」同值重复提交，沿用当前值 ${value}`);
        return result;
      }
      const old = item.fields[field];
      item.fields[field] = value;
      bump(item);
      item.fieldProvenance[field] = { opId: op.opId, source: op.source, baseVersion: op.baseVersion, version: item.version, at: op.at };
      result.status = "applied";
      result.itemVersionAfter = item.version;
      result.affectsDependency = DEP_FIELDS.has(field);
      logOnItem(item, op, "applied", `字段「${field}」：${old} → ${value}`);
      return result;
    }

    case "task-add": {
      const tid = op.taskId || op.task?.id;
      if (!tid) { result.reason = "missing_task_id"; return result; }
      if (tombstoneOf(item, tid)) {
        result.status = "ignored";
        result.reason = "tombstone: 索位已被移除，迟到新增不得复活";
        logOnItem(item, op, "ignored", `迟到新增任务 ${tid}（${op.task?.position || ""}）命中删除墓碑，不复活`);
        return result;
      }
      const existingTask = findTask(item, tid);
      if (existingTask) {
        let c = openTaskConflict(item, tid, null);
        const snapshot = { position: op.task?.position, tension: op.task?.tension, status: op.task?.status || "待检查" };
        if (c) {
          c.options.push({ opId: op.opId, source: op.source, baseVersion: op.baseVersion, at: op.at, value: snapshot });
        } else {
          c = {
            id: "CF-" + randomUUID(),
            kind: "task-add",
            taskId: tid,
            target: `帆索任务.${tid}`,
            status: "open",
            createdAt: op.at,
            options: [
              { opId: existingTask.addedBy.opId, source: existingTask.addedBy.source, baseVersion: existingTask.addedBy.baseVersion, at: existingTask.addedBy.at,
                value: { position: existingTask.position, tension: existingTask.tension, status: existingTask.status } },
              { opId: op.opId, source: op.source, baseVersion: op.baseVersion, at: op.at, value: snapshot },
            ],
          };
          item.conflicts.push(c);
        }
        result.status = "conflict";
        result.conflictId = c.id;
        logOnItem(item, op, "conflict", `索具 ${tid} 被两方以同号新增，保留两份待裁决`);
        return result;
      }
      const task = {
        id: tid,
        position: op.task?.position || "",
        tension: op.task?.tension || "",
        status: op.task?.status || "待检查",
        logs: [],
        addedBy: { opId: op.opId, source: op.source, baseVersion: op.baseVersion, version: item.version + 1, at: op.at },
        fieldProvenance: {},
      };
      for (const key of TASK_FIELDS) {
        task.fieldProvenance[key] = { opId: op.opId, source: op.source, baseVersion: op.baseVersion, version: item.version + 1, at: op.at };
      }
      item.tasks.push(task);
      bump(item);
      result.status = "applied";
      result.itemVersionAfter = item.version;
      result.affectsDependency = true;
      logOnItem(item, op, "applied", `新增帆索任务 ${tid}：${task.position} · ${task.tension} · ${task.status}`);
      return result;
    }

    case "task-update": {
      const tid = op.taskId;
      const field = op.field;
      if (!TASK_FIELDS.includes(field)) { result.reason = "unknown_task_field"; return result; }
      if (tombstoneOf(item, tid)) {
        result.status = "ignored";
        result.reason = "tombstone: 索位已移除，迟到修改不得复活";
        logOnItem(item, op, "ignored", `迟到修改任务 ${tid}.${field} 命中删除墓碑，不复活`);
        return result;
      }
      const task = findTask(item, tid);
      if (!task) {
        result.status = "ignored";
        result.reason = "task_not_found: 任务不存在（可能尚未回传或已删除），迟到修改不复活";
        logOnItem(item, op, "ignored", `迟到修改任务 ${tid}.${field}，任务不存在，忽略`);
        return result;
      }
      const value = op.value;
      const existing = openTaskConflict(item, tid, field);
      if (existing) {
        const dup = existing.options.find((o) => String(o.value) === String(value));
        if (dup) (dup.aliasOpIds ||= []).push(op.opId);
        else existing.options.push(optionOf(value, op));
        result.status = "conflict";
        result.conflictId = existing.id;
        logOnItem(item, op, "conflict", `索位「${task.position}」的「${field}」已有待裁决冲突，保留多方意见`);
        return result;
      }
      const prov = task.fieldProvenance[field];
      const changedElsewhere = prov && prov.version > op.baseVersion && prov.source !== op.source;
      if (changedElsewhere) {
        const c = {
          id: "CF-" + randomUUID(),
          kind: "task-field",
          taskId: tid,
          field,
          target: `帆索任务.${tid}.${field}`,
          status: "open",
          createdAt: op.at,
          options: [
            { opId: prov.opId, source: prov.source, baseVersion: prov.baseVersion, at: prov.at, value: task[field] },
            optionOf(value, op),
          ],
        };
        item.conflicts.push(c);
        result.status = "conflict";
        result.conflictId = c.id;
        logOnItem(item, op, "conflict", `索位「${task.position}」的「${field}」两边同改：保留两份待裁决（${prov.source}=${task[field]} / ${op.source}=${value}）`);
        return result;
      }
      if (String(task[field]) === String(value)) {
        result.status = "applied";
        result.itemVersionAfter = item.version;
        logOnItem(item, op, "applied", `索位「${task.position}」.${field} 同值重复提交`);
        return result;
      }
      const old = task[field];
      task[field] = value;
      bump(item);
      task.fieldProvenance[field] = { opId: op.opId, source: op.source, baseVersion: op.baseVersion, version: item.version, at: op.at };
      result.status = "applied";
      result.itemVersionAfter = item.version;
      result.affectsDependency = field === "position";
      logOnItem(item, op, "applied", `索位「${task.position}」.${field}：${old} → ${value}`);
      return result;
    }

    case "task-log": {
      const tid = op.taskId;
      if (tombstoneOf(item, tid) || !findTask(item, tid)) {
        result.status = "ignored";
        result.reason = "task_not_found: 迟到备注不复活不存在的索位";
        logOnItem(item, op, "ignored", `迟到备注任务 ${tid}，任务不存在，忽略`);
        return result;
      }
      const task = findTask(item, tid);
      task.logs.push({ at: op.at, note: op.note || "", opId: op.opId, source: op.source, baseVersion: op.baseVersion });
      bump(item);
      result.status = "applied";
      result.itemVersionAfter = item.version;
      logOnItem(item, op, "applied", `索位「${task.position}」追加备注：${op.note || ""}`);
      return result;
    }

    case "task-remove": {
      const tid = op.taskId;
      if (tombstoneOf(item, tid)) {
        result.status = "ignored";
        result.reason = "already_removed: 同号删除重传沿用首次结果";
        logOnItem(item, op, "ignored", `任务 ${tid} 已删除，删除操作幂等忽略`);
        return result;
      }
      const task = findTask(item, tid);
      if (!task) {
        result.status = "ignored";
        result.reason = "task_not_found: 任务不存在，迟到删除不产生新墓碑";
        logOnItem(item, op, "ignored", `迟到删除任务 ${tid}，任务不存在，忽略`);
        return result;
      }
      item.tasks = item.tasks.filter((t) => t.id !== tid);
      bump(item);
      item.taskTombstones.push({
        id: tid, position: task.position, opId: op.opId, source: op.source,
        baseVersion: op.baseVersion, version: item.version, at: op.at,
      });
      // 挂在该索位上的未决冲突随之结案保留
      for (const c of item.conflicts) {
        if (c.status === "open" && c.taskId === tid) {
          c.status = "obsolete";
          c.closedBy = { at: op.at, opId: op.opId, reason: "索位已被移除" };
        }
      }
      result.status = "applied";
      result.itemVersionAfter = item.version;
      result.affectsDependency = true;
      logOnItem(item, op, "applied", `移除帆索任务 ${tid}（${task.position}），置墓碑，迟到回传不得复活`);
      return result;
    }

    case "calibrate": {
      const cal = pushCalibration(item, {
        opId: op.opId, source: op.source, at: op.at,
        note: op.note ? `技师校准：${op.note}` : "技师现场校准结论",
      });
      result.status = "applied";
      result.calibrationId = cal.id;
      result.itemVersionAfter = item.version;
      logOnItem(item, op, "applied", `记校准结论（基于 v${item.version}）：${cal.conclusion}`);
      return result;
    }

    default:
      result.reason = "unknown_op_type";
      return result;
  }
}

/* ---------------- 批次归并（同号幂等、保留首次结果） ---------------- */

function summarizeResult(result) {
  return {
    opId: result.opId,
    type: result.type,
    status: result.status,
    reason: result.reason,
    conflictId: result.conflictId,
    calibrationId: result.calibrationId,
    itemVersionAfter: result.itemVersionAfter,
  };
}

function processBatch(db, batch, { at = new Date().toISOString(), replayed = false } = {}) {
  const results = [];
  const depCauses = new Map(); // itemId -> 最后一个改变依赖的已应用操作
  for (const raw of batch.ops) {
    const op = {
      at,
      source: batch.source,
      ...raw,
      baseVersion: Number(raw.baseVersion || 0),
    };
    op.source ||= batch.source || "未标注来源";
    if (!op.opId || !op.type) {
      results.push({ opId: op.opId || null, type: op.type || null, status: "error", reason: "malformed_op" });
      continue;
    }
    const first = db.history[op.opId];
    if (first) {
      // 同号重传（含断线重试）：沿用首次结果
      results.push({ ...summarizeResult(first), duplicate: true });
      continue;
    }
    const r = applyOp(db, op);
    db.history[op.opId] = r;
    if (r.itemId && r.status === "applied" && r.affectsDependency) depCauses.set(r.itemId, op);
    results.push(summarizeResult(r));
  }
  // 依赖变更在批次末尾统一重算，每档每批只产生一条新结论
  const recalcs = [];
  for (const [itemId, cause] of depCauses) {
    const item = findItem(db, itemId);
    if (!item) continue;
    const mode = recalibrateIfNeeded(item, cause);
    if (mode !== "unchanged") recalcs.push({ itemId, mode, calibrationId: currentCal(item)?.id });
  }
  const summary = {
    batchId: batch.batchId,
    source: batch.source,
    processedAt: at,
    replayed,
    results,
    recalcs,
    applied: results.filter((r) => r.status === "applied" && !r.duplicate).length,
    conflicts: results.filter((r) => r.status === "conflict").length,
    ignored: results.filter((r) => r.status === "ignored").length,
    errors: results.filter((r) => r.status === "error").length,
  };
  db.completedBatches[batch.batchId] = summary;
  return summary;
}

/* ---------------- HTTP ---------------- */

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}

function openConflictsOf(item) { return item.conflicts.filter((c) => c.status === "open"); }

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>古船模型帆索校准 · 断网合并</title>
<style>
:root{--bg:#f1f3ef;--panel:#fff;--ink:#20241f;--muted:#687066;--line:#d4ddd0;--accent:#526f43;--warn:#9b4937;--amber:#9a6b1f;}
*{box-sizing:border-box;} body{margin:0;background:var(--bg);color:var(--ink);font-family:Arial,"PingFang SC",sans-serif;}
header{padding:20px 28px;background:#fff;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:16px;align-items:center;}
h1{margin:0;font-size:23px;} h2{margin:0 0 10px;font-size:17px;} h3{margin:0;font-size:16px;}
main{padding:20px 28px;display:grid;grid-template-columns:420px 1fr;gap:20px;}
.panel,.card,.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;}
button{border:0;border-radius:6px;background:var(--accent);color:#fff;padding:8px 12px;font-weight:700;cursor:pointer;}
button.secondary{background:#69736a;} button.small{padding:4px 8px;font-size:12px;} button.danger{background:var(--warn);}
label{display:block;margin:8px 0 4px;color:var(--muted);font-size:12px;}
input,select,textarea{width:100%;border:1px solid var(--line);border-radius:6px;padding:8px;font:inherit;background:#fff;}
textarea{min-height:120px;font-family:Menlo,Consolas,monospace;font-size:12px;}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:14px;}
.stat strong{display:block;font-size:22px;} .stat.warn strong{color:var(--warn);} .stat.amber strong{color:var(--amber);}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px;}
.card{display:grid;gap:8px;}
.meta{color:var(--muted);font-size:12px;} .pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:12px;}
.pill.bad{border-color:var(--warn);color:var(--warn);font-weight:700;} .pill.cal{border-color:var(--accent);color:var(--accent);}
.pill.stale{border-color:var(--amber);color:var(--amber);}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.prov{color:var(--muted);font-size:11px;}
.task{border:1px dashed var(--line);border-radius:6px;padding:8px;}
.conflict{border:1px solid var(--warn);border-radius:6px;padding:8px;background:#fbf3f1;}
.opt{margin:4px 0;padding:6px;border:1px solid var(--line);border-radius:6px;background:#fff;font-size:12px;display:flex;justify-content:space-between;gap:8px;align-items:center;}
details{border-top:1px dashed var(--line);padding-top:6px;}
.logline{font-size:11px;color:var(--muted);}
.held{border:1px solid var(--warn);border-radius:6px;padding:8px;margin:6px 0;background:#fbf3f1;font-size:12px;}
@media (max-width:1000px){main{grid-template-columns:1fr;}}
</style>
</head>
<body>
<header><div><h1>古船模型帆索校准 · 断网合并</h1><div class="meta">两位技师断线各改索具 → 回传合并；每笔带操作号 / 基准版本 / 来源；页面显示当前有效结果与冲突数</div></div><button id="reload">刷新</button></header>
<main>
<section>
  <div class="panel">
    <h2>回传批次</h2>
    <label>批次 JSON（batchId / source / ops；每条 op 含 opId、baseVersion、type）</label>
    <textarea id="batchJson"></textarea>
    <div class="row" style="margin-top:8px"><button id="sendBatch">回传合并</button><button class="secondary small" id="fillDemo">填入演示批次</button></div>
    <div id="syncResult" class="meta" style="margin-top:8px"></div>
  </div>
  <div class="panel" style="margin-top:14px">
    <h2>写入失败现场（保留批次，按原操作号重试）</h2>
    <div id="pending"></div>
    <div class="row" style="margin-top:8px">
      <button class="danger small" id="faultOn">模拟主库写失败</button>
      <button class="secondary small" id="faultOff">恢复写入</button>
      <span id="faultState" class="meta"></span>
    </div>
  </div>
  <div class="panel" style="margin-top:14px">
    <h2>新增模型</h2>
    <div class="row"><input id="newCode" placeholder="模型编号（如 MR-002）"><input id="newShip" placeholder="船型"></div>
    <div class="row"><input id="newMast" type="number" placeholder="桅杆数"><input id="newMat" placeholder="帆索材料（如 蜡线）"></div>
    <div class="row" style="margin-top:8px"><button id="createBtn">建档（首版 v1）</button></div>
  </div>
</section>
<section>
  <div class="stats" id="stats"></div>
  <div class="panel"><h2>模型档案 / 帆索任务 / 校准结论（当前有效）</h2><div class="grid" id="cards"></div></div>
</section>
</main>
<script>
const stages = ["待检查","校准中","待复核","已交付"];
async function api(path, options){
  const res = await fetch(path, options && options.body ? {...options,headers:{'Content-Type':'application/json'}} : options);
  const data = await res.json();
  if(!res.ok) throw new Error((data.error||'请求失败') + (data.detail?('：'+data.detail):''));
  return data;
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function prov(p){ return p ? '<div class="prov">操作号 '+esc(p.opId)+' · 基准 v'+esc(p.baseVersion)+' · 来源 '+esc(p.source)+(p.resolvedBy?' · 已裁决':'')+'</div>' : '<div class="prov">（无来源记录）</div>'; }
function calBadge(c){
  if(!c) return '<span class="pill stale">无有效结论</span>';
  if(c.state === 'current') return '<span class="pill cal">当前有效 · 基于 v'+c.basis.itemVersion+'</span>';
  return '<span class="pill stale">'+({stale:'已失效',superseded:'已被取代'}[c.state]||c.state)+' · v'+c.basis.itemVersion+'</span>';
}
function cardHtml(item){
  const f = item.fields;
  const tasks = item.tasks.map(t =>
    '<div class="task"><b>'+esc(t.position||'（无名索位）')+'</b> <span class="pill">'+esc(t.status)+'</span> <span class="pill">'+esc(t.tension)+'</span>'+
    prov(t.fieldProvenance && t.fieldProvenance.position)+
    '<details><summary class="meta">索位备注 '+((t.logs||[]).length)+' 条</summary>'+
    (t.logs||[]).slice(-5).map(l=>'<div class="logline">'+esc(l.at)+' '+esc(l.note)+(l.opId?('（'+esc(l.opId)+'）'):'')+'</div>').join('')+'</details></div>'
  ).join('') || '<div class="meta">暂无帆索任务</div>';
  const conflicts = item.conflicts.filter(c=>c.status==='open').map(c =>
    '<div class="conflict" data-cid="'+c.id+'"><b>冲突：'+esc(c.target)+'</b>（保留 '+c.options.length+' 份待处理）'+
    c.options.map((o,i)=>'<div class="opt"><span>['+i+'] '+esc(typeof o.value==='object'?JSON.stringify(o.value):o.value)+'<br><span class="prov">'+esc(o.opId)+' · 基准 v'+esc(o.baseVersion)+' · '+esc(o.source)+'</span></span><button class="small resolve" data-iid="'+item.id+'" data-cid="'+c.id+'" data-idx="'+i+'">采纳</button></div>').join('')+
    '</div>'
  ).join('');
  const cal = item.calibration;
  const calHistory = item.calibrations.slice().reverse().map(c =>
    '<div style="margin:4px 0">'+calBadge(c)+' <span class="meta">'+esc(c.conclusion)+'</span><div class="prov">'+esc(c.opId)+' · '+esc(c.source)+' · '+esc(c.at)+(c.invalidatedBy?(' · 失效于 '+esc(c.invalidatedBy.opId)):'')+'</div></div>'
  ).join('');
  const tombs = (item.taskTombstones||[]).map(t=>'<span class="pill">已删 '+esc(t.position||t.id)+'</span>').join(' ');
  return '<article class="card"><div class="row"><h3>'+esc(item.code)+'</h3><span class="pill">v'+item.version+'</span><span class="pill">'+esc(f.status)+'</span>'+
    (item.conflictCount?'<span class="pill bad">冲突 '+item.conflictCount+'</span>':'')+'</div>'+
  '<div>桅杆 <b>'+esc(f.mastCount)+'</b> 根 · 材料 <b>'+esc(f.riggingMaterial)+'</b> · '+esc(f.shipType)+' · '+esc(f.scale)+' · 负责人 '+esc(f.owner)+'</div>'+
  '<div class="row"><span class="pill cal">校准结论</span><b>'+esc(cal?cal.conclusion:'（无）')+'</b></div>'+
  '<div class="meta">'+(cal?('操作号 '+esc(cal.opId)+' · 基准 v'+cal.basis.itemVersion+' · 来源 '+esc(cal.source)):'')+'</div>'+
  (conflicts?'<div>'+conflicts+'</div>':'')+
  '<details><summary class="meta">帆索任务 '+item.tasks.length+' 条（点击展开）</summary>'+tasks+'</details>'+
  (tombs?'<div class="meta">墓碑（迟到回传不复活）：'+tombs+'</div>':'')+
  '<details><summary class="meta">校准记录 '+item.calibrations.length+' 条（含失效旧快照，均可查）</summary>'+calHistory+'</details>'+
  '<details><summary class="meta">操作流水 '+item.logCount+' 条</summary>'+item.logs.slice().reverse().map(l=>'<div class="logline">'+esc(l.at)+' ['+esc(l.status)+'] '+esc(l.message)+' <span class="prov">'+esc(l.opId)+' · 基准 v'+esc(l.baseVersion??'?')+' · '+esc(l.source)+'</span></div>').join('')+'</details>'+
  '</article>';
}
async function load(){
  const [items, stats, pending, fault] = await Promise.all([api('/api/items'), api('/api/stats'), api('/api/sync/pending'), api('/api/fault')]);
  document.querySelector('#stats').innerHTML =
    '<div class="stat"><span>模型总数</span><strong>'+stats.models+'</strong></div>'+
    Object.entries(stats.byStatus).map(([k,v])=>'<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('')+
    '<div class="stat '+(stats.openConflicts?'warn':'')+'"><span>待处理冲突</span><strong>'+stats.openConflicts+'</strong></div>'+
    '<div class="stat '+(stats.staleCalibrations?'amber':'')+'"><span>失效校准快照</span><strong>'+stats.staleCalibrations+'</strong></div>'+
    '<div class="stat"><span>帆索任务</span><strong>'+stats.tasks+'</strong></div>';
  document.querySelector('#cards').innerHTML = items.map(cardHtml).join('') || '<div class="meta">暂无档案</div>';
  document.querySelectorAll('button.resolve').forEach(btn => btn.onclick = async () => {
    await api('/api/items/'+encodeURIComponent(btn.dataset.iid)+'/conflicts/'+encodeURIComponent(btn.dataset.cid)+'/resolve',
      {method:'POST',body:JSON.stringify({optionIndex:Number(btn.dataset.idx),by:'值班调度'})});
    await load();
  });
  document.querySelector('#pending').innerHTML = pending.batches.length
    ? pending.batches.map(b => '<div class="held"><b>'+esc(b.batchId)+'</b> · '+esc(b.source)+' · '+b.opCount+' 笔：'+esc(b.opIds.join(', '))+
      (b.lastError?'<br>失败原因：'+esc(b.lastError):'')+'<br><button class="small" data-retry="'+esc(b.batchId)+'">按原操作号重试</button></div>').join('')
    : '<div class="meta">无保留批次</div>';
  document.querySelectorAll('[data-retry]').forEach(btn => btn.onclick = async () => {
    const r = await api('/api/sync/retry/'+encodeURIComponent(btn.dataset.retry),{method:'POST'});
    document.querySelector('#syncResult').textContent = '重试完成：应用 '+r.applied+' · 冲突 '+r.conflicts+' · 忽略 '+r.ignored;
    await load();
  });
  document.querySelector('#faultState').textContent = fault.fault ? '（当前主库写入被模拟为失败）' : '（写入正常）';
}
document.querySelector('#reload').onclick = load;
document.querySelector('#sendBatch').onclick = async () => {
  const out = document.querySelector('#syncResult');
  try {
    const batch = JSON.parse(document.querySelector('#batchJson').value);
    const r = await api('/api/sync',{method:'POST',body:JSON.stringify(batch)});
    out.innerHTML = (r.duplicate?'同号批次重传，沿用首次结果<br>':'')+
      '应用 '+r.applied+' · 冲突 '+r.conflicts+' · 忽略 '+r.ignored+' · 错误 '+r.errors+
      (r.recalcs&&r.recalcs.length?'<br>校准失效重算：'+r.recalcs.map(x=>x.itemId+'('+x.mode+')').join('，'):'');
    await load();
  } catch(e){ out.textContent = '回传失败：'+e.message+'（批次已保留在现场，可重试）'; await load(); }
};
document.querySelector('#fillDemo').onclick = () => {
  document.querySelector('#batchJson').value = JSON.stringify({
    batchId:'B-DEMO-'+Date.now(), source:'技师甲-船坞东',
    ops:[
      {opId:'op-demo-1',type:'field-update',itemId:new URLSearchParams(location.search).get('item')||'MR-001',field:'riggingMaterial',value:'尼龙线',baseVersion:1},
      {opId:'op-demo-2',type:'task-update',itemId:'MR-001',taskId:'T-1',field:'tension',value:'适中',baseVersion:1}
    ]
  },null,2);
};
document.querySelector('#faultOn').onclick = async ()=>{ await api('/api/fault',{method:'POST',body:JSON.stringify({on:true})}); await load(); };
document.querySelector('#faultOff').onclick = async ()=>{ await api('/api/fault',{method:'POST',body:JSON.stringify({on:false})}); await load(); };
document.querySelector('#createBtn').onclick = async ()=>{
  await api('/api/items',{method:'POST',body:JSON.stringify({
    code:document.querySelector('#newCode').value||undefined,
    shipType:document.querySelector('#newShip').value,
    mastCount:Number(document.querySelector('#newMast').value)||null,
    riggingMaterial:document.querySelector('#newMat').value,
    source:'车间建档'
  })});
  document.querySelector('#newCode').value=''; await load();
};
load();
</script>
</body>
</html>`;
}

function itemView(item) {
  return {
    id: item.id,
    code: item.fields.code || item.code || item.id,
    version: item.version,
    fields: item.fields,
    fieldProvenance: item.fieldProvenance,
    tasks: item.tasks,
    taskTombstones: item.taskTombstones,
    logs: item.logs.slice(-30),
    logCount: item.logs.length,
    conflicts: item.conflicts,
    conflictCount: openConflictsOf(item).length,
    calibration: currentCal(item),
    calibrations: item.calibrations,
  };
}

function computeStats(items) {
  const byStatus = Object.fromEntries(STAGES.map((s) => [s, 0]));
  let tasks = 0;
  for (const item of items) {
    const s = item.fields.status;
    if (byStatus[s] !== undefined) byStatus[s] += 1;
    tasks += item.tasks.length;
  }
  const openConflicts = items.reduce((n, i) => n + openConflictsOf(i).length, 0);
  const staleCalibrations = items.reduce(
    (n, i) => n + i.calibrations.filter((c) => c.state === "stale").length,
    0,
  );
  return {
    models: items.length,
    tasks,
    byStatus,
    openConflicts,
    staleCalibrations,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();

    if (req.method === "GET" && url.pathname === "/") return html(res, page());

    if (req.method === "GET" && url.pathname === "/api/items") {
      return send(res, 200, db.items.map(itemView));
    }
    const one = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (one && req.method === "GET") {
      const item = findItem(db, decodeURIComponent(one[1]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      return send(res, 200, itemView(item));
    }
    const cals = url.pathname.match(/^\/api\/items\/([^/]+)\/calibrations$/);
    if (cals && req.method === "GET") {
      const item = findItem(db, decodeURIComponent(cals[1]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      return send(res, 200, { current: currentCal(item), history: item.calibrations });
    }

    if (req.method === "GET" && url.pathname === "/api/stats") {
      return send(res, 200, computeStats(db.items));
    }

    // 建档（在线便捷接口；离线端走 sync 的 item-create 操作）
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await readBody(req);
      const id = input.id || "MR-" + randomUUID().slice(0, 8);
      const at = new Date().toISOString();
      const op = {
        opId: input.opId || "op-create-" + randomUUID(),
        type: "item-create",
        itemId: id,
        source: input.source || "车间建档",
        baseVersion: 0,
        at,
        fields: {
          code: input.fields?.code || input.code || id,
          shipType: input.fields?.shipType ?? input.shipType ?? "",
          scale: input.fields?.scale ?? input.scale ?? "",
          mastCount: input.fields?.mastCount ?? input.mastCount ?? null,
          riggingMaterial: input.fields?.riggingMaterial ?? input.riggingMaterial ?? "",
          owner: input.fields?.owner ?? input.owner ?? "",
          dueDate: input.fields?.dueDate ?? input.dueDate ?? "",
          status: input.fields?.status ?? input.status ?? "待检查",
        },
      };
      if (findItem(db, id)) return send(res, 409, { error: "item_exists" });
      const fields = op.fields;
      const prov = {};
      for (const key of ITEM_FIELDS) {
        if (fields[key] !== undefined && fields[key] !== null) {
          prov[key] = { opId: op.opId, source: op.source, baseVersion: 0, version: 1, at };
        }
      }
      const item = {
        id, code: fields.code || id, version: 1, fields,
        fieldProvenance: prov, tasks: [], taskTombstones: [],
        logs: [{ at, opId: op.opId, type: "item-create", source: op.source, baseVersion: 0, itemVersionAfter: 1, status: "applied", message: "建档 v1" }],
        calibrations: [], conflicts: [],
      };
      pushCalibration(item, { opId: op.opId, source: op.source, at, note: "建档基线校准结论" });
      db.items.unshift(item);
      db.history[op.opId] = { opId: op.opId, type: "item-create", status: "applied", itemId: id };
      await saveDb(db);
      return send(res, 201, itemView(item));
    }

    // 断网回传：先落 spool，再归并主库；主库写失败时批次保留在现场
    if (req.method === "POST" && url.pathname === "/api/sync") {
      const batch = await readBody(req);
      if (!batch.batchId || !Array.isArray(batch.ops)) return send(res, 400, { error: "malformed_batch" });
      const prior = db.completedBatches[batch.batchId];
      if (prior) {
        return send(res, 200, { ...prior, duplicate: true, note: "同号批次重传，沿用首次结果" });
      }
      const spool = await loadSpool();
      const held = spool.batches[batch.batchId];
      if (held && !batchMatches(held.batch, batch)) {
        return send(res, 409, { error: "batch_id_reused_with_different_ops", retained: held.batch.ops.map((o) => o.opId) });
      }
      spool.batches[batch.batchId] = {
        batch,
        receivedAt: held?.receivedAt || new Date().toISOString(),
        lastSentAt: new Date().toISOString(),
      };
      await saveSpool(spool);

      try {
        const summary = processBatch(db, batch, {});
        await saveDb(db);
        await removeSpooled(spool, batch.batchId);
        return send(res, 200, summary);
      } catch (error) {
        spool.batches[batch.batchId].lastError = error.message;
        spool.batches[batch.batchId].failedAt = new Date().toISOString();
        await saveSpool(spool);
        return send(res, 503, {
          error: "write_failed",
          retained: true,
          batchId: batch.batchId,
          message: "主库写入失败，现场批次已保留，请按原操作号重试",
          detail: error.message,
        });
      }
    }

    // 现场保留的批次
    if (req.method === "GET" && url.pathname === "/api/sync/pending") {
      const spool = await loadSpool();
      return send(res, 200, {
        batches: Object.values(spool.batches).map((s) => ({
          batchId: s.batch.batchId,
          source: s.batch.source,
          opCount: s.batch.ops.length,
          opIds: s.batch.ops.map((o) => o.opId),
          receivedAt: s.receivedAt,
          lastSentAt: s.lastSentAt,
          lastError: s.lastError,
          failedAt: s.failedAt,
        })),
      });
    }

    // 按原批次号/操作号重试（客户端也可直接重 POST /api/sync，二者等价）
    const retry = url.pathname.match(/^\/api\/sync\/retry\/([^/]+)$/);
    if (retry && req.method === "POST") {
      const batchId = decodeURIComponent(retry[1]);
      const spool = await loadSpool();
      const held = spool.batches[batchId];
      if (!held) return send(res, 404, { error: "batch_not_held", batchId });
      try {
        const summary = processBatch(db, held.batch, { replayed: true });
        await saveDb(db);
        await removeSpooled(spool, batchId);
        return send(res, 200, summary);
      } catch (error) {
        held.lastError = error.message;
        held.failedAt = new Date().toISOString();
        await saveSpool(spool);
        return send(res, 503, { error: "write_failed", retained: true, batchId, detail: error.message });
      }
    }

    // 冲突裁决：在保留的几份意见里选一份生效
    const resolve = url.pathname.match(/^\/api\/items\/([^/]+)\/conflicts\/([^/]+)\/resolve$/);
    if (resolve && req.method === "POST") {
      const item = findItem(db, decodeURIComponent(resolve[1]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      const conflict = item.conflicts.find((c) => c.id === decodeURIComponent(resolve[2]));
      if (!conflict) return send(res, 404, { error: "conflict_not_found" });
      if (conflict.status !== "open") return send(res, 409, { error: "conflict_closed", status: conflict.status });
      const input = await readBody(req);
      const idx = Number.isInteger(input.optionIndex) ? input.optionIndex : input.optionIndex;
      const chosen = conflict.options[idx];
      if (!chosen) return send(res, 400, { error: "bad_option" });
      const at = new Date().toISOString();
      const resolveOpId = "op-resolve-" + conflict.id;
      let affectsDependency = false;

      if (conflict.kind === "field") {
        item.fields[conflict.field] = chosen.value;
        bump(item);
        item.fieldProvenance[conflict.field] = {
          opId: chosen.opId, source: chosen.source + "（裁决采纳）",
          baseVersion: chosen.baseVersion, version: item.version, at,
          resolvedBy: resolveOpId,
        };
        affectsDependency = DEP_FIELDS.has(conflict.field);
      } else if (conflict.kind === "task-field") {
        const task = findTask(item, conflict.taskId);
        if (!task) return send(res, 409, { error: "task_gone" });
        task[conflict.field] = chosen.value;
        bump(item);
        task.fieldProvenance[conflict.field] = {
          opId: chosen.opId, source: chosen.source + "（裁决采纳）",
          baseVersion: chosen.baseVersion, version: item.version, at,
          resolvedBy: resolveOpId,
        };
        affectsDependency = conflict.field === "position";
      } else if (conflict.kind === "task-add") {
        const task = findTask(item, conflict.taskId);
        if (!task) return send(res, 409, { error: "task_gone" });
        bump(item);
        for (const key of TASK_FIELDS) {
          task[key] = chosen.value[key] ?? task[key];
          task.fieldProvenance[key] = {
            opId: chosen.opId, source: chosen.source + "（裁决采纳）",
            baseVersion: chosen.baseVersion, version: item.version, at,
            resolvedBy: resolveOpId,
          };
        }
        affectsDependency = true;
      }

      conflict.status = "resolved";
      conflict.resolved = { at, optionIndex: idx, by: input.by || "值班调度", opId: resolveOpId };
      item.logs.push({
        at, opId: resolveOpId, type: "resolve", source: input.by || "值班调度",
        baseVersion: chosen.baseVersion, itemVersionAfter: item.version,
        status: "applied",
        message: `裁决 ${conflict.target}：采纳 ${chosen.source} 的意见（${typeof chosen.value === "object" ? JSON.stringify(chosen.value) : chosen.value}）`,
      });
      if (affectsDependency) {
        recalibrateIfNeeded(item, { opId: resolveOpId, source: "冲突裁决", at });
      }
      await saveDb(db);
      return send(res, 200, itemView(item));
    }

    // 历史操作查询（审计：每笔带操作号/基准版本/来源）
    if (req.method === "GET" && url.pathname === "/api/history") {
      return send(res, 200, db.history);
    }

    // 故障注入：模拟主库写入失败（spool 不受影响）
    if (req.method === "POST" && url.pathname === "/api/fault") {
      const input = await readBody(req);
      db.fault = !!input.on;
      await saveDb(db, { force: true });
      return send(res, 200, { fault: db.fault });
    }
    if (req.method === "GET" && url.pathname === "/api/fault") {
      return send(res, 200, { fault: !!db.fault });
    }

    return send(res, 404, { error: "not_found" });
  } catch (error) {
    return send(res, 500, { error: error.message });
  }
});

async function removeSpooled(spool, batchId) {
  if (spool.batches[batchId]) {
    delete spool.batches[batchId];
    await saveSpool(spool);
  }
}
function batchMatches(held, incoming) {
  if (!held) return false;
  return held.batchId === incoming.batchId && JSON.stringify(held.ops) === JSON.stringify(incoming.ops);
}

server.listen(port, () => console.log("古船模型帆索校准（断网合并版） listening on http://localhost:" + port));
