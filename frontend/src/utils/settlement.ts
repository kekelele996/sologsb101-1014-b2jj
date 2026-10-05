/**
 * 两侧对账与批次结算纯逻辑（不碰 IndexedDB）
 *
 * 口径约定：
 * - 苗圃侧：批次只管「进场数量 + 供苗保证率」；
 * - 项目部侧：栽植领用与整块地的验收测次；
 * - 测次成活株数按「在库（active）」领用的株数摊回批次；挂起（pending）领用不参与摊回；
 * - 批次成活率 = 摊回成活株数 ÷ 参与摊回的领用株数；低于保证率的差额生成结算单行。
 */
import type { Planting } from '../types/planting';
import type { Seedling } from '../types/seedling';
import type { Survey } from '../types/survey';
import type { Settlement, SettlementStatus } from '../types/settlement';
import { calcSurvivalRate, round1 } from './rate';
import { nowIso, uuid } from './id';
import { ROW_REVISION } from './revision';

/** 某批次在某测次上摊回的一份 */
export interface SurveyBatchShare {
  seedlingId: string;
  /** 参与摊回的领用株数（仅在库部分） */
  issued: number;
  /** 摊回的成活株数 */
  alive: number;
  /** 批次成活率（%） */
  rate: number;
}

export interface SurveyApportion {
  surveyId: string;
  plotId: string;
  round: number;
  /** 地块栽植总株数（含挂起，用于整块地成活率口径） */
  totalCount: number;
  /** 参与摊回的在库领用合计 */
  activeTotal: number;
  /** 挂起领用合计 */
  pendingTotal: number;
  /** 按在库比例折算给在库批次的成活株数（≤ activeTotal） */
  effectiveAlive: number;
  shares: SurveyBatchShare[];
}

/**
 * 最大余数法（Hamilton）把成活株数按领用株数摊到各批次，保证各批分摊之和等于 effectiveAlive。
 * effectiveAlive ≤ 权重之和时，任一分摊不会超过该批领用株数。
 */
function hamilton(totalAlive: number, weights: number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (sum <= 0 || totalAlive <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (totalAlive * weight) / sum);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = totalAlive - floors.reduce((acc, value) => acc + value, 0);
  const order = weights
    .map((_weight, index) => index)
    .sort((a, b) => exact[b] - Math.floor(exact[b]) - (exact[a] - Math.floor(exact[a])));
  for (const index of order) {
    if (remainder <= 0) break;
    floors[index] += 1;
    remainder -= 1;
  }
  return floors;
}

/** 计算某测次的成活株数如何按在库领用摊回各苗木批次 */
export function apportionSurvey(survey: Survey, plantings: Planting[]): SurveyApportion {
  const rows = plantings
    .filter((row) => row.plotId === survey.plotId)
    .sort((a, b) => a.plantDate.localeCompare(b.plantDate) || a.id.localeCompare(b.id));
  const totalCount = rows.reduce((acc, row) => acc + row.count, 0);
  // 旧数据行可能没有 status 字段：按「在库」兜底（正常写入路径已保证该字段存在）
  const activeRows = rows.filter((row) => (row.status ?? 'active') === 'active');
  const activeTotal = activeRows.reduce((acc, row) => acc + row.count, 0);
  const pendingTotal = totalCount - activeTotal;

  // 先把测次成活株数按在库占比折算给「在库部分」，避免挂起领用把批次成活率抬过 100%
  const effectiveAlive =
    totalCount > 0 ? Math.min(activeTotal, Math.round((survey.aliveCount * activeTotal) / totalCount)) : 0;

  const batchIds: string[] = [];
  const weights: number[] = [];
  activeRows.forEach((row) => {
    const index = batchIds.indexOf(row.seedlingId);
    if (index >= 0) {
      weights[index] += row.count;
    } else {
      batchIds.push(row.seedlingId);
      weights.push(row.count);
    }
  });
  const aliveParts = hamilton(effectiveAlive, weights);

  const shares: SurveyBatchShare[] = batchIds.map((seedlingId, index) => {
    const issued = weights[index];
    const alive = aliveParts[index];
    return { seedlingId, issued, alive, rate: calcSurvivalRate(alive, issued) };
  });

  return {
    surveyId: survey.id,
    plotId: survey.plotId,
    round: survey.round,
    totalCount,
    activeTotal,
    pendingTotal,
    effectiveAlive,
    shares,
  };
}

