/**
 * 栽植领用（Planting）——项目部侧台账
 * 项目部只管：从苗圃在库批次领用栽植、登记株距株数与验收测次。
 * 领用挑苗圃当时在库的批次；累计领用超出批次进场数量时先挂起（pending），
 * 不参与测次成活株数的批次摊回，待苗圃补足进场数量后再恢复在库。
 */

/** 领用状态：在库批次内的领用为「在库」，超出进场数量的先「挂起」 */
export type PlantingStatus = 'active' | 'pending';

export const PLANTING_STATUS_LABEL: Record<PlantingStatus, string> = {
  active: '在库',
  pending: '挂起',
};

export interface Planting {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 领用的苗木批次（苗圃侧批次 id，两边按批次对账的纽带） */
  seedlingId: string;
  /** 栽植日期 YYYY-MM-DD */
  plantDate: string;
  /** 株距（米） */
  spacingM: number;
  /** 本次领用 / 栽植株数 */
  count: number;
  /** 作业班组 */
  operator: string;
  /** 领用状态：在库 / 挂起（超出进场数量） */
  status: PlantingStatus;
  /** 挂起时超出进场数量的株数；在库时为 0 */
  overQuantity: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑栽植记录的表单草稿 */
export interface PlantingDraft {
  plotId: string;
  seedlingId: string;
  plantDate: string;
  spacingM: number;
  count: number;
  operator: string;
}
