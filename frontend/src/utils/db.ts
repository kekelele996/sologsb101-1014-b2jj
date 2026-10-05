/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 两侧分账：
 *   · 苗圃侧：seedlings（进场数量 + 供苗保证率）、settlements（批次结算单）
 *   · 项目部侧：plantings（栽植领用，含挂起状态）、surveys（整块地验收测次）
 *   · 苗圃那份（结算单）保存失败只重试苗圃本侧（nurseryQueue），项目部保存照旧。
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling, SeedlingDraft } from '../types/seedling';
import type { Planting, PlantingDraft } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { Settlement } from '../types/settlement';
import { rateLevel } from './rate';
import { nowIso, today, uuid } from './id';
import { seedDatabase } from './seed';
import { ROW_REVISION } from './revision';
import {
  collectShortfalls,
  planSettlementSync,
  resolvePlantingStatuses,
} from './settlement';
import {
  dequeueNurseryRetry,
  enqueueNurseryRetry,
  listNurseryRetry,
} from './nurseryQueue';

export { ROW_REVISION } from './revision';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;
  /** 苗圃侧：批次结算单（低于供苗保证率的差额，待项目部确认） */
  settlements!: Table<Settlement, string>;

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

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
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
            row.revision = ROW_REVISION;
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

    // ---------- v3：苗圃 / 项目部分账 ----------
    // seedlings 增加保证率；plantings 增加挂起状态；新增 settlements 结算单表。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity, guaranteeRate',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM, status',
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
        settlements: 'id, seedlingId, plotId, surveyId, status, [seedlingId+surveyId]',
      })
      .upgrade(async (tx) => {
        // 历史数据没记供苗保证率：自育苗不考核（null），外购按八成补上。
        await tx
          .table('seedlings')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.guaranteeRate !== 'number' && row.guaranteeRate !== null) {
              row.guaranteeRate = row.source === '外购' ? 80 : null;
            }
          });

        // 历史栽植记录：按栽植日期累计重算在库 / 挂起（超出进场数量的先挂起）。
        const [seedlingRows, plantingRows] = await Promise.all([
          tx.table('seedlings').toCollection().toArray() as Promise<Seedling[]>,
          tx.table('plantings').toCollection().toArray() as Promise<Planting[]>,
        ]);
        const quantityByBatch = new Map(seedlingRows.map((row) => [row.id, row.quantity] as const));
        const byBatch = new Map<string, Planting[]>();
        plantingRows.forEach((row) => {
          const list = byBatch.get(row.seedlingId) ?? [];
          list.push(row);
          byBatch.set(row.seedlingId, list);
        });
        for (const [seedlingId, rows] of byBatch) {
          const quantity = quantityByBatch.get(seedlingId) ?? 0;
          const resolved = resolvePlantingStatuses(rows, quantity);
          for (const item of resolved) {
            // 同步写回数据库
            await tx.table('plantings').update(item.id, {
              status: item.status,
              overQuantity: item.overQuantity,
            });
            // 同步更新内存对象：后面的短差摊回依赖 status 字段（旧行没有该字段）
            const target = rows.find((row) => row.id === item.id);
            if (target) {
              target.status = item.status;
              target.overQuantity = item.overQuantity;
            }
          }
        }

        // 为旧数据按最新短差补开待确认结算单（仅外购保证率批次存在差额时）。
        const [surveyRows, plotRows, replantRows] = await Promise.all([
          tx.table('surveys').toCollection().toArray() as Promise<Survey[]>,
          tx.table('plots').toCollection().toArray() as Promise<Plot[]>,
          tx.table('replants').toCollection().toArray() as Promise<Replant[]>,
        ]);
        const stamp = nowIso();
        for (const plot of plotRows) {
          const shortfalls = collectShortfalls(plot.id, seedlingRows, plantingRows, surveyRows);
          const settlements: Settlement[] = shortfalls.map((item) => ({
            id: uuid('settlement'),
            seedlingId: item.seedlingId,
            plotId: plot.id,
            surveyId: item.survey.id,
            round: item.survey.round,
            surveyDate: item.survey.date,
            issuedCount: item.share.issued,
            aliveCount: item.share.alive,
            batchRate: item.share.rate,
            guaranteeRate: item.guaranteeRate,
            shortRate: item.shortRate,
            shortCount: item.shortCount,
            status: '待确认',
            confirmedAt: '',
            remark: '',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          }));
          if (settlements.length > 0) {
            await tx.table('settlements').bulkAdd(settlements);
          }
        }
        void replantRows;
      });
  }
}

