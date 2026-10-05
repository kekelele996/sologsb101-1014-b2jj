/**
 * 两侧各自记账的跨侧动作（Ledger / Outbox）
 *
 * 苗圃与项目部「各记各的」：一次领用会同时落在
 *  - 项目部侧：plantings（栽植领用）
 *  - 苗圃侧：nurseryOutflows（苗圃供苗流水账，按批次记出库）
 *
 * 一次验收测次会触发苗圃侧重算结算单。两侧写入彼此独立：
 * 苗圃那份保存失败后只把「苗圃侧动作」挂进 outbox 重试，项目部侧照旧提交、不回滚。
 */

/** 归属侧别：苗圃 / 项目部 */
export type Side = 'nursery' | 'project';

/** 苗圃供苗流水账动作类型 */
export type OutflowAction = '领用出库' | '领用冲销';

/** 苗圃供苗流水账（苗圃侧，按批次对项目部领用的镜像记账） */
export interface NurseryOutflow {
  id: string;
  /** 出库苗木批次 */
  seedlingId: string;
  /** 领用地块（项目部侧地块 id，仅作对账备注） */
  plotId: string;
  /** 对应的项目部领用记录 id */
  plantingId: string;
  /** 动作：新领用出库 / 删除领用时冲销 */
  action: OutflowAction;
  /** 出库株数（冲销记负数） */
  count: number;
  /** 动作发生日期 YYYY-MM-DD */
  date: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/**
 * 跨侧重试任务：某一侧保存失败时，只把本侧要做的事挂起重试，
 * 不影响另一侧已经提交成功的数据。
 */
export type OutboxKind =
  | 'outflow-sync' // 苗圃侧：按领用记录重建供苗流水账（幂等）
  | 'settlement-sync' // 苗圃侧：按验收测次重建批次结算单（幂等）
  | 'plot-purge'; // 苗圃侧：地块删除后清理其流水账与结算单（幂等）

/** 重试任务状态 */
export type OutboxStatus = 'pending' | 'done' | 'failed';

export interface OutboxTask {
  id: string;
  /** 发起方（哪一摊要重试自己的那份） */
  side: Side;
  kind: OutboxKind;
  /** 幂等键：同 key 只保留一条，避免重试产生重复流水 */
  dedupeKey: string;
  /** 动作载荷（如 plantingId / plotId） */
  refId: string;
  status: OutboxStatus;
  /** 最近一次失败原因，便于界面提示 */
  lastError: string;
  attempts: number;
  /** 故障注入标记：由「模拟苗圃保存失败」开关写入 */
  injected: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
