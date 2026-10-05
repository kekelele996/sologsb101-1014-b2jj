/**
 * 批次结算单（Settlement）——苗圃侧
 *
 * 验收测次的成活株数按「已落实领用」比例摊回各苗木批次，算出批次成活率；
 * 低于批次供苗保证率的差额（株）记进结算单，等项目部确认后扣款/补差。
 * 不考核（自育苗）的批次不出结算行。
 */

/** 结算状态：待项目部确认 / 项目部已确认 */
export type SettlementStatus = '待确认' | '已确认';

export const SETTLEMENT_STATUS_OPTIONS: SettlementStatus[] = ['待确认', '已确认'];

export interface Settlement {
  id: string;
  /** 结算批次 */
  seedlingId: string;
  /** 依据的地块（测次按地块登记） */
  plotId: string;
  /** 依据的验收记录 id */
  surveyId: string;
  /** 依据的测次 */
  round: number;
  /** 摊到该批次的已落实领用量（分母，株） */
  allocatedPlanted: number;
  /** 摊回该批次的成活株数（株，整数） */
  allocatedAlive: number;
  /** 批次成活率（%，保留 1 位） */
  batchRate: number;
  /** 供苗保证率（%） */
  guaranteeRate: number;
  /** 保证成活株数（株，整数） */
  guaranteedAlive: number;
  /** 低于保证率的差额株数（不低于 0） */
  shortfallCount: number;
  status: SettlementStatus;
  /** 项目部确认时间 */
  confirmedAt: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 批次结算行的稳定主键：同一地块同一批次的结算行重建时可保留确认状态 */
export function settlementId(plotId: string, seedlingId: string): string {
  return `settle-${plotId}-${seedlingId}`;
}