export const db = new MangroveDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 * 打开后顺手重放苗圃侧保存失败的结算单待办（只重试苗圃本侧）。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
      await retryNurserySettlements();
    })();
  }
  return initPromise;
}

/* ----------------------- 苗圃侧结算：本侧重试语义 ----------------------- */

/**
 * 按当前数据重算某地块的全部待确认结算单（只写 settlements 一张苗圃表）。
 * - 已确认 / 已驳回的单据不动；
 * - 短差消失的待确认单据自动撤单；
 * - 失败时抛错，由调用方决定是否挂进苗圃本侧重试队列。
 */
export async function syncSettlementsForPlot(plotId: string): Promise<void> {
  const [seedlings, plantings, surveys, existing] = await Promise.all([
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.settlements.where('plotId').equals(plotId).toArray(),
  ]);
  const shortfalls = collectShortfalls(plotId, seedlings, plantings, surveys);
  const plan = planSettlementSync(existing, shortfalls);
  await db.transaction('rw', db.settlements, async () => {
    if (plan.put.length > 0) await db.settlements.bulkPut(plan.put);
    if (plan.remove.length > 0) await db.settlements.bulkDelete(plan.remove);
  });
}

/**
 * 苗圃侧保存尝试：立即重算一次；失败只把本侧待办挂进重试队列，
 * 不影响项目部侧已经成功的栽植 / 验收写入。
 */
export async function settleNursery(plotId: string, reason: string): Promise<void> {
  try {
    await syncSettlementsForPlot(plotId);
    dequeueNurseryRetry(plotId);
  } catch (error) {
    const message = error instanceof Error ? error.message : '苗圃侧保存失败';
    enqueueNurseryRetry(plotId, `${reason}：${message}`);
  }
}

/** 重放全部苗圃侧保存失败待办；单个失败的继续保留在队列里 */
export async function retryNurserySettlements(): Promise<{ success: number; remain: number }> {
  const items = listNurseryRetry();
  let success = 0;
  for (const item of items) {
    try {
      // 待办里只记 plotId：幂等重放当前最新数据
      // eslint-disable-next-line no-await-in-loop
      await syncSettlementsForPlot(item.plotId);
      dequeueNurseryRetry(item.plotId);
      success += 1;
    } catch {
      /* 本侧仍失败：保留在队列，下次再试；项目部侧不受影响 */
    }
  }
  return { success, remain: listNurseryRetry().length };
}

/* -------------------------------- 地块 -------------------------------- */

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

/** 删除地块并级联清理其下苗木批次、栽植、验收、补植计划与结算单 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.settlements],
    async () => {
      await db.seedlings.where('plotId').equals(id).delete();
      await db.plantings.where('plotId').equals(id).delete();
      await db.surveys.where('plotId').equals(id).delete();
      await db.replants.where('plotId').equals(id).delete();
      await db.settlements.where('plotId').equals(id).delete();
      await db.plots.delete(id);
    },
  );
}

/* ------------------------------ 苗木批次（苗圃侧） ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function getSeedling(id: string): Promise<Seedling | undefined> {
  return db.seedlings.get(id);
}

/**
 * 苗圃侧保存批次：登记进场数量与供苗保证率，并在同一本地事务内
 * 按新进场数量重算引用批次的领用在库 / 挂起状态；
 * 之后触发苗圃侧结算单重算（失败进本侧重试队列）。
 */
