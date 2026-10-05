/**
 * 批次结算单（Settlement）——苗圃侧发起、项目部侧确认
 * 测次的成活株数按领用摊回苗木批次后算出批次成活率；
 * 批次成活率低于供苗保证率的差额（百分点 / 株数）记进结算单，等项目部确认。
 *
 * 保存采取「各侧独立重试」策略：
 * 苗圃那份（结算单本身）保存失败只重试苗圃侧本侧写入；
 * 项目部侧（栽植、验收）照旧，互不牵连。
 */
import type { GuaranteeRate } from './seedling';

/** 结算状态：苗圃生成后待项目部确认；项目部可确认或驳回 */
export type SettlementStatus = '待确认' | '已确认' | '已驳回';

export const SETTLEMENT_STATUS_OPTIONS: SettlementStatus[] = ['待确认', '已确认', '已驳回'];

export interface Settlement {
  id: string;
  /** 对账批次（苗木批次 id，两边按批次对账的纽带） */
  seedlingId: string;
  /** 批次所属地块（冗余，便于按地块筛选） */
  plotId: string;
  /** 生成时依据的验收测次 id */
  surveyId: string;
  /** 测次序号（冗余） */
  round: number;
  /** 测次日期 YYYY-MM-DD（冗余） */
  surveyDate: string;
  /** 该批次累计领用中参与摊回的株数（挂起部分不计） */
  issuedCount: number;
  /** 测次成活株数按领用摊回本批的株数 */
  aliveCount: number;
  /** 批次成活率（%，保留 1 位小数）= 摊回成活株数 / 参与摊回领用株数 */
  batchRate: number;
  /** 供苗保证率（%）——生成时从批次快照，后续改批次不影响已开单据 */
  guaranteeRate: number;
  /** 保证率差额（百分点）= max(0, 保证率 - 批次成活率) */
  shortRate: number;
  /** 差额株数 = 参与摊回领用株数 × 保证率差额（四舍五入） */
  shortCount: number;
  /** 结算状态 */
  status: SettlementStatus;
  /** 项目部确认时间 YYYY-MM-DD；未确认为空串 */
  confirmedAt: string;
  /** 项目部驳回原因 / 备注 */
  remark: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 结算单里保证率缺失时的兜底（理论上不考核的批次不会生成结算单） */
export type SettlementGuarantee = Exclude<GuaranteeRate, null>;
