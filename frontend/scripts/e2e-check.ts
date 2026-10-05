/* eslint-disable @typescript-eslint/no-explicit-any */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {
  db,
  DB_NAME,
  listSeedlings,
  listPlantings,
  listSettlements,
  listNurseryOutflows,
  initDatabase,
  processOutbox,
  listOutbox,
} from '../src/utils/db';
import { putPlanting } from '../src/utils/db';
import { afterRequisitionSaved } from '../src/utils/sides';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('PASS:', msg);
}

async function buildV2(): Promise<void> {
  // 手工建一个 v2 旧库（旧结构：seedlings 带 plotId、无 guaranteeRate；plantings 无 fulfilledCount/status）
  const old = new Dexie(DB_NAME);
  old.version(2).stores({
    plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
    seedlings: 'id, plotId, species, source, arrivalDate, quantity',
    plantings: 'id, plotId, seedlingId, plantDate, spacingM',
    surveys: 'id, plotId, [plotId+round], date, grade',
    replants: 'id, plotId, planDate, state, species',
  });
  await old.table('plots').bulkPut([
    {
      id: 'p1', name: '旧地块', areaMu: 10, tideZone: '中', substrate: '淤泥质', restoreMode: '造林', state: '跟踪中',
      missingCount: 0, lastReplantDate: '', createdAt: 't', updatedAt: 't', revision: 2,
    },
  ]);
  await old.table('seedlings').bulkPut([
    { id: 's-self', plotId: 'p1', species: '秋茄', source: '自育苗', spec: '裸根', quantity: 1000, arrivalDate: '2024-01-01', createdAt: 't', updatedAt: 't', revision: 2 },
    { id: 's-buy', plotId: 'p1', species: '桐花树', source: '外购', spec: '袋苗', quantity: 2000, arrivalDate: '2024-01-02', createdAt: 't', updatedAt: 't', revision: 2 },
  ]);
  await old.table('plantings').bulkPut([
    { id: 'pl1', plotId: 'p1', seedlingId: 's-self', plantDate: '2024-02-01', spacingM: 1, count: 900, operator: '班1', createdAt: 't', updatedAt: 't', revision: 2 },
    { id: 'pl2', plotId: 'p1', seedlingId: 's-buy', plantDate: '2024-02-02', spacingM: 1, count: 1800, operator: '班2', createdAt: 't', updatedAt: 't', revision: 2 },
  ]);
  // 外购保证率 80%：2700 落实（900+1800），成活 2000 → 摊回自育667、外购1333；外购保证活1440，差107
  await old.table('surveys').bulkPut([
    {
      id: 'sv1', plotId: 'p1', round: 1, date: '2024-05-01', aliveCount: 2000, avgHeightCm: 50,
      survivalRate: 74.1, grade: 'good', gradeManual: false, createdAt: 't', updatedAt: 't', revision: 2,
    },
  ]);
  await old.close();
}