/* ------------------------------ 批次在库状态 ------------------------------ */

export interface BatchStock {
  seedlingId: string;
  /** 进场数量 */
  quantity: number;
  /** 已承诺领用（在库部分株数合计） */
  committed: number;
  /** 挂起领用株数合计 */
  pending: number;
  /** 挂起行累计超出的株数（最后一行挂起时的累计超出量） */
  overQuantity: number;
  /** 进场数量 - 已承诺领用；< 0 理论上不会出现（超出的部分都挂起） */
  available: number;
}

/** 按栽植日期累计，算出每条领用相对批次进场数量应处于在库还是挂起 */
export function resolvePlantingStatuses(
  rowsForBatch: Planting[],
  quantity: number,
): Array<Pick<Planting, 'id' | 'status' | 'overQuantity'>> {
  const ordered = [...rowsForBatch].sort(
    (a, b) => a.plantDate.localeCompare(b.plantDate) || a.id.localeCompare(b.id),
  );
  let cumulative = 0;
  return ordered.map((row) => {
    cumulative += row.count;
    if (cumulative <= quantity) {
      return { id: row.id, status: 'active' as const, overQuantity: 0 };
    }
    return { id: row.id, status: 'pending' as const, overQuantity: cumulative - quantity };
  });
}

/* ------------------------------ 批次对账行 ------------------------------ */

export interface BatchReconcile extends BatchStock {
  plotId: string;
  species: Seedling['species'];
  source: Seedling['source'];
  guaranteeRate: Seedling['guaranteeRate'];
  /** 最新测次的摊回结果 */
  latest: (SurveyBatchShare & {
    surveyId: string;
    round: number;
    date: string;
    shortRate: number;
    shortCount: number;
    /** true 达标 / false 低于保证率 / null 不考核或尚无验收 */
    pass: boolean | null;
  }) | null;
}

/** 全量批次对账表：在库情况 + 最新测次摊回的批次成活率 */
export function buildReconcile(
  seedlings: Seedling[],
  plantings: Planting[],
  surveys: Survey[],
): Record<string, BatchReconcile> {
  const result: Record<string, BatchReconcile> = {};
  const surveysByPlot = new Map<string, Survey[]>();
  surveys.forEach((survey) => {
    const list = surveysByPlot.get(survey.plotId) ?? [];
    list.push(survey);
    surveysByPlot.set(survey.plotId, list);
  });

  seedlings.forEach((seedling) => {
    const rows = plantings.filter((row) => row.seedlingId === seedling.id);
    const statuses = resolvePlantingStatuses(rows, seedling.quantity);
    let committed = 0;
    let pending = 0;
    let overQuantity = 0;
    rows.forEach((row) => {
      const status = statuses.find((item) => item.id === row.id);
      if (status?.status === 'pending') {
        pending += row.count;
        overQuantity = Math.max(overQuantity, status.overQuantity);
      } else {
        committed += row.count;
      }
    });

    const plotSurveys = (surveysByPlot.get(seedling.plotId) ?? []).slice().sort((a, b) => a.round - b.round);
    const latestSurvey = plotSurveys.length > 0 ? plotSurveys[plotSurveys.length - 1] : null;
    const apportion = latestSurvey ? apportionSurvey(latestSurvey, plantings) : null;
    const share = apportion?.shares.find((item) => item.seedlingId === seedling.id) ?? null;

    let latest: BatchReconcile['latest'] = null;
    if (latestSurvey && share) {
      const shortRate =
        seedling.guaranteeRate !== null && share.rate < seedling.guaranteeRate
          ? round1(seedling.guaranteeRate - share.rate)
          : 0;
      latest = {
        ...share,
        surveyId: latestSurvey.id,
        round: latestSurvey.round,
        date: latestSurvey.date,
        shortRate,
        shortCount: Math.round((share.issued * shortRate) / 100),
        pass: seedling.guaranteeRate === null ? null : share.rate >= seedling.guaranteeRate,
      };
    }

    result[seedling.id] = {
      seedlingId: seedling.id,
      plotId: seedling.plotId,
      species: seedling.species,
      source: seedling.source,
      guaranteeRate: seedling.guaranteeRate,
      quantity: seedling.quantity,
      committed,
      pending,
      overQuantity,
      available: seedling.quantity - committed,
      latest,
    };
  });
  return result;
}

