/** 分 P 缓存协议。腾讯云和 Worker 共用，数据库仍以 BV 为键。 */
export type PartCache<T> = Partial<T> & {
  parts?: Record<string, T>;
  firstCid?: string;
};

export const AI_SCRIPT_LABEL_PREFIX = 'ai-label:';

export function isValidCid(cid: unknown): cid is string {
  return typeof cid === 'string' && /^[1-9][0-9]{0,19}$/.test(cid);
}

/** 读取旧版整条记录，或为封面提取 P1；摘要里不带整个分 P 表。 */
export function selectVideoRecord<T extends { bvid: string }>(value: PartCache<T>, firstPart = false): T | null {
  const { firstCid, parts, ...legacy } = value;
  if (firstPart && firstCid && parts?.[firstCid]) return parts[firstCid];
  return 'bvid' in legacy ? legacy as T : null;
}

/** 保存当前 P 时保留其他 P 和旧字段，旧客户端写入时也保留分 P 表。 */
export function mergePartCache<T extends object>(
  previous: PartCache<T>,
  record: T,
  cid?: string,
  isFirstPart = false,
): PartCache<T> {
  if (!cid) return { ...previous, ...record };
  return {
    ...previous,
    ...(isFirstPart ? { firstCid: cid } : {}),
    parts: { ...previous.parts, [cid]: record },
  };
}

export function readLabelCache(value: string | null): PartCache<{ isAiScript: boolean }> {
  const parsed = value === null ? {} : JSON.parse(value);
  return typeof parsed === 'boolean' ? { isAiScript: parsed } : parsed;
}
