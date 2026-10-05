/**
 * 批次结算状态管理（Zustand）——苗圃侧
 * 维护苗圃本侧重试队列（结算单保存失败后的待办）；
 * 确认 / 驳回是项目部侧动作，但读写的是苗圃侧的结算单。
 */
import { create } from 'zustand';
import {
  confirmSettlement,
  initDatabase,
  rejectSettlement,
  removeSettlement,
  retryNurserySettlements,
} from '../utils/db';
import {
  listNurseryRetry,
  subscribeNurseryRetry,
  type NurseryRetryItem,
} from '../utils/nurseryQueue';

let subscribedRetry = false;

interface SettlementStoreState {
  /** 苗圃侧保存失败、待本侧重试的待办 */
  retryItems: NurseryRetryItem[];
  revision: number;
  init: () => Promise<void>;
  /** 项目部确认结算差额 */
  confirm: (settlementId: string) => Promise<void>;
  /** 项目部驳回结算差额 */
  reject: (settlementId: string, remark: string) => Promise<void>;
  /** 苗圃侧删除待确认单据 */
  drop: (settlementId: string) => Promise<void>;
  /** 立即重放全部苗圃本侧重试待办，返回仍残留的条数 */
  retryAll: () => Promise<{ success: number; remain: number }>;
}

export const useSettlementStore = create<SettlementStoreState>((set) => ({
  retryItems: [],
  revision: 0,

  async init() {
    await initDatabase();
    set({ retryItems: listNurseryRetry() });
    // 重试队列在 localStorage 里（其它标签页也可能写入），订阅变化自动刷新角标；只订阅一次
    if (!subscribedRetry) {
      subscribedRetry = true;
      subscribeNurseryRetry((items) => set({ retryItems: items }));
    }
    const result = await retryNurserySettlements();
    set({ retryItems: listNurseryRetry(), revision: result.remain + 1 });
  },

  async confirm(settlementId) {
    await confirmSettlement(settlementId);
    set({ revision: Date.now() });
  },

  async reject(settlementId, remark) {
    await rejectSettlement(settlementId, remark);
    set({ revision: Date.now() });
  },

  async drop(settlementId) {
    await removeSettlement(settlementId);
    set({ revision: Date.now() });
  },

  async retryAll() {
    const result = await retryNurserySettlements();
    set({ retryItems: listNurseryRetry(), revision: Date.now() });
    return result;
  },
}));