export async function saveSeedling(input: { id?: string; draft: SeedlingDraft }): Promise<Seedling> {
  const existing = input.id ? await db.seedlings.get(input.id) : undefined;
  const stamp = nowIso();
  const row: Seedling = {
    id: existing?.id ?? input.id ?? uuid('seedling'),
    plotId: input.draft.plotId,
    species: input.draft.species,
    source: input.draft.source,
    spec: input.draft.spec,
    quantity: input.draft.quantity,
    guaranteeRate: input.draft.guaranteeRate,
    arrivalDate: input.draft.arrivalDate,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  await db.transaction('rw', db.seedlings, db.plantings, async () => {
    await db.seedlings.put(row);
    const rows = await db.plantings.where('seedlingId').equals(row.id).toArray();
    const resolved = resolvePlantingStatuses(rows, row.quantity);
    for (const item of resolved) {
      const current = rows.find((planting) => planting.id === item.id);
      if (current && (current.status !== item.status || current.overQuantity !== item.overQuantity)) {
        await db.plantings.update(item.id, {
          status: item.status,
          overQuantity: item.overQuantity,
          updatedAt: stamp,
        });
      }
    }
  });
  await settleNursery(row.plotId, '苗木批次保存后重算结算单');
  return row;
}

export async function removeSeedling(id: string): Promise<void> {
  await db.transaction('rw', db.seedlings, db.plantings, db.settlements, async () => {
    // 该批次已被栽植记录引用时一并清理，避免出现悬空引用
    await db.plantings.where('seedlingId').equals(id).delete();
    await db.settlements.where('seedlingId').equals(id).delete();
    await db.seedlings.delete(id);
  });
}

/* ------------------------------- 栽植领用（项目部侧） ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

/** 按批次进场数量重算一批领用的在库 / 挂起状态，返回发生变化的行数 */
async function reflowBatchStatuses(seedlingIds: Iterable<string>, stamp: string): Promise<Set<string>> {
  const affectedPlots = new Set<string>();
  for (const seedlingId of seedlingIds) {
    const [seedling, rows] = await Promise.all([
      db.seedlings.get(seedlingId),
      db.plantings.where('seedlingId').equals(seedlingId).toArray(),
    ]);
    rows.forEach((row) => affectedPlots.add(row.plotId));
    if (!seedling) continue;
    const resolved = resolvePlantingStatuses(rows, seedling.quantity);
    for (const item of resolved) {
      const current = rows.find((row) => row.id === item.id);
      if (current && (current.status !== item.status || current.overQuantity !== item.overQuantity)) {
        await db.plantings.update(item.id, {
          status: item.status,
          overQuantity: item.overQuantity,
          updatedAt: stamp,
        });
      }
    }
  }
  return affectedPlots;
}

/**
 * 项目部侧保存领用：领用挑苗圃当时在库的批次；累计超出进场数量的部分先挂起，
 * 不参与测次成活株数摊回。保存后触发苗圃侧结算重算（失败只重试苗圃本侧）。
 */
export async function savePlanting(input: { id?: string; draft: PlantingDraft }): Promise<Planting> {
  const old = input.id ? await db.plantings.get(input.id) : undefined;
  const stamp = nowIso();
  // 新行先按「在库」落库，再由按日期累计的重算决定是否挂起，保证同一口径
  const row: Planting = {
    id: old?.id ?? input.id ?? uuid('planting'),
    plotId: input.draft.plotId,
    seedlingId: input.draft.seedlingId,
    plantDate: input.draft.plantDate,
    spacingM: input.draft.spacingM,
    count: input.draft.count,
    operator: input.draft.operator,
    status: old?.status ?? 'active',
    overQuantity: old?.overQuantity ?? 0,
    createdAt: old?.createdAt ?? stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  const batchIds = new Set<string>([row.seedlingId]);
  if (old && old.seedlingId !== row.seedlingId) batchIds.add(old.seedlingId);

  await db.transaction('rw', db.plantings, db.seedlings, async () => {
    await db.plantings.put(row);
    await reflowBatchStatuses(batchIds, stamp);
  });

  // 回读重算后的本行状态（可能已被挂起），保证调用方提示与库里一致
  const saved = await db.plantings.get(row.id);

  // 项目部保存照旧返回；苗圃那份失败只进本侧重试队列
  const plotIds = new Set<string>([row.plotId]);
  if (old) plotIds.add(old.plotId);
  for (const plotId of plotIds) {
    // eslint-disable-next-line no-await-in-loop
    await settleNursery(plotId, '栽植领用变更后重算结算单');
  }
  return saved ?? row;
}

export async function removePlanting(id: string): Promise<void> {
  const existing = await db.plantings.get(id);
  await db.transaction('rw', db.plantings, db.seedlings, async () => {
    await db.plantings.delete(id);
    if (existing) await reflowBatchStatuses([existing.seedlingId], nowIso());
  });
  if (existing) await settleNursery(existing.plotId, '删除领用后重算结算单');
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

/** 项目部侧保存测次后，触发苗圃侧把成活株数摊回批次、重算结算单 */
export async function saveSurvey(row: Survey): Promise<void> {
  await putSurvey(row);
  await settleNursery(row.plotId, '验收测次保存后摊回批次成活率');
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
  const existing = await db.surveys.get(id);
  await db.surveys.delete(id);
  // 测次删除后，苗圃侧撤掉与之相关、短差已消失的待确认结算单
  if (existing) await settleNursery(existing.plotId, '删除测次后重算结算单');
}

/* ------------------------------ 补植计划 ------------------------------ */

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
 * 1）扣减地块缺株数；2）写入最近补植日期；3）按补植后的总株数重算最新一次验收的成活率。
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

    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const total = plantings.reduce((acc, item) => acc + item.count, 0);
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
  const replant = await db.replants.get(replantId);
  if (replant) await settleNursery(replant.plotId, '补植回写后重算批次结算单');
}

/** 推进补植状态（待补植 → 已补植 → 已复核），推进到「已补植」时触发回写 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
  if (next === '已补植') {
    await applyReplantCompletion(replantId);
  }
}

/* ------------------------------ 批次结算单（苗圃侧） ------------------------------ */

export async function listSettlements(): Promise<Settlement[]> {
  const rows = await db.settlements.toArray();
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 项目部确认结算差额 */
export async function confirmSettlement(id: string): Promise<void> {
  await db.settlements.update(id, { status: '已确认', confirmedAt: today(), updatedAt: nowIso() });
}

/** 项目部驳回结算差额（需填写原因） */
export async function rejectSettlement(id: string, remark: string): Promise<void> {
  await db.settlements.update(id, {
    status: '已驳回',
    confirmedAt: today(),
    remark: remark.trim(),
    updatedAt: nowIso(),
  });
}

/** 删除结算单（一般只允许苗圃侧删除待确认单据） */
export async function removeSettlement(id: string): Promise<void> {
  await db.settlements.delete(id);
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
  settlements: Settlement[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants, settlements] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
    db.settlements.toArray(),
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
    settlements,
  };
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.settlements],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.settlements.clear(),
      ]);
      await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
      // 兼容 v2 旧存档：没有在库 / 挂起字段的领用先补默认值，再统一按进场数量重算
      await db.plantings.bulkPut(
        snapshot.plantings.map((row): Planting => ({
          ...row,
          status: row.status ?? 'active',
          overQuantity: row.overQuantity ?? 0,
          revision: ROW_REVISION,
        })),
      );
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.settlements.bulkPut(
        (snapshot.settlements ?? []).map((row) => ({ ...row, revision: ROW_REVISION })),
      );
    },
  );
  // 导入后以当前数据口径统一重算一遍在库状态与结算单
  const stamp = nowIso();
  const seedlingIds = await db.seedlings.toCollection().primaryKeys();
  await db.transaction('rw', db.plantings, db.seedlings, async () => {
    await reflowBatchStatuses(seedlingIds, stamp);
  });
  const plots = await db.plots.toCollection().primaryKeys();
  for (const plotId of plots) {
    // eslint-disable-next-line no-await-in-loop
    await settleNursery(plotId, '导入存档后重算结算单');
  }
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.settlements],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.settlements.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, settlements] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    db.settlements.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, settlements };
}
