/**
 * 苗圃台账状态管理（Zustand）——苗圃侧
 * 管苗木批次的进场数量与供苗保证率、批次结算单确认、本侧重试队列与故障注入开关。
 * 苗圃侧批次是全局在库资源，与项目部地块通过领用记录关联（批次表本身不挂地块）。
 */
import { create } from 'zustand';
import type { Seedling, SeedlingDraft } from '../types/seedling';
import type { OutboxTask } from '../types/ledger';
import {
  db,
  ROW_REVISION,
  putSeedling,
  removeSeedling,
  setSettlementStatus,
  listOutbox,
  clearOutboxInjection,
  removeOutboxTask,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import {
  nurseryWriteFailing,
  retryPendingSideWrites,
  setNurseryWriteFailing,
} from '../utils/sides';

interface NurseryStoreState {
  revision: number;
  /** 故障注入开关（苗圃保存失败模拟） */
  failing: boolean;
  bump: () => void;
  refreshFailing: () => void;
  toggleFailing: (on: boolean) => void;
  createSeedling: (draft: SeedlingDraft) => Promise<Seedling>;
  updateSeedling: (id: string, draft: SeedlingDraft) => Promise<void>;
  deleteSeedling: (id: string) => Promise<void>;
  confirmSettlement: (id: string, confirmed: boolean) => Promise<void>;
  retryOutbox: () => Promise<{ done: number; failed: number }>;
  /** 关掉某条任务的故障注入后再重放（演示重试只打苗圃侧） */
  dismissInjectionAndRetry: (id: string) => Promise<{ done: number; failed: number }>;
  discardTask: (id: string) => Promise<void>;
  pendingTasks: () => Promise<OutboxTask[]>;
}

export const useNurseryStore = create<NurseryStoreState>((set, get) => ({
  revision: 0,
  failing: nurseryWriteFailing(),

  bump() {
    set({ revision: get().revision + 1 });
  },

  refreshFailing() {
    set({ failing: nurseryWriteFailing() });
  },

  toggleFailing(on) {
    setNurseryWriteFailing(on);
    set({ failing: on });
  },

  async createSeedling(draft) {
    const stamp = nowIso();
    const row: Seedling = {
      id: uuid('seedling'),
      species: draft.species,
      source: draft.source,
      spec: draft.spec,
      quantity: draft.quantity,
      arrivalDate: draft.arrivalDate,
      guaranteeRate: draft.guaranteeRate,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    // 批次是苗圃自己的账，单写苗圃侧
    await putSeedling(row);
    get().bump();
    return row;
  },

  async updateSeedling(id, draft) {
    const existing = await db.seedlings.get(id);
    if (!existing) return;
    await putSeedling({
      ...existing,
      species: draft.species,
      source: draft.source,
      spec: draft.spec,
      quantity: draft.quantity,
      arrivalDate: draft.arrivalDate,
      guaranteeRate: draft.guaranteeRate,
    });
    get().bump();
  },

  async deleteSeedling(id) {
    await removeSeedling(id);
    get().bump();
  },

  async confirmSettlement(id, confirmed) {
    await setSettlementStatus(id, confirmed ? '已确认' : '待确认');
    get().bump();
  },

  async retryOutbox() {
    const result = await retryPendingSideWrites();
    get().bump();
    return result;
  },

  async dismissInjectionAndRetry(id) {
    await clearOutboxInjection(id);
    const result = await retryPendingSideWrites();
    get().bump();
    return result;
  },

  async discardTask(id) {
    await removeOutboxTask(id);
    get().bump();
  },

  async pendingTasks() {
    return listOutbox().then((rows) => rows.filter((row) => row.status !== 'done'));
  },
}));
