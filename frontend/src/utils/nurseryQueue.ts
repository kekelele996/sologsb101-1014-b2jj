/**
 * 苗圃侧「本侧重试」队列
 *
 * 业务规则：苗圃那份（结算单）保存失败后只重试苗圃本侧的写入，
 * 项目部侧的栽植 / 验收保存照旧、互不牵连、互不回滚。
 *
 * 重试动作按地块幂等重放：重新读当前数据 → 重算短差 → 写入结算单，
 * 因此队列里只需要记 plotId（同一地块重复入队会去重）。
 * 用 localStorage 保存（浏览器无后端，结算单本身在 IndexedDB，这里只存待办）。
 */
import { nowIso, uuid } from './id';

const QUEUE_KEY = 'gbmangrove:nurseryRetryQueue';

export interface NurseryRetryItem {
  id: string;
  plotId: string;
  reason: string;
  queuedAt: string;
}

type Listener = (items: NurseryRetryItem[]) => void;
const listeners = new Set<Listener>();

function safeParse(raw: string | null): NurseryRetryItem[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is NurseryRetryItem =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as NurseryRetryItem).plotId === 'string' &&
        typeof (item as NurseryRetryItem).reason === 'string',
    );
  } catch {
    return [];
  }
}

function persist(items: NurseryRetryItem[]): void {
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch {
    /* 隐私模式 / 配额满：本次重试待办丢失也不阻塞项目部侧业务 */
  }
  listeners.forEach((listener) => listener([...items]));
}

/** 读取全部待重试项 */
export function listNurseryRetry(): NurseryRetryItem[] {
  try {
    return safeParse(window.localStorage.getItem(QUEUE_KEY));
  } catch {
    return [];
  }
}

/** 同一地块只保留一条待办（幂等入队） */
export function enqueueNurseryRetry(plotId: string, reason: string): NurseryRetryItem[] {
  const items = listNurseryRetry();
  if (items.some((item) => item.plotId === plotId)) {
    persist(items);
    return items;
  }
  const next = [...items, { id: uuid('nursery-retry'), plotId, reason, queuedAt: nowIso() }];
  persist(next);
  return next;
}

/** 某地块重试成功后移出队列 */
export function dequeueNurseryRetry(plotId: string): NurseryRetryItem[] {
  const items = listNurseryRetry();
  const next = items.filter((item) => item.plotId !== plotId);
  if (next.length !== items.length) persist(next);
  return next;
}

/** 订阅队列变化（结算页角标 / 重试按钮用） */
export function subscribeNurseryRetry(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
