/**
 * 演示数据播种（幂等）
 * 两摊分家后的链路：
 *   苗圃侧：苗木批次（进场数量 + 供苗保证率）→ 供苗流水账 → 批次结算单
 *   项目部侧：地块 → 栽植领用（在库落实 / 超出挂起）→ 验收测次 → 补植
 * 所有 id 固定，保证深链一定命中真实数据。
 */
import { db, ROW_REVISION } from './db';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant } from '../types/replant';
import type { NurseryOutflow } from '../types/ledger';
import type { Settlement } from '../types/settlement';
import { calcSurvivalRate, rateLevel } from './rate';
import { plantingStatusOf } from '../types/planting';

const SEED_TIME = '2025-01-06T02:00:00.000Z';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  plotA: 'plot-donggang-3',
  plotB: 'plot-xiwan-a',
  plotC: 'plot-beiyu-b',
} as const;

function plotRow(row: Omit<Plot, 'createdAt' | 'updatedAt' | 'revision'>): Plot {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function seedlingRow(row: Omit<Seedling, 'createdAt' | 'updatedAt' | 'revision'>): Seedling {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function plantingRow(row: Omit<Planting, 'createdAt' | 'updatedAt' | 'revision' | 'status'>): Planting {
  return {
    ...row,
    status: plantingStatusOf(row.count, row.fulfilledCount),
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    revision: ROW_REVISION,
  };
}

function surveyRow(
  row: Omit<Survey, 'createdAt' | 'updatedAt' | 'revision' | 'grade' | 'gradeManual' | 'survivalRate'>,
  total: number,
): Survey {
  const survivalRate = calcSurvivalRate(row.aliveCount, total);
  return {
    ...row,
    survivalRate,
    grade: rateLevel(survivalRate),
    gradeManual: false,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    revision: ROW_REVISION,
  };
}

function replantRow(row: Omit<Replant, 'createdAt' | 'updatedAt' | 'revision'>): Replant {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

/**
 * 播种演示数据。调用方（initDatabase）已保证仅在主表为空时调用，因此天然幂等；
 * 这里再做一次防御：若已存在地块则直接返回。
 */
export async function seedDatabase(): Promise<void> {
  const exists = await db.plots.count();
  if (exists > 0) return;

  // ---------------- 地块（3 块，项目部侧） ----------------
  const plots: Plot[] = [
    plotRow({
      id: SEED_IDS.plotA,
      name: '东港南堤 3 号地块',
      areaMu: 46.5,
      tideZone: '中',
      substrate: '淤泥质',
      restoreMode: '造林',
      state: '跟踪中',
      missingCount: 1092,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.plotB,
      name: '西湾滩涂 A 区',
      areaMu: 32,
      tideZone: '低',
      substrate: '砂泥质',
      restoreMode: '补植',
      state: '跟踪中',
      missingCount: 374,
      lastReplantDate: '2025-04-20',
    }),
    plotRow({
      id: SEED_IDS.plotC,
      name: '北屿外滩 B 区',
      areaMu: 58.2,
      tideZone: '高',
      substrate: '砂质',
      restoreMode: '造林',
      state: '已验收',
      missingCount: 560,
      lastReplantDate: '2024-11-08',
    }),
  ];

  // ---------------- 苗木批次（苗圃侧：进场数量 + 供苗保证率） ----------------
  const seedlings: Seedling[] = [
    // 自育苗不考核（guaranteeRate = null）
    seedlingRow({ id: 'seedling-a1', species: '秋茄', source: '自育苗', spec: '50cm 裸根苗', quantity: 3200, arrivalDate: '2024-04-05', guaranteeRate: null }),
    // 外购按合同约定 90% 保证率
    seedlingRow({ id: 'seedling-a2', species: '桐花树', source: '外购', spec: '40cm 营养袋苗', quantity: 2400, arrivalDate: '2024-04-10', guaranteeRate: 90 }),
    seedlingRow({ id: 'seedling-b1', species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 1900, arrivalDate: '2024-04-28', guaranteeRate: null }),
    seedlingRow({ id: 'seedling-b2', species: '秋茄', source: '外购', spec: '50cm 营养袋苗', quantity: 1600, arrivalDate: '2024-05-02', guaranteeRate: 85 }),
    seedlingRow({ id: 'seedling-c1', species: '无瓣海桑', source: '外购', spec: '60cm 营养袋苗', quantity: 4400, arrivalDate: '2024-03-12', guaranteeRate: 95 }),
    seedlingRow({ id: 'seedling-c2', species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 3900, arrivalDate: '2024-03-16', guaranteeRate: null }),
  ];

  // ---------------- 栽植领用（项目部侧：按苗圃当时在库落实，超出挂起） ----------------
  const plantings: Planting[] = [
    plantingRow({ id: 'planting-a1', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a1', plantDate: '2024-04-12', spacingM: 1, count: 3000, fulfilledCount: 3000, operator: '东港一班' }),
    plantingRow({ id: 'planting-a2', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a2', plantDate: '2024-04-15', spacingM: 0.8, count: 2200, fulfilledCount: 2200, operator: '东港二班' }),
    plantingRow({ id: 'planting-b1', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b1', plantDate: '2024-05-06', spacingM: 1.2, count: 1800, fulfilledCount: 1800, operator: '西湾一班' }),
    // 在库 1600 株：领用 1700，落实 1600、挂起 100
    plantingRow({ id: 'planting-b2', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b2', plantDate: '2024-05-09', spacingM: 1, count: 1700, fulfilledCount: 1600, operator: '西湾二班' }),
    plantingRow({ id: 'planting-c1', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c1', plantDate: '2024-03-20', spacingM: 1.5, count: 4200, fulfilledCount: 4200, operator: '北屿一班' }),
    plantingRow({ id: 'planting-c2', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c2', plantDate: '2024-03-24', spacingM: 1.2, count: 3800, fulfilledCount: 3800, operator: '北屿二班' }),
  ];

  // 各地块已落实栽植总株数（挂起不计），用于派生成活率
  const totalByPlot: Record<string, number> = {
    [SEED_IDS.plotA]: 5200,
    [SEED_IDS.plotB]: 3400,
    [SEED_IDS.plotC]: 8000,
  };

  // ---------------- 验收测次（项目部侧，每地块 2–3 个测次） ----------------
  const surveys: Survey[] = [
    surveyRow({ id: 'survey-a1', plotId: SEED_IDS.plotA, round: 1, date: '2024-06-20', aliveCount: 4680, avgHeightCm: 62 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a2', plotId: SEED_IDS.plotA, round: 2, date: '2024-09-18', aliveCount: 4420, avgHeightCm: 78 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a3', plotId: SEED_IDS.plotA, round: 3, date: '2025-03-15', aliveCount: 4108, avgHeightCm: 96 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-b1', plotId: SEED_IDS.plotB, round: 1, date: '2024-07-05', aliveCount: 2992, avgHeightCm: 41 }, totalByPlot[SEED_IDS.plotB]),
    surveyRow({ id: 'survey-b2', plotId: SEED_IDS.plotB, round: 2, date: '2024-10-12', aliveCount: 3026, avgHeightCm: 55 }, totalByPlot[SEED_IDS.plotB]),
    surveyRow({ id: 'survey-c1', plotId: SEED_IDS.plotC, round: 1, date: '2024-05-28', aliveCount: 7680, avgHeightCm: 70 }, totalByPlot[SEED_IDS.plotC]),
    surveyRow({ id: 'survey-c2', plotId: SEED_IDS.plotC, round: 2, date: '2024-08-30', aliveCount: 7440, avgHeightCm: 88 }, totalByPlot[SEED_IDS.plotC]),
  ];

  // ---------------- 苗圃供苗流水账（苗圃侧，各记各的） ----------------
  const outflows: NurseryOutflow[] = plantings
    .filter((row) => row.fulfilledCount > 0)
    .map((row) => ({
      id: `outflow-${row.id}`,
      seedlingId: row.seedlingId,
      plotId: row.plotId,
      plantingId: row.id,
      action: '领用出库',
      count: row.fulfilledCount,
      date: row.plantDate,
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
      revision: ROW_REVISION,
    }));

  // ---------------- 批次结算单（苗圃侧；按最新测次摊回，低于保证率记差额） ----------------
  // 东港 plotA 第 3 测次：外购桐花树（保证率 90%），摊回成活 1738 < 保证 1980，差额 242
  // 北屿 plotC 第 2 测次：外购无瓣海桑（保证率 95%），摊回成活 3906 < 保证 3990，差额 84
  const settlements: Settlement[] = [
    {
      id: `settle-${SEED_IDS.plotA}-seedling-a2`,
      seedlingId: 'seedling-a2',
      plotId: SEED_IDS.plotA,
      surveyId: 'survey-a3',
      round: 3,
      allocatedPlanted: 2200,
      allocatedAlive: 1738,
      batchRate: 79,
      guaranteeRate: 90,
      guaranteedAlive: 1980,
      shortfallCount: 242,
      status: '待确认',
      confirmedAt: '',
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
      revision: ROW_REVISION,
    },
    {
      id: `settle-${SEED_IDS.plotC}-seedling-c1`,
      seedlingId: 'seedling-c1',
      plotId: SEED_IDS.plotC,
      surveyId: 'survey-c2',
      round: 2,
      allocatedPlanted: 4200,
      allocatedAlive: 3906,
      batchRate: 93,
      guaranteeRate: 95,
      guaranteedAlive: 3990,
      shortfallCount: 84,
      status: '已确认',
      confirmedAt: '2024-09-10T03:00:00.000Z',
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
      revision: ROW_REVISION,
    },
  ];

  // ---------------- 补植计划（项目部侧，覆盖三种状态） ----------------
  const replants: Replant[] = [
    replantRow({ id: 'replant-a1', plotId: SEED_IDS.plotA, missingCount: 1092, planDate: '2025-04-10', species: '秋茄', state: '待补植' }),
    replantRow({ id: 'replant-b1', plotId: SEED_IDS.plotB, missingCount: 374, planDate: '2025-04-18', species: '秋茄', state: '已补植' }),
    replantRow({ id: 'replant-c1', plotId: SEED_IDS.plotC, missingCount: 560, planDate: '2024-11-05', species: '无瓣海桑', state: '已复核' }),
  ];

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
    ],
    async () => {
      await db.plots.bulkPut(plots);
      await db.seedlings.bulkPut(seedlings);
      await db.plantings.bulkPut(plantings);
      await db.surveys.bulkPut(surveys);
      await db.nurseryOutflows.bulkPut(outflows);
      await db.settlements.bulkPut(settlements);
      await db.replants.bulkPut(replants);
    },
  );
}
