/**
 * 栽植领用（Planting）——项目部侧台账
 * 项目部按地块向苗圃领用栽植：挑苗圃当时在库的批次，在库够多少就落实多少，
 * 超出进场（在库）数量的部分先挂起，等苗圃补苗后再落实。
 */

/** 领用状态：已落实 / 挂起（在库不足）/ 部分挂起 */
export type PlantingStatus = '已落实' | '部分挂起' | '挂起';

export const PLANTING_STATUS_OPTIONS: PlantingStatus[] = ['已落实', '部分挂起', '挂起'];

export interface Planting {
  id: string;
  /** 所属地块（项目部侧） */
  plotId: string;
  /** 领用的苗木批次（苗圃侧批次 id） */
  seedlingId: string;
  /** 栽植日期 YYYY-MM-DD */
  plantDate: string;
  /** 株距（米） */
  spacingM: number;
  /** 领用株数（株） */
  count: number;
  /**
   * 已落实株数：按领用当时苗圃在库量分配得到。
   * fulfilledCount < count 的差额即挂起株数，挂起部分不占在库、不计入栽植总株数。
   */
  fulfilledCount: number;
  /** 领用状态（由 count / fulfilledCount 派生并落库，便于筛选与索引） */
  status: PlantingStatus;
  /** 作业班组 */
  operator: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 挂起株数 = 领用 - 已落实 */
export function plantingHeldCount(row: Pick<Planting, 'count' | 'fulfilledCount'>): number {
  return Math.max(0, row.count - row.fulfilledCount);
}

/** 由数量推导领用状态 */
export function plantingStatusOf(count: number, fulfilledCount: number): PlantingStatus {
  if (fulfilledCount <= 0) return '挂起';
  if (fulfilledCount < count) return '部分挂起';
  return '已落实';
}

/** 新建 / 编辑栽植领用的表单草稿 */
export interface PlantingDraft {
  plotId: string;
  seedlingId: string;
  plantDate: string;
  spacingM: number;
  count: number;
  operator: string;
}
