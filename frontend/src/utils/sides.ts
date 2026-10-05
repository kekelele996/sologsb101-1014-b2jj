/**
 * 两摊分家的写入编排（苗圃侧 / 项目部侧「各记各的」）
 *
 * 一次业务动作（领用、验收、删地块）两侧各写各的账：
 *  - 项目部侧先按普通事务提交自己那份（plantings / surveys / plots…）；
 *  - 苗圃侧随后登记自己那份（供苗流水账 / 结算单 / 清理）。
 * 苗圃那份保存失败时，只把苗圃侧动作挂进 outbox 重试，项目部侧不回滚、照旧。
 *
 * 为便于在纯前端演示「保存失败 → 只重试本侧」，这里提供一个故障注入开关：
 * 打开期间，所有苗圃侧写入都会失败并入队；关闭后重放队列即可成功。
 */
import type { Planting } from '../types/planting';
import {
  db,
  enqueueOutbox,
  processOutbox,
  syncNurseryOutflows,
  rebuildSettlements,
  purgeNurseryPlot,
} from './db';

const FAIL_SWITCH_KEY = 'gbmangrove:simulateNurseryFailure';

function readFailSwitch(): boolean {
  try {
    return window.localStorage.getItem(FAIL_SWITCH_KEY) === '1';
  } catch {
    return false;
  }
}

function writeFailSwitch(on: boolean): void {
  try {
    window.localStorage.setItem(FAIL_SWITCH_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式静默降级 */
  }
}

/** 苗圃侧当前是否处于「保存失败」模拟状态 */
export function nurseryWriteFailing(): boolean {
  return readFailSwitch();
}

/** 开 / 关「苗圃保存失败」模拟；开关本身只影响苗圃侧，项目部侧始终正常 */
export function setNurseryWriteFailing(on: boolean): void {
  writeFailSwitch(on);
  if (!on) {
    // 关掉故障后立即补提，验证只重试苗圃侧动作
    void processOutbox();
  }
}

/** 苗圃侧一次写入：故障开启则抛错，交给出队方入侧重试队列 */
async function nurseryWrite(label: string, action: () => Promise<void>): Promise<void> {
  if (readFailSwitch()) {
    throw new Error(`${label}失败（模拟）：苗圃侧暂存故障，项目部侧不受影响`);
  }
  await action();
}

export interface TwoSideResult {
  /** 苗圃侧是否未能即时落账（已挂本侧重试队列） */
  nurseryPending: boolean;
  message: string;
}

/**
 * 项目部保存一条栽植领用后：
 * 项目部侧（plantings）已由调用方提交；这里只登记苗圃侧供苗流水账，
 * 失败则只把苗圃动作入队，领用本身不回滚。
 */
export async function afterRequisitionSaved(_planting: Planting): Promise<TwoSideResult> {
  try {
    await nurseryWrite('苗圃供苗流水账登记', () => syncNurseryOutflows());
    return { nurseryPending: false, message: '苗圃供苗流水账已同步' };
  } catch (error) {
    await enqueueOutbox({
      side: 'nursery',
      kind: 'outflow-sync',
      refId: 'all',
      injected: readFailSwitch(),
    });
    return {
      nurseryPending: true,
      message: `${error instanceof Error ? error.message : '苗圃侧登记失败'}，已只对苗圃侧重试；领用已生效。`,
    };
  }
}

/** 领用删除后同样要让苗圃侧重算流水账（幂等重建） */
export async function afterRequisitionRemoved(): Promise<TwoSideResult> {
  return afterRequisitionSaved({} as Planting);
}

/**
 * 项目部保存验收测次后：
 * 测次（surveys）已由项目部侧提交；苗圃侧据此把成活株数摊回批次、重建结算单，
 * 失败只挂苗圃侧重试，测次照常。
 */
export async function afterSurveySaved(): Promise<TwoSideResult> {
  try {
    await nurseryWrite('批次结算单重算', () => rebuildSettlements());
    return { nurseryPending: false, message: '批次结算单已按最新测次重算' };
  } catch (error) {
    await enqueueOutbox({
      side: 'nursery',
      kind: 'settlement-sync',
      refId: 'all',
      injected: readFailSwitch(),
    });
    return {
      nurseryPending: true,
      message: `${error instanceof Error ? error.message : '苗圃侧重算失败'}，已只对苗圃侧重试；测次已生效。`,
    };
  }
}

/**
 * 项目部删除地块后：清理苗圃侧该地块的流水账与结算单，
 * 失败只挂苗圃侧重试（plot-purge），项目部侧删除不回滚。
 */
export async function afterPlotRemoved(plotId: string): Promise<TwoSideResult> {
  try {
    await nurseryWrite('苗圃侧地块账清理', () => purgeNurseryPlot(plotId));
    return { nurseryPending: false, message: '苗圃侧流水账与结算单已清理' };
  } catch (error) {
    await enqueueOutbox({
      side: 'nursery',
      kind: 'plot-purge',
      refId: plotId,
      injected: readFailSwitch(),
    });
    return {
      nurseryPending: true,
      message: `${error instanceof Error ? error.message : '苗圃侧清理失败'}，已只对苗圃侧重试；地块已删除。`,
    };
  }
}

/** 手动重放本侧重试队列：仍开启故障注入时，注入任务继续失败，项目部侧任务不受影响 */
export async function retryPendingSideWrites(): Promise<{ done: number; failed: number }> {
  return processOutbox((task) => task.side === 'nursery' && task.injected && readFailSwitch());
}

/** 供页面读取待重试条数（实时订阅用直接查 db.outbox） */
export async function pendingSideWrites(): Promise<number> {
  return db.outbox.where('status').anyOf('pending', 'failed').count();
}
