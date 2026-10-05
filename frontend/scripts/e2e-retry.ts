/* eslint-disable @typescript-eslint/no-explicit-any */
import 'fake-indexeddb/auto';
import {
  db,
  enqueueOutbox,
  listOutbox,
  listNurseryOutflows,
  processOutbox,
  syncNurseryOutflows,
  putPlanting,
} from '../src/utils/db';
import { setNurseryWriteFailing, afterRequisitionSaved } from '../src/utils/sides';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('PASS:', msg);
}

async function main(): Promise<void> {
  // 准备：地块 + 一个苗圃批次 + 一条项目部领用
  await db.plots.put({
    id: 'p1', name: '地块', areaMu: 10, tideZone: '中', substrate: '淤泥质', restoreMode: '造林',
    state: '跟踪中', missingCount: 0, lastReplantDate: '', createdAt: 't', updatedAt: 't', revision: 3,
  });
  await db.seedlings.put({
    id: 's1', species: '秋茄', source: '外购', spec: '裸根', quantity: 1000, arrivalDate: '2024-01-01',
    guaranteeRate: 80, createdAt: 't', updatedAt: 't', revision: 3,
  });

  // 内存 localStorage + window（sides.ts 运行时才读取）
  const mem = new Map<string, string>();
  (globalThis as any).window = {
    localStorage: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
    },
  };

  // 1) 正常：领用提交 + 苗圃流水账即时落账
  await putPlanting({
    id: 'pl1', plotId: 'p1', seedlingId: 's1', plantDate: '2024-02-01', spacingM: 1,
    count: 800, fulfilledCount: 800, status: '已落实', operator: '班1', createdAt: 't', updatedAt: 't', revision: 3,
  });
  const ok = await afterRequisitionSaved({ id: 'pl1' } as any);
  assert(ok.nurseryPending === false, '正常路径：苗圃侧即时落账');
  assert((await listNurseryOutflows()).length === 1, '流水账 1 条');

  // 2) 打开「苗圃保存失败」：新领用（项目部侧照常提交），苗圃那份失败 → 只入苗圃侧重试队列
  setNurseryWriteFailing(true);
  await putPlanting({
    id: 'pl2', plotId: 'p1', seedlingId: 's1', plantDate: '2024-03-01', spacingM: 1,
    count: 100, fulfilledCount: 100, status: '已落实', operator: '班2', createdAt: 't', updatedAt: 't', revision: 3,
  });
  const failed = await afterRequisitionSaved({ id: 'pl2' } as any);
  assert(failed.nurseryPending === true, '故障开启：苗圃侧保存失败、挂重试');
  const plantingsCount = await db.plantings.count();
  assert(plantingsCount === 2, '项目部侧照旧：两条领用都在，不回滚');
  assert((await listNurseryOutflows()).length === 1, '苗圃侧仍只有旧流水，新领用没记上');
  let tasks = await listOutbox();
  let nurseryTask = tasks.find((t) => t.kind === 'outflow-sync');
  assert(!!nurseryTask && nurseryTask.side === 'nursery', '重试任务归属苗圃侧');
  assert(nurseryTask!.status === 'pending', '任务状态 pending');

  // 3) 故障期间重放：仍失败，项目部数据不受影响
  let res = await processOutbox((t) => t.injected);
  assert(res.failed >= 1 && res.done === 0, '故障中重放：只失败不成功');
  tasks = await listOutbox();
  nurseryTask = tasks.find((t) => t.kind === 'outflow-sync');
  assert(nurseryTask!.status === 'failed' && nurseryTask!.attempts === 1, '任务变 failed、尝试次数+1');
  assert(await db.plantings.count() === 2, '失败重放不影响项目部侧领用');

  // 4) 关闭故障后重放：只补苗圃侧，项目部侧不被改写
  // 直接置开关（不调 setNurseryWriteFailing，避免它内部自动重放造成竞态）
  mem.set('gbmangrove:simulateNurseryFailure', '0');
  res = await processOutbox();
  assert(res.done >= 1 && res.failed === 0, '故障解除：苗圃侧重提成功');
  const outflows = await listNurseryOutflows();
  assert(outflows.length === 2, '苗圃侧补齐 2 条流水');
  assert(outflows.some((o) => o.plantingId === 'pl2' && o.count === 100), '新领用流水补登为 100');
  assert(await db.plantings.count() === 2, '项目部侧领用仍是 2 条，没被重试触碰');
  tasks = await listOutbox();
  assert(tasks.every((t) => t.status === 'done'), '重试队列已清空（done）');

  // 5) 幂等：直接再跑一次同步不会产生重复流水
  await syncNurseryOutflows();
  assert((await listNurseryOutflows()).length === 2, '苗圃流水幂等，仍为 2 条');

  // 6) 手动 enqueue 去重：同 dedupeKey 不堆积
  await enqueueOutbox({ side: 'nursery', kind: 'outflow-sync', refId: 'all' });
  await enqueueOutbox({ side: 'nursery', kind: 'outflow-sync', refId: 'all' });
  const allTasks = await listOutbox();
  assert(allTasks.filter((t) => t.dedupeKey === 'outflow-sync:all' && t.status !== 'done').length <= 1, '同 key 重试任务只保留一条');

  console.log('\n故障注入 / 本侧重试语义全部通过 ✅');
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