/* ---------------------------- 结算单（苗圃侧） ---------------------------- */

/** 一条结算单的短差口径 */
export interface SettlementShortfall {
  seedlingId: string;
  survey: Survey;
  share: SurveyBatchShare;
  guaranteeRate: number;
  shortRate: number;
  shortCount: number;
}

/** 找出某地块全部测次里，批次成活率低于保证率的短差（保证率为 null 的不考核批次跳过） */
export function collectShortfalls(
  plotId: string,
  seedlings: Seedling[],
  plantings: Planting[],
  surveys: Survey[],
): SettlementShortfall[] {
  const seedlingMap = new Map(seedlings.map((row) => [row.id, row]));
  const plotSurveys = surveys
    .filter((row) => row.plotId === plotId)
    .sort((a, b) => a.round - b.round);
  const shortfalls: SettlementShortfall[] = [];
  plotSurveys.forEach((survey) => {
    const apportion = apportionSurvey(survey, plantings);
    apportion.shares.forEach((share) => {
      const seedling = seedlingMap.get(share.seedlingId);
      if (!seedling || seedling.guaranteeRate === null) return;
      if (share.rate >= seedling.guaranteeRate) return;
      const shortRate = round1(seedling.guaranteeRate - share.rate);
      shortfalls.push({
        seedlingId: share.seedlingId,
        survey,
        share,
        guaranteeRate: seedling.guaranteeRate,
        shortRate,
        shortCount: Math.round((share.issued * shortRate) / 100),
      });
    });
  });
  return shortfalls;
}

export interface SettlementSyncChange {
  /** 需要新增 / 更新的待确认结算单 */
  put: Settlement[];
  /** 短差已消失、需要删除的待确认结算单 id */
  remove: string[];
}

/**
 * 纯函数：对比现存结算单与最新短差，给出苗圃侧本侧的写入计划。
 * 已确认 / 已驳回的单据一律不动（项目部确认结果不被覆盖，也不会重复开单）；
 * 短差已消失的待确认单据自动撤单，仍存在的待确认单据按最新数据更新。
 */
export function planSettlementSync(existing: Settlement[], shortfalls: SettlementShortfall[]): SettlementSyncChange {
  const stamp = nowIso();
  const keyOf = (row: { seedlingId: string; surveyId: string }): string => `${row.seedlingId}@${row.surveyId}`;
  const existingByKey = new Map(existing.map((row) => [keyOf(row), row]));
  const shortfallKeys = new Set(shortfalls.map((item) => keyOf({ seedlingId: item.seedlingId, surveyId: item.survey.id })));

  const put: Settlement[] = shortfalls
    // 同 [批次+测次] 已有「已确认 / 已驳回」单据：项目部已处理，留档且不再重开
    .filter((item) => {
      const found = existingByKey.get(keyOf({ seedlingId: item.seedlingId, surveyId: item.survey.id }));
      return found === undefined || found.status === '待确认';
    })
    .map((item) => {
      const old = existingByKey.get(keyOf({ seedlingId: item.seedlingId, surveyId: item.survey.id }));
      const base: Settlement = old && old.status === '待确认'
        ? old
        : {
            id: uuid('settlement'),
            seedlingId: item.seedlingId,
            plotId: item.survey.plotId,
            surveyId: item.survey.id,
            status: '待确认' as SettlementStatus,
            confirmedAt: '',
            remark: '',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
            round: 0,
            surveyDate: '',
            issuedCount: 0,
            aliveCount: 0,
            batchRate: 0,
            guaranteeRate: 0,
            shortRate: 0,
            shortCount: 0,
          };
      return {
        ...base,
        round: item.survey.round,
        surveyDate: item.survey.date,
        issuedCount: item.share.issued,
        aliveCount: item.share.alive,
        batchRate: item.share.rate,
        guaranteeRate: item.guaranteeRate,
        shortRate: item.shortRate,
        shortCount: item.shortCount,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
    });

  const remove = existing
    .filter((row) => row.status === '待确认' && !shortfallKeys.has(keyOf(row)))
    .map((row) => row.id);
  return { put, remove };
}

