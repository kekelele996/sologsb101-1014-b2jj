/**
 * 批次维度业务口径（苗圃 ↔ 项目部之间的那套账）
 * - 苗圃在库：进场数量 - 已落实领用（挂起部分不占在库）
 * - 领用分配：挑苗圃当时在库的批次，超出在库的部分先挂起
 * - 成活摊回：测次成活株数按「已落实领用」比例摊到批次（最大余数法，保证合计守恒）
 * - 批次成活率 / 保证率差额
 * 全部为纯函数，便于两侧（页面、store、升级迁移）共用同一口径。
 */
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Settlement } from '../types/settlement';
import { calcSurvivalRate, round1 } from './rate';

/** 某批次的已落实领用合计（株）——挂起部分不计 */
export function fulfilledByBatch(seedlingId: string, plantings: Planting[]): number {
  return plantings
    .filter((row) => row.seedlingId === seedlingId)
    .reduce((acc, row) => acc + row.fulfilledCount, 0);
}

/** 某批次在库（株）= 进场数量 - 已落实领用 */
export function batchInStock(seedling: Seedling, plantings: Planting[]): number {
  return Math.max(0, seedling.quantity - fulfilledByBatch(seedling.id, plantings));
}

/**
 * 领用分配：从在库量里落实，超出部分挂起。
 * @param wanted 本次领用株数
 * @param inStock 领用前该批次在库
 * @returns 已落实株数（0 … wanted）
 */
export function allocateRequisition(wanted: number, inStock: number): number {
  if (!Number.isFinite(wanted) || wanted <= 0) return 0;
  return Math.max(0, Math.min(wanted, Math.max(0, Math.round(inStock))));
}

/**
 * 最大余数法把一个整数总量按权重分摊为整数，保证各份合计等于总量。
 * @param total 待分摊总量（如测次成活株数）
 * @param weights 各项权重（如各批次已落实领用量）
 * @returns 各项分摊到的整数，顺序与 weights 一致
 */
export function apportionInteger(total: number, weights: number[]): number[] {
  const safeWeights = weights.map((weight) => Math.max(0, weight));
  const weightSum = safeWeights.reduce((acc, item) => acc + item, 0);
  if (safeWeights.length === 0 || weightSum <= 0) return safeWeights.map(() => 0);
  const bounded = Math.max(0, Math.min(Math.round(total), Math.round(weightSum)));

  const exact = safeWeights.map((weight) => (bounded * weight) / weightSum);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = bounded - floors.reduce((acc, item) => acc + item, 0);
  // 余数按小数部分从大到小补给；并列时按原顺序，保证结果稳定
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const item of order) {
    if (remainder <= 0) break;
    floors[item.index] += 1;
    remainder -= 1;
  }
  return floors;
}

/** 批次成活摊回结果 */
export interface BatchAliveShare {
  seedlingId: string;
  /** 已落实领用量（权重/分母） */
  planted: number;
  /** 摊回的成活株数（整数） */
  alive: number;
  /** 批次成活率（%） */
  rate: number;
}

/**
 * 把某地块某次验收的成活株数，按各批次已落实领用比例摊回批次。
 * @param survey 测次（取 aliveCount）
 * @param plotPlantings 该地块的领用记录
 */
export function apportionAliveToBatches(survey: Survey, plotPlantings: Planting[]): BatchAliveShare[] {
  const byBatch = new Map<string, number>();
  plotPlantings
    .filter((row) => row.plotId === survey.plotId && row.fulfilledCount > 0)
    .forEach((row) => {
      byBatch.set(row.seedlingId, (byBatch.get(row.seedlingId) ?? 0) + row.fulfilledCount);
    });
  const entries = Array.from(byBatch.entries());
  const planted = entries.map(([, count]) => count);
  const aliveParts = apportionInteger(survey.aliveCount, planted);
  return entries.map(([seedlingId, plantedCount], index) => ({
    seedlingId,
    planted: plantedCount,
    alive: aliveParts[index],
    rate: calcSurvivalRate(aliveParts[index], plantedCount),
  }));
}

/**
 * 由一次测次生成该地块的结算行（仅含有保证率、且成活低于保证的批次）。
 * @param previous 已有的结算行（同 id 用于保留项目部确认状态）
 */
export function buildSettlementRows(
  survey: Survey,
  shares: BatchAliveShare[],
  seedlingById: Map<string, Seedling>,
  previous: Map<string, Settlement>,
): Settlement[] {
  const now = new Date().toISOString();
  const rows: Settlement[] = [];
  for (const share of shares) {
    const seedling = seedlingById.get(share.seedlingId);
    if (!seedling || seedling.guaranteeRate === null) continue; // 自育苗不考核
    const guaranteedAlive = Math.round((share.planted * seedling.guaranteeRate) / 100);
    const shortfallCount = Math.max(0, guaranteedAlive - share.alive);
    const id = `settle-${survey.plotId}-${share.seedlingId}`;
    const old = previous.get(id);
    const rate = round1(share.rate);
    if (shortfallCount <= 0) continue; // 达到保证率不进结算单
    rows.push({
      id,
      seedlingId: share.seedlingId,
      plotId: survey.plotId,
      surveyId: survey.id,
      round: survey.round,
      allocatedPlanted: share.planted,
      allocatedAlive: share.alive,
      batchRate: rate,
      guaranteeRate: seedling.guaranteeRate,
      guaranteedAlive,
      shortfallCount,
      // 差额行重建时，若株数未变则保留项目部已确认状态
      status:
        old && old.status === '已确认' && old.shortfallCount === shortfallCount && old.surveyId === survey.id
          ? '已确认'
          : '待确认',
      confirmedAt:
        old && old.status === '已确认' && old.shortfallCount === shortfallCount && old.surveyId === survey.id
          ? old.confirmedAt
          : '',
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
      revision: 3,
    });
  }
  return rows;
}
