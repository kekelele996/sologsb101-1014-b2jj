/**
 * 苗木批次（Seedling）——苗圃侧台账
 * 苗圃只管批次进场数量与供苗保证率；批次是全局在库资源，不再归属某块地块。
 * 项目部通过「栽植领用」按批次在库量挑苗，地块与批次的关系只存在于领用记录里。
 */

/** 树种：秋茄 / 桐花树 / 白骨壤 / 无瓣海桑 */
export type SeedlingSpecies = '秋茄' | '桐花树' | '白骨壤' | '无瓣海桑';

/** 来源：自育苗 / 外购 */
export type SeedlingSource = '自育苗' | '外购';

export const SEEDLING_SPECIES_OPTIONS: SeedlingSpecies[] = ['秋茄', '桐花树', '白骨壤', '无瓣海桑'];
export const SEEDLING_SOURCE_OPTIONS: SeedlingSource[] = ['自育苗', '外购'];

/** 外购苗历史数据升级时默认补登的供苗保证率（%） */
export const PURCHASED_DEFAULT_GUARANTEE_RATE = 80;

export interface Seedling {
  id: string;
  /** 树种 */
  species: SeedlingSpecies;
  /** 来源 */
  source: SeedlingSource;
  /** 规格（如 50cm 裸根苗 / 40cm 营养袋苗） */
  spec: string;
  /** 进场数量（株）——苗圃只登记进场数量 */
  quantity: number;
  /** 进场日期 YYYY-MM-DD */
  arrivalDate: string;
  /**
   * 供苗保证率（%）：结算时批次成活率低于该值要记差额。
   * null 表示不考核（自育苗默认不考核）。
   */
  guaranteeRate: number | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑苗木批次的表单草稿 */
export interface SeedlingDraft {
  species: SeedlingSpecies;
  source: SeedlingSource;
  spec: string;
  quantity: number;
  arrivalDate: string;
  /** 表单允许清空（自育苗不考核） */
  guaranteeRate: number | null;
}
