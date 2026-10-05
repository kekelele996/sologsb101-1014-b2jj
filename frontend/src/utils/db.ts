/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - v3：苗圃 / 项目部两摊分家
 *   · 苗圃侧：seedlings（进场数量 + 供苗保证率）、nurseryOutflows（供苗流水账）、
 *     settlements（批次差额结算单）
 *   · 项目部侧：plots、plantings（栽植领用 + 挂起）、surveys、replants
 *   · outbox：任一侧保存失败后只重试本侧动作
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { NurseryOutflow, OutboxKind, OutboxStatus, OutboxTask, Side } from '../types/ledger';
import type { Settlement } from '../types/settlement';
import { rateLevel } from './rate';
import { PURCHASED_DEFAULT_GUARANTEE_RATE } from '../types/seedling';
import { nowIso, today, uuid } from './id';
import { seedDatabase } from './seed';
import { apportionAliveToBatches, buildSettlementRows } from './batch';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class MangroveDatabase extends Dexie {
  // 项目部侧
  plots!: Table<Plot, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;
  // 苗圃侧
  seedlings!: Table<Seedling, string>;
  nurseryOutflows!: Table<NurseryOutflow, string>;
  settlements!: Table<Settlement, string>;
  // 跨侧重试
  outbox!: Table<OutboxTask, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段 ----------
    this.version(2)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = 2;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：苗圃 / 项目部分家 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        // 苗圃批次不再归属地块（去掉 plotId 索引，Dexie 升级时保留旧字段值，由迁移清理）
        seedlings: 'id, species, source, arrivalDate, quantity, guaranteeRate',
        // 栽植领用增加落实株数与状态
        plantings: 'id, plotId, seedlingId, plantDate, spacingM, status',
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
        nurseryOutflows: 'id, seedlingId, plotId, plantingId, action, date',
        settlements: 'id, seedlingId, plotId, surveyId, round, status',
        outbox: 'id, side, kind, status, dedupeKey',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();

        // 迁移 1：所有行 revision 升到 v3
        for (const name of ['plots', 'seedlings', 'plantings', 'surveys', 'replants']) {
          await tx.table(name).toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
          });
        }

        // 迁移 2：旧批次没记供苗保证率 —— 自育苗不考核（null），外购按八成补上
        await tx.table('seedlings').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.guaranteeRate !== 'number' && row.guaranteeRate !== null) {
            row.guaranteeRate = row.source === '外购' ? PURCHASED_DEFAULT_GUARANTEE_RATE : null;
          }
          // 批次改为苗圃全局资源：去掉旧的地块归属（地块关系由领用记录承载）
          delete row.plotId;
        });

        // 迁移 3：历史栽植全部视为「已落实」（旧系统领用即出库，没有挂起概念）
        await tx.table('plantings').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.fulfilledCount !== 'number') {
            row.fulfilledCount = typeof row.count === 'number' ? row.count : 0;
          }
          row.status = '已落实';
        });

        // 迁移 4：把历史领用补登成苗圃自己的供苗流水账（各记各的，苗圃侧独立留痕）
        const plantings = await tx.table('plantings').toArray();
        const outflows: NurseryOutflow[] = plantings.map((row: Planting) => ({
          id: `outflow-${row.id}`,
          seedlingId: row.seedlingId,
          plotId: row.plotId,
          plantingId: row.id,
          action: '领用出库',
          count: row.fulfilledCount,
          date: row.plantDate,
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        }));
        if (outflows.length > 0) await tx.table('nurseryOutflows').bulkPut(outflows);

        // 迁移 5：按各地块最新测次把成活株数摊回批次，历史差额补进结算单（待项目部确认）
        const [plots, seedlings, surveys] = await Promise.all([
          tx.table('plots').toCollection().toArray() as Promise<Plot[]>,
          tx.table('seedlings').toCollection().toArray() as Promise<Seedling[]>,
          tx.table('surveys').toCollection().toArray() as Promise<Survey[]>,
        ]);
        const seedlingById = new Map(seedlings.map((row) => [row.id, row]));
        const settlements: Settlement[] = [];
        for (const plot of plots) {
          const plotSurveys = surveys
            .filter((row) => row.plotId === plot.id)
            .sort((a: Survey, b: Survey) => a.round - b.round);
          const latest = plotSurveys[plotSurveys.length - 1] as Survey | undefined;
          if (!latest) continue;
          const shares = apportionAliveToBatches(latest, plantings);
          settlements.push(...buildSettlementRows(latest, shares, seedlingById, new Map()));
        }
        if (settlements.length > 0) await tx.table('settlements').bulkPut(settlements);
      });
  }
}