async function main(): Promise<void> {
  await buildV2();
  // db 单例是 v3 声明；open 触发 v2→v3 迁移。但 initDatabase 在空 plots 时会播种——这里 plots 非空，不会播种
  await initDatabase();

  const seedlings = await listSeedlings();
  const self = seedlings.find((s) => s.id === 's-self');
  const buy = seedlings.find((s) => s.id === 's-buy');
  assert(self?.guaranteeRate === null, '旧数据：自育苗升级后不考核 guaranteeRate=null');
  assert(buy?.guaranteeRate === 80, '旧数据：外购升级后按八成补 guaranteeRate=80');
  assert((self as any).plotId === undefined, '批次不再挂地块（plotId 已清理）');
  assert(seedlings.every((s) => s.revision === 3), '批次 revision 升到 3');

  const plantings = await db.plantings.toArray();
  assert(
    plantings.every((p) => p.fulfilledCount === p.count && p.status === '已落实'),
    '历史栽植全部视为已落实（fulfilledCount=count, status=已落实）',
  );

  const outflows = await listNurseryOutflows();
  assert(outflows.length === 2, '迁移补建苗圃供苗流水账 2 条');
  assert(
    outflows.filter((o) => o.plantingId === 'pl1')[0].count === 900,
    '流水账出库数 = 历史栽植落实数',
  );

  const settlements = await listSettlements();
  // 权重 900:1800，活 2000 → 自育 667（不考核），外购 1333；保证 1440，差 107
  const buySettle = settlements.find((s) => s.seedlingId === 's-buy');
  assert(!!buySettle, '迁移为外购批次生成结算行');
  assert(buySettle?.allocatedAlive === 1333, `外购摊回成活 1333（实际 ${buySettle?.allocatedAlive}）`);
  assert(buySettle?.guaranteedAlive === 1440, '保证成活 1800×80%=1440');
  assert(buySettle?.shortfallCount === 107, `差额 107（实际 ${buySettle?.shortfallCount}）`);
  assert(buySettle?.status === '待确认', '迁移生成的差额待项目部确认');
  assert(!settlements.some((s) => s.seedlingId === 's-self'), '自育苗不结算');

  // ---- 两摊写入：正常情况苗圃流水账即时同步（幂等）----
  await afterRequisitionSaved({} as any);
  assert((await listNurseryOutflows()).length === 2, '幂等同步不产生重复流水');
  const tasksBefore = await listOutbox();
  assert(tasksBefore.filter((t) => t.status !== 'done').length === 0, '正常路径无待重试任务');

  // ---- outbox 处理器幂等重放 ----
  const r = await processOutbox(() => false);
  assert(r.done === 0, '无待处理任务时重放 done=0');

  // ---- 新领用分配（在库语义）----
  // 自育进场1000、已落实900 → 在库100；再领300 → 落实100挂起200
  const { allocateRequisition, batchInStock } = await import('../src/utils/batch');
  const stockSelf = batchInStock(self!, plantings);
  assert(stockSelf === 100, `自育在库 100（实际 ${stockSelf}）`);
  const fulfilled = allocateRequisition(300, stockSelf);
  assert(fulfilled === 100, '超出在库：领300落实100');
  const held = 300 - fulfilled;
  assert(held === 200, '超出在库：挂起200');

  await putPlanting({
    id: 'pl3', plotId: 'p1', seedlingId: 's-self', plantDate: '2024-06-01', spacingM: 1,
    count: 300, fulfilledCount: 100, status: '部分挂起', operator: '班3', createdAt: 't', updatedAt: 't', revision: 3,
  });
  await afterRequisitionSaved({ id: 'pl3' } as any);
  const outflows2 = await listNurseryOutflows();
  const of3 = outflows2.find((o) => o.plantingId === 'pl3');
  assert(!!of3 && of3.count === 100, '新领用苗圃流水账只记落实 100（挂起不记账）');
  // 幂等：再来一次仍是同样条数
  await afterRequisitionSaved({ id: 'pl3' } as any);
  assert((await listNurseryOutflows()).length === 3, '重复同步保持 3 条流水');

  // ---- 苗圃补苗后按在库落实挂起（按栽植日期排队）----
  const { useRequisitionStore } = await import('../src/stores/requisitionStore');
  // 补苗前在库为 0：落实 0 株
  let r2 = await useRequisitionStore.getState().fulfillHeld('p1');
  assert(r2.fulfilledDelta === 0, '苗圃未补苗：挂起领用无法落实');
  // 苗圃给该批次追加 500 株进场
  await db.seedlings.update('s-self', { quantity: 1500 });
  r2 = await useRequisitionStore.getState().fulfillHeld('p1');
  assert(r2.fulfilledDelta === 200, `补苗后落实挂起 200 株（实际 ${r2.fulfilledDelta}）`);
  const pl3 = await db.plantings.get('pl3');
  assert(pl3!.fulfilledCount === 300 && pl3!.status === '已落实', '挂起领用转为全部落实 300');
  // s-self 进场 1000、追加 500 = 1500；落实 pl1 900 + pl3 300 = 1200 → 在库 300
  assert(batchInStock((await listSeedlings()).find((s) => s.id === 's-self')!, await db.plantings.toArray()) === 300, '补苗落实后在库 300');
  const of3b = (await listNurseryOutflows()).find((o) => o.plantingId === 'pl3');
  assert(of3b!.count === 300, '苗圃流水账随落实更新为 300');

  console.log('\n全部端到端断言通过 ✅');
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
