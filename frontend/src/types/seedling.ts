/**
 * 苗木批次（Seedling）——苗圃侧台账
 * 苗圃只登记：进场数量与供苗保证率；不记录任何地块成活率。
 * 地块维度的栽植、验收由项目部侧（Planting / Survey）维护，两边各记各的。
 */

/** 树种：秋茄 / 桐花树 / 白骨壤 / 无瓣海桑 */
export type SeedlingSpecies = '秋茄' | '桐花树' | '白骨壤' | '无瓣海桑';

/** 来源：自育苗 / 外购 */
export type SeedlingSource = '自育苗' | '外购';

/**
 * 供苗保证率（%，0–100，保留 1 位小数）。
 * null 表示不考核（升级历史数据时，自育苗一律补 null）。
 */
export type GuaranteeRate = number | null;

export const SEEDLING_SPECIES_OPTIONS: SeedlingSpecies[] = ['秋茄', '桐花树', '白骨壤', '无瓣海桑'];
export const SEEDLING_SOURCE_OPTIONS: SeedlingSource[] = ['自育苗', '外购'];

/** 外购苗历史数据升级时默认补登的供苗保证率（八成） */
export const PURCHASED_DEFAULT_GUARANTEE_RATE = 80;

/** 供苗保证率录入范围（%） */
export const GUARANTEE_RATE_MIN = 1;
export const GUARANTEE_RATE_MAX = 100;

/**
 * 按来源给出新建批次时的供苗保证率默认值：
 * 自育苗不考核（null），外购默认按八成（80%）登记。
 */
export function defaultGuaranteeRate(source: SeedlingSource): GuaranteeRate {
  return source === '外购' ? PURCHASED_DEFAULT_GUARANTEE_RATE : null;
}

/** 供苗保证率展示文案 */
export function guaranteeRateText(rate: GuaranteeRate): string {
  return rate === null ? '不考核' : `${rate}%`;
}

export interface Seedling {
  id: string;
  /** 所属地块（该批苗预供给的地块，仅用于筛选挂接；数量口径仍归苗圃） */
  plotId: string;
  /** 树种 */
  species: SeedlingSpecies;
  /** 来源 */
  source: SeedlingSource;
  /** 规格（如 50cm 裸根苗 / 40cm 营养袋苗） */
  spec: string;
  /** 进场数量（株）——苗圃只管进场数量 */
  quantity: number;
  /** 供苗保证率（%）；null = 不考核（自育苗） */
  guaranteeRate: GuaranteeRate;
  /** 进场日期 YYYY-MM-DD */
  arrivalDate: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑苗木批次的表单草稿 */
export interface SeedlingDraft {
  plotId: string;
  species: SeedlingSpecies;
  source: SeedlingSource;
  spec: string;
  quantity: number;
  guaranteeRate: GuaranteeRate;
  arrivalDate: string;
}