export const db = new MangroveDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
      // 启动时自动补提两侧保存失败遗留的本侧重试任务
      await processOutbox();
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块（项目部侧） -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
}

/**
 * 删除地块（项目部侧动作）。
 * 项目部只管删掉自己这摊：领用 / 验收 / 补植随地块清理；
 * 苗圃侧的流水账与结算单不在这里动，另挂一条苗圃侧清理任务（失败只重试苗圃侧）。
 */
export async function removeProjectPlot(id: string): Promise<void> {
  await db.transaction('rw', db.plots, db.plantings, db.surveys, db.replants, async () => {
    await db.plantings.where('plotId').equals(id).delete();
    await db.surveys.where('plotId').equals(id).delete();
    await db.replants.where('plotId').equals(id).delete();
    await db.plots.delete(id);
  });
}

/** 苗圃侧：冲销地块相关流水账与结算单（由 outbox 重放调用） */
export async function purgeNurseryPlot(plotId: string): Promise<void> {
  await db.transaction('rw', db.nurseryOutflows, db.settlements, async () => {
    await db.nurseryOutflows.where('plotId').equals(plotId).delete();
    await db.settlements.where('plotId').equals(plotId).delete();
  });
}

/* ------------------------------ 苗木批次（苗圃侧） ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function getSeedling(id: string): Promise<Seedling | undefined> {
  return db.seedlings.get(id);
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/**
 * 删除批次（苗圃侧）：只允许删除从未被项目部领用的批次，
 * 已被领用引用时抛错——项目部的领用账不随苗圃删批次而悬空。
 */
export async function removeSeedling(id: string): Promise<void> {
  const used = await db.plantings.where('seedlingId').equals(id).count();
  if (used > 0) {
    throw new Error('该批次已被项目部领用，不能删除；可等领用结清后再处理。');
  }
  await db.transaction('rw', db.seedlings, db.nurseryOutflows, db.settlements, async () => {
    await db.nurseryOutflows.where('seedlingId').equals(id).delete();
    await db.settlements.where('seedlingId').equals(id).delete();
    await db.seedlings.delete(id);
  });
}

/* ----------------------------- 栽植领用（项目部侧） ----------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function putPlanting(row: Planting): Promise<void> {
  const status =
    row.fulfilledCount <= 0 ? '挂起' : row.fulfilledCount < row.count ? '部分挂起' : '已落实';
  await db.plantings.put({ ...row, status, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePlanting(id: string): Promise<void> {
  await db.plantings.delete(id);
}

/* ------------------------------- 验收（项目部侧） ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 批量调整成活率等级（人工复核覆盖） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/* ------------------------------ 补植计划（项目部侧） ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putReplant(row: Replant): Promise<void> {
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/**
 * 补植完成回写：
 * 1）扣减地块缺株数；2）写入最近补植日期；3）按补植后的已落实株数重算最新一次验收的成活率。
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;

    const nextMissing = Math.max(0, plot.missingCount - replant.missingCount);
    await db.plots.update(plot.id, {
      missingCount: nextMissing,
      lastReplantDate: today(),
      updatedAt: nowIso(),
    });

    // 栽植总株数只算已落实领用（挂起部分尚未在地块上栽植）
    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const total = plantings.reduce((acc, item) => acc + item.fulfilledCount, 0);
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    if (surveys.length === 0) return;
    const latest = surveys.reduce((acc, item) => (item.round > acc.round ? item : acc));
    // 补植后按「原成活株数 + 本次补植株数」重新计算成活率
    const aliveAfter = latest.aliveCount + replant.missingCount;
    const rate = total > 0 ? Math.round(Math.min(100, (aliveAfter / total) * 100) * 10) / 10 : latest.survivalRate;
    await db.surveys.update(latest.id, {
      aliveCount: aliveAfter,
      survivalRate: rate,
      grade: latest.gradeManual ? latest.grade : rateLevel(rate),
      updatedAt: nowIso(),
    });
  });
}

/** 推进补植状态（待补植 → 已补植 → 已复核），推进到「已补植」时触发回写 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
  if (next === '已补植') {
    await applyReplantCompletion(replantId);
  }
}

/* ------------------------ 苗圃供苗流水账 & 批次结算单（苗圃侧） ------------------------ */

