/**
 * 栽植领用状态管理（Zustand）——项目部侧
 * 领用时按苗圃当时在库量分配：在库够多少落实多少，超出进场数量的先挂起。
 * 保存（项目部侧 plantings）成功后，再登记苗圃侧供苗流水账；
 * 苗圃那份失败只重试苗圃侧，领用不回滚。
 */
import { create } from 'zustand';
import type { Planting, PlantingDraft } from '../types/planting';
import { db, ROW_REVISION, putPlanting, removePlanting } from '../utils/db';
import { afterRequisitionRemoved, afterRequisitionSaved } from '../utils/sides';
import { allocateRequisition, batchInStock } from '../utils/batch';
import { nowIso, uuid } from '../utils/id';
import { usePlotStore } from './plotStore';

export interface RequisitionResult {
  row: Planting;
  /** 本次挂起株数（>0 表示超出苗圃当时在库） */
  held: number;
  /** 苗圃侧流水账是否已挂重试 */
  nurseryPending: boolean;
  nurseryMessage: string;
}

interface RequisitionStoreState {
  revision: number;
  bump: () => void;
  /**
   * 新建领用：按选择的批次与苗圃当前在库量分配落实 / 挂起。
   */
  createRequisition: (draft: PlantingDraft) => Promise<RequisitionResult>;
  updateRequisition: (id: string, draft: PlantingDraft) => Promise<RequisitionResult>;
  deleteRequisition: (id: string) => Promise<{ nurseryPending: boolean; nurseryMessage: string }>;
  /** 查询某批次当前在库（供表单选择展示） */
  inStockOf: (seedlingId: string) => number;
  /**
   * 苗圃补苗后，把本地块挂起的领用按当前在库重新落实（按栽植日期先后排队）。
   * 返回新落实的株数；随后同步苗圃侧流水账（失败只重试苗圃侧）。
   */
  fulfillHeld: (plotId: string) => Promise<{ fulfilledDelta: number; nurseryPending: boolean; nurseryMessage: string }>;
}

/** 按批次 + 全部现有领用计算在库（编辑时排除自身） */
function computeInStock(seedlingId: string, excludePlantingId?: string): number {
  const { seedlings, plantings } = usePlotStore.getState();
  const seedling = seedlings.find((row) => row.id === seedlingId);
  if (!seedling) return 0;
  const others = plantings.filter((row) => row.id !== excludePlantingId);
  return batchInStock(seedling, others);
}

export const useRequisitionStore = create<RequisitionStoreState>((set, get) => ({
  revision: 0,

  bump() {
    set({ revision: get().revision + 1 });
  },

  inStockOf(seedlingId) {
    return computeInStock(seedlingId);
  },

  async fulfillHeld(plotId) {
    const seedlings = await db.seedlings.toArray();
    const heldRows = (await db.plantings.where('plotId').equals(plotId).toArray())
      .filter((row) => row.fulfilledCount < row.count)
      .sort((a, b) => a.plantDate.localeCompare(b.plantDate));
    let delta = 0;
    for (const row of heldRows) {
      const seedling = seedlings.find((item) => item.id === row.seedlingId);
      if (!seedling) continue;
      // 每轮直接读库重算在库，前面排队的领用落实后会立刻占掉相应在库
      const latest = await db.plantings.toArray();
      const inStock = batchInStock(seedling, latest);
      const want = row.count - row.fulfilledCount;
      const give = Math.min(want, inStock);
      if (give <= 0) continue;
      await putPlanting({ ...row, fulfilledCount: row.fulfilledCount + give });
      delta += give;
    }
    // 苗圃侧流水账按最终领用状态重算（幂等）；失败只重试苗圃侧
    const nursery = delta > 0 ? await afterRequisitionSaved({} as Planting) : { nurseryPending: false, message: '' };
    get().bump();
    return { fulfilledDelta: delta, nurseryPending: nursery.nurseryPending, nurseryMessage: nursery.message };
  },

  async createRequisition(draft) {
    const inStock = computeInStock(draft.seedlingId);
    const fulfilledCount = allocateRequisition(draft.count, inStock);
    const stamp = nowIso();
    const row: Planting = {
      id: uuid('planting'),
      plotId: draft.plotId,
      seedlingId: draft.seedlingId,
      plantDate: draft.plantDate,
      spacingM: draft.spacingM,
      count: draft.count,
      fulfilledCount,
      status: fulfilledCount <= 0 ? '挂起' : fulfilledCount < draft.count ? '部分挂起' : '已落实',
      operator: draft.operator,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    // 项目部侧先提交自己那份
    await putPlanting(row);
    // 苗圃侧各记各的：失败只挂苗圃侧重试
    const nursery = await afterRequisitionSaved(row);
    get().bump();
    return { row, held: draft.count - fulfilledCount, nurseryPending: nursery.nurseryPending, nurseryMessage: nursery.message };
  },

  async updateRequisition(id, draft) {
    const existing = await db.plantings.get(id);
    if (!existing) throw new Error('领用记录不存在或已被删除');
    // 重新按当前在库量分配（排除自身，避免把自己当成占用）
    const inStock = computeInStock(draft.seedlingId, id);
    const fulfilledCount = allocateRequisition(draft.count, inStock);
    const row: Planting = {
      ...existing,
      plotId: draft.plotId,
      seedlingId: draft.seedlingId,
      plantDate: draft.plantDate,
      spacingM: draft.spacingM,
      count: draft.count,
      fulfilledCount,
      status: fulfilledCount <= 0 ? '挂起' : fulfilledCount < draft.count ? '部分挂起' : '已落实',
    };
    await putPlanting(row);
    const nursery = await afterRequisitionSaved(row);
    get().bump();
    return { row, held: draft.count - fulfilledCount, nurseryPending: nursery.nurseryPending, nurseryMessage: nursery.message };
  },

  async deleteRequisition(id) {
    await removePlanting(id);
    const nursery = await afterRequisitionRemoved();
    get().bump();
    return { nurseryPending: nursery.nurseryPending, nurseryMessage: nursery.message };
  },
}));