export async function listNurseryOutflows(): Promise<NurseryOutflow[]> {
  const rows = await db.nurseryOutflows.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

export async function listSettlements(): Promise<Settlement[]> {
  const rows = await db.settlements.toArray();
  return rows.sort((a, b) => b.round - a.round || a.status.localeCompare(b.status));
}

/**
 * 苗圃侧动作 1：按项目部的栽植领用重建供苗流水账（幂等）。
 * 一份领用对应一条出库流水；被删除的领用由重算结果自然剔除。
 */
export async function syncNurseryOutflows(): Promise<void> {
  const plantings = await db.plantings.toArray();
  const stamp = nowIso();
  const rows: NurseryOutflow[] = plantings
    .filter((row) => row.fulfilledCount > 0)
    .map((row) => ({
      id: `outflow-${row.id}`,
      seedlingId: row.seedlingId,
      plotId: row.plotId,
      plantingId: row.id,
      action: '领用出库',
      count: row.fulfilledCount,
      date: row.plantDate,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }));
  await db.transaction('rw', db.nurseryOutflows, async () => {
    const keep = new Set(rows.map((row) => row.id));
    const stale = (await db.nurseryOutflows.toArray()).filter((row) => !keep.has(row.id));
    if (stale.length > 0) await db.nurseryOutflows.bulkDelete(stale.map((row) => row.id));
    if (rows.length > 0) await db.nurseryOutflows.bulkPut(rows);
  });
}

/**
 * 苗圃侧动作 2：按各地块最新测次把成活株数摊回批次，重建批次结算单（幂等）。
 * 低于供苗保证率的差额才进结算单；已确认且差额未变的行保留确认状态。
 */
export async function rebuildSettlements(): Promise<void> {
  const [plots, plantings, surveys, seedlings, previousRows] = await Promise.all([
    db.plots.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.seedlings.toArray(),
    db.settlements.toArray(),
  ]);
  const seedlingById = new Map(seedlings.map((row) => [row.id, row]));
  const previous = new Map(previousRows.map((row) => [row.id, row]));
  const next: Settlement[] = [];
  for (const plot of plots) {
    const plotSurveys = surveys.filter((row) => row.plotId === plot.id).sort((a, b) => a.round - b.round);
    const latest = plotSurveys[plotSurveys.length - 1];
    if (!latest) continue;
    const shares = apportionAliveToBatches(latest, plantings);
    next.push(...buildSettlementRows(latest, shares, seedlingById, previous));
  }
  const stamp = nowIso();
  await db.transaction('rw', db.settlements, async () => {
    const keep = new Set(next.map((row) => row.id));
    const stale = previousRows.filter((row) => !keep.has(row.id));
    if (stale.length > 0) await db.settlements.bulkDelete(stale.map((row) => row.id));
    if (next.length > 0) {
      await db.settlements.bulkPut(next.map((row) => (row.createdAt ? row : { ...row, createdAt: stamp })));
    }
  });
}

/** 项目部确认 / 取消确认结算差额行 */
export async function setSettlementStatus(id: string, status: Settlement['status']): Promise<void> {
  await db.settlements.update(id, {
    status,
    confirmedAt: status === '已确认' ? nowIso() : '',
    updatedAt: nowIso(),
  });
}

/* --------------------------- 跨侧重试队列（各重试各的） --------------------------- */

/**
 * 挂一条跨侧动作的本侧重试任务。
 * 同 dedupeKey 的任务只保留一条：重复触发不会堆积，重放始终跑最新状态（幂等重建）。
 */
export async function enqueueOutbox(input: {
  side: Side;
  kind: OutboxKind;
  refId: string;
  injected?: boolean;
}): Promise<void> {
  const dedupeKey = `${input.kind}:${input.refId}`;
  const existing = await db.outbox.where('dedupeKey').equals(dedupeKey).first();
  const stamp = nowIso();
  if (existing) {
    await db.outbox.update(existing.id, {
      status: 'pending',
      lastError: '',
      injected: existing.injected || input.injected === true,
      updatedAt: stamp,
    });
    return;
  }
  const row: OutboxTask = {
    id: uuid('outbox'),
    side: input.side,
    kind: input.kind,
    dedupeKey,
    refId: input.refId,
    status: 'pending',
    lastError: '',
    attempts: 0,
    injected: input.injected === true,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  await db.outbox.put(row);
}

/** 任务处理器：只执行本侧动作，互不影响另一侧 */
const OUTBOX_HANDLERS: Record<OutboxKind, (refId: string) => Promise<void>> = {
  'outflow-sync': () => syncNurseryOutflows(),
  'settlement-sync': () => rebuildSettlements(),
  'plot-purge': (plotId) => purgeNurseryPlot(plotId),
};

export async function listOutbox(status?: OutboxStatus): Promise<OutboxTask[]> {
  const rows = status ? await db.outbox.where('status').equals(status).toArray() : await db.outbox.toArray();
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 清除故障注入标记（用于演示「关掉故障开关后重试成功」） */
export async function clearOutboxInjection(id: string): Promise<void> {
  await db.outbox.update(id, { injected: false, lastError: '', updatedAt: nowIso() });
}

export async function removeOutboxTask(id: string): Promise<void> {
  await db.outbox.delete(id);
}

/**
 * 重放待处理任务。关键语义：
 * - 只跑各任务归属侧（side）的动作，项目部侧保存成功的数据绝不回滚；
 * - 仍失败的任务留在队列里（failed/pending），下次再试，不影响别的任务。
 * @param shouldFail 故障注入：返回 true 时该任务本次保存失败
 */
export async function processOutbox(shouldFail?: (task: OutboxTask) => boolean): Promise<{ done: number; failed: number }> {
  const pending = await db.outbox.where('status').anyOf('pending', 'failed').toArray();
  let done = 0;
  let failed = 0;
  for (const task of pending) {
    if (shouldFail?.(task)) {
      await db.outbox.update(task.id, {
        status: 'failed',
        attempts: task.attempts + 1,
        lastError: '模拟该侧保存失败（故障注入中）',
        updatedAt: nowIso(),
      });
      failed += 1;
      continue;
    }
    try {
      await OUTBOX_HANDLERS[task.kind](task.refId);
      await db.outbox.update(task.id, {
        status: 'done',
        lastError: '',
        injected: false,
        attempts: task.attempts + 1,
        updatedAt: nowIso(),
      });
      done += 1;
    } catch (error) {
      await db.outbox.update(task.id, {
        status: 'failed',
        attempts: task.attempts + 1,
        lastError: error instanceof Error ? error.message : '本侧重试失败',
        updatedAt: nowIso(),
      });
      failed += 1;
    }
  }
  return { done, failed };
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
  nurseryOutflows: NurseryOutflow[];
  settlements: Settlement[];
  outbox: OutboxTask[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants, nurseryOutflows, settlements, outbox] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
    db.nurseryOutflows.toArray(),
    db.settlements.toArray(),
    db.outbox.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    plantings,
    surveys,
    replants,
    nurseryOutflows,
    settlements,
    outbox,
  };
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.plots,
      db.seedlings,
      db.plantings,
      db.surveys,
      db.replants,
      db.nurseryOutflows,
      db.settlements,
      db.outbox,
    ],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.nurseryOutflows.clear(),
        db.settlements.clear(),
        db.outbox.clear(),
      ]);
      await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
      if (Array.isArray(snapshot.nurseryOutflows)) {
        await db.nurseryOutflows.bulkPut(snapshot.nurseryOutflows.map((row) => ({ ...row, revision: ROW_REVISION })));
      }
      if (Array.isArray(snapshot.settlements)) {
        await db.settlements.bulkPut(snapshot.settlements.map((row) => ({ ...row, revision: ROW_REVISION })));
      }
      if (Array.isArray(snapshot.outbox)) {
        await db.outbox.bulkPut(snapshot.outbox.map((row) => ({ ...row, revision: ROW_REVISION })));
      }
    },
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.plots,
      db.seedlings,
      db.plantings,
      db.surveys,
      db.replants,
      db.nurseryOutflows,
      db.settlements,
      db.outbox,
    ],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.nurseryOutflows.clear(),
        db.settlements.clear(),
        db.outbox.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, nurseryOutflows, settlements, outbox] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    db.nurseryOutflows.count(),
    db.settlements.count(),
    db.outbox.where('status').anyOf('pending', 'failed').count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, nurseryOutflows, settlements, outboxRetry: outbox };
}
