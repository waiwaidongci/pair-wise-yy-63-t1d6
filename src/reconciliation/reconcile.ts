import type {
  BatchState,
  ChannelCode,
  ChannelDelivery,
  InvalidationReview,
  MergeOutcome,
  ReceiptRecord,
  ReleaseBatch,
  RevisionInfo,
  RevisionSeq,
  TokenDiffRow,
  TokenKind,
  TokenPackageEntry,
  TokenSnapshotEntry
} from './types';
import type { Token } from '../store';

/* ----------------------------- 通道目录 ----------------------------- */

export const CHANNEL_DIRECTORY: { code: ChannelCode; name: string; product: string }[] = [
  { code: 'component-lib', name: '通用组件库', product: 'Web 组件包' },
  { code: 'ops-console', name: '运营后台', product: 'Web 应用' },
  { code: 'mobile-kit', name: '移动端组件', product: 'iOS / Android' },
  { code: 'data-platform', name: '数据平台', product: 'Web 应用' }
];

/* --------------------------- 纯函数 / 工具 --------------------------- */

/** 令牌分类：无 ref 为基础令牌；组件分类且带 ref 为组件别名；其余为语义别名 */
export function classifyToken(token: Token): TokenKind {
  if (token.ref) return token.category === 'component' ? 'component' : 'alias';
  return 'base';
}

/** 基础令牌：不引用任何其他令牌；被引用也属于基础侧。新增的纯值令牌同样计入。 */
export function isBaseToken(token: Token): boolean {
  return !token.ref;
}

export function snapshotToken(token: Token): TokenSnapshotEntry {
  return {
    id: token.id,
    name: token.name,
    kind: classifyToken(token),
    value: token.value,
    ...(token.ref ? { ref: token.ref } : {}),
    themes: JSON.parse(JSON.stringify(token.themes)) as Record<string, string>
  };
}

/** 规范化序列化，字段顺序固定，避免同义 JSON 产生不同指纹 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`).join(',')}}`;
}

/** cyrb53 内容指纹，用于比对回包是否与冻结快照一致 */
export function checksumOf(value: unknown): string {
  const text = typeof value === 'string' ? value : canonicalize(value);
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** 递归解析别名到基础值，记录依赖链并标记循环 */
export function resolveToken(entry: TokenSnapshotEntry, byId: Map<string, TokenSnapshotEntry>): TokenPackageEntry {
  const chain: string[] = [entry.id];
  const seen = new Set<string>([entry.id]);
  let current = entry;
  while (current.ref) {
    const next = byId.get(current.ref);
    if (!next) break;
    if (seen.has(next.id)) {
      chain.push(next.id);
      return { ...entry, chain, resolvedValue: entry.value, cycle: true };
    }
    seen.add(next.id);
    chain.push(next.id);
    current = next;
  }
  return { ...entry, chain, resolvedValue: current.value, cycle: false };
}

export function buildPackage(snapshot: TokenSnapshotEntry[]): TokenPackageEntry[] {
  const byId = new Map(snapshot.map((entry) => [entry.id, entry]));
  return snapshot.map((entry) => resolveToken(entry, byId));
}

/** 通道收到的包：按冻结包生成，包含序号/修订/批次号与校验值 */
export function packageChecksum(pkg: TokenPackageEntry[]): string {
  return checksumOf(pkg.map((entry) => ({
    id: entry.id,
    value: entry.value,
    ref: entry.ref ?? null,
    resolvedValue: entry.resolvedValue,
    themes: entry.themes
  })));
}

/* ----------------------------- 批次创建 ----------------------------- */

export function nextBatchNo(sequence: number, now = Date.now()): string {
  const d = new Date(now);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `PB-${ymd}-${String(sequence).padStart(3, '0')}`;
}

function emptyDelivery(code: ChannelCode): ChannelDelivery {
  const meta = CHANNEL_DIRECTORY.find((item) => item.code === code)!;
  return { code, name: meta.name, status: 'pending', revision: 0, attempts: [], receipts: [] };
}

export function createBatch(input: {
  no: string;
  version: string;
  note: string;
  createdBy: string;
  channels: ChannelCode[];
  tokens: Token[];
  createdAt?: number;
}): ReleaseBatch {
  const createdAt = input.createdAt ?? Date.now();
  const frozenTokens = input.tokens.map(snapshotToken);
  const pkg = buildPackage(frozenTokens);
  const baseFingerprint = checksumOf(frozenTokens.filter((t) => t.kind === 'base').map((t) => ({ id: t.id, value: t.value, themes: t.themes })));
  const revision0: RevisionInfo = { seq: 0, reason: '批次创建，冻结候选值与依赖快照', createdAt, baseFingerprint };
  const deliveries = {} as Record<ChannelCode, ChannelDelivery>;
  input.channels.forEach((code) => { deliveries[code] = emptyDelivery(code); });
  return {
    no: input.no,
    version: input.version,
    note: input.note,
    createdBy: input.createdBy,
    createdAt,
    state: 'open' as BatchState,
    currentRevision: 0,
    channels: [...input.channels],
    frozenTokens,
    tokenPackages: { 0: pkg },
    revisions: [revision0],
    deliveries,
    invalidationReviews: []
  };
}

/* ----------------------------- 写入尝试 ----------------------------- */

/** 每个通道维护全局单调序号：一次真实写入（无论成功失败）占一个序号 */
export function nextChannelSeq(registry: Record<string, number>, code: ChannelCode): number {
  const next = (registry[code] ?? 0) + 1;
  registry[code] = next; // eslint-disable-line no-param-reassign
  return next;
}

export interface WriteResult {
  delivery: ChannelDelivery;
  seq: number;
  checksum: string;
}

/**
 * 记录一次写入尝试。失败也保留批次与尝试记录（可恢复重试）；
 * 重试只针对未完成（pending/failed/awaiting）通道，confirmed 永不重发。
 */
export function registerWrite(
  delivery: ChannelDelivery,
  seq: number,
  revision: RevisionSeq,
  checksum: string,
  result: 'written' | 'write-failed',
  error?: string
): WriteResult {
  delivery.revision = revision;
  delivery.attempts.push({ at: Date.now(), seq, revision, checksum, result, ...(error ? { error } : {}) });
  delivery.status = result === 'written' ? 'awaiting' : 'failed';
  return { delivery, seq, checksum };
}

/* --------------------------- 回执合并（对账核心） --------------------------- */

export function receiptKey(receipt: ReceiptRecord): string {
  return `${receipt.channel}#${receipt.seq}:${receipt.checksum.slice(0, 8)}`;
}

function findAttempt(delivery: ChannelDelivery, receipt: ReceiptRecord) {
  return delivery.attempts.find((a) => a.result === 'written' && a.seq === receipt.seq);
}

/**
 * 按批次号 + 通道号合并回执：
 * 1. 同一通道重复回执（seq + checksum 完全一致）只留首次；
 * 2. 序号乱到（低于已确认/首留序号，或无对应写入）→ 保留双方进入待核；
 * 3. 内容不一致（checksum 与该次写入不符）→ 保留双方进入待核；
 * 4. 正常回执：确认通道，标记确认时所用修订与快照。
 */
export function mergeReceipt(batch: ReleaseBatch, receipt: ReceiptRecord): MergeOutcome {
  const delivery = batch.deliveries[receipt.channel];
  if (!delivery) throw new Error(`批次 ${batch.no} 不存在通道 ${receipt.channel}`);

  const first = delivery.receipts[0];
  const exactDuplicate = delivery.receipts.find(
    (r) => r.seq === receipt.seq && r.checksum === receipt.checksum
  );
  if (exactDuplicate) {
    return { kind: 'duplicate-ack', first: exactDuplicate };
  }

  const attempt = findAttempt(delivery, receipt);

  // 待核未闭合期间到达的任何新回执，继续作为补充证据留档，不自动确认
  if (delivery.dispute && !delivery.dispute.resolved) {
    delivery.receipts.push(receipt);
    const mismatched = !attempt || receipt.checksum !== attempt.checksum;
    delivery.dispute.note += `；${new Date(receipt.receivedAt).toLocaleTimeString('zh-CN')} 又到序号 ${receipt.seq}（${mismatched ? '内容不一致' : '可配对'}），已留档待人工核账`;
    return { kind: 'dispute', reason: mismatched ? 'checksum-mismatch' : 'out-of-order', receipt, kept: delivery.receipts[0] };
  }

  // 已确认通道：任何与确认回执不同（seq 或 checksum）的新回执都是冲突，双方留档
  if (delivery.status === 'confirmed') {
    delivery.receipts.push(receipt);
    const confirmedReceipt = delivery.receipts.find((r) => receiptKey(r) === delivery.confirmedKey) ?? first;
    const reason = confirmedReceipt && receipt.seq < confirmedReceipt.seq ? 'out-of-order' : 'checksum-mismatch';
    delivery.status = 'disputed';
    delivery.dispute = delivery.dispute ?? {
      reason,
      note: reason === 'out-of-order'
        ? `通道已按序号 ${confirmedReceipt?.seq} 确认，序号 ${receipt.seq} 的回执晚到（乱到），双方均已留档`
        : `通道已确认（序号 ${confirmedReceipt?.seq} / 指纹 ${confirmedReceipt?.checksum.slice(0, 8)}），又到不一致回执（序号 ${receipt.seq} / ${receipt.checksum.slice(0, 8)}），双方均已留档`,
      at: Date.now(),
      firstKey: confirmedReceipt ? receiptKey(confirmedReceipt) : receiptKey(receipt)
    };
    return { kind: 'dispute', reason, receipt, kept: confirmedReceipt ?? receipt };
  }

  // 未确认通道的“先到一方”：以第一条回执为首次保留
  const baseline = first ?? (attempt
    ? ({ seq: attempt.seq, checksum: attempt.checksum } as ReceiptRecord)
    : undefined);

  const disorder = (baseline && receipt.seq < baseline.seq) || !attempt;
  if (disorder) {
    delivery.receipts.push(receipt);
    // 首次保留：没有更早回执时，本条即为“先到一方”
    const kept = first ?? receipt;
    delivery.dispute = delivery.dispute ?? {
      reason: 'out-of-order',
      note: !attempt
        ? `序号 ${receipt.seq} 无对应写入记录，无法与任何发包配对`
        : `回执序号 ${receipt.seq} 早于已保留序号 ${baseline!.seq}（乱到），双方均已留档`,
      at: Date.now(),
      firstKey: receiptKey(kept)
    };
    delivery.status = 'disputed';
    return { kind: 'dispute', reason: 'out-of-order', receipt, kept };
  }

  if (receipt.checksum !== attempt!.checksum) {
    delivery.receipts.push(receipt);
    const kept = first ?? receipt;
    delivery.dispute = delivery.dispute ?? {
      reason: 'checksum-mismatch',
      note: `序号 ${receipt.seq} 回包指纹 ${receipt.checksum.slice(0, 8)} 与发包 ${attempt!.checksum.slice(0, 8)} 不一致，双方均已留档`,
      at: Date.now(),
      firstKey: receiptKey(kept)
    };
    delivery.status = 'disputed';
    return { kind: 'dispute', reason: 'checksum-mismatch', receipt, kept };
  }

  // 同 seq 重复但带新 checksum 的情况已在上面拦截；此处为合法确认
  // 重发同一未完成通道：seq 更大、checksum 与当前修订一致 → 正常确认（幂等）
  delivery.receipts.push(receipt);
  delivery.status = 'confirmed';
  delivery.confirmedAt = Date.now();
  delivery.confirmedKey = receiptKey(receipt);
  delivery.dispute = undefined;
  return { kind: 'confirmed', receipt };
}

/* --------------------------- 待核处理 --------------------------- */

export function resolveDispute(
  batch: ReleaseBatch,
  code: ChannelCode,
  action: 'accept-first' | 'accept-conflict'
): void {
  const delivery = batch.deliveries[code];
  if (!delivery?.dispute || delivery.dispute.resolved) return;
  const first = delivery.receipts[0];
  const conflict = delivery.receipts[delivery.receipts.length - 1];
  const accepted = action === 'accept-first' ? first : conflict;
  if (!accepted) return;

  delivery.dispute.resolved = { action, receiptKey: receiptKey(accepted), at: Date.now() };

  // 采纳的回执若能与某次写入配对且指纹一致，则闭合通道；否则通道回到待发，需要补发
  const matched = delivery.attempts.find((a) => a.result === 'written' && a.seq === accepted.seq && a.checksum === accepted.checksum);
  if (matched) {
    delivery.status = 'confirmed';
    delivery.confirmedAt = Date.now();
    delivery.confirmedKey = receiptKey(accepted);
    delivery.revision = matched.revision;
  } else {
    delivery.status = 'pending';
  }
}

/* --------------------- 基础令牌改动：未闭合批次失效重算 --------------------- */

export interface InvalidationInput {
  batch: ReleaseBatch;
  tokens: Token[];
  reason: string;
  changedBaseTokens: string[];
  createdAt?: number;
}

export function appendRevision(input: InvalidationInput): InvalidationReview {
  const { batch } = input;
  const now = input.createdAt ?? Date.now();
  const seq = batch.currentRevision + 1;
  const snapshot = input.tokens.map(snapshotToken);
  const pkg = buildPackage(snapshot);
  const baseFingerprint = checksumOf(snapshot.filter((t) => t.kind === 'base').map((t) => ({ id: t.id, value: t.value, themes: t.themes })));

  const revision: RevisionInfo = { seq, reason: input.reason, createdAt: now, baseFingerprint };
  batch.tokenPackages[seq] = pkg;
  batch.revisions.push(revision);
  batch.currentRevision = seq;

  const affected: ChannelCode[] = [];
  const confirmed: ChannelCode[] = [];
  batch.channels.forEach((code) => {
    const delivery = batch.deliveries[code];
    if (delivery.status === 'confirmed') {
      confirmed.push(code);
      return; // 已确认通道仍按原快照可查，不重发
    }
    affected.push(code);
    // 未完成通道：尝试与待核记录保留，通道回到待发，按新修订重算
    delivery.status = 'pending';
    delivery.revision = seq;
    delivery.dispute = undefined;
  });

  const review: InvalidationReview = {
    revision,
    affectedChannels: affected,
    confirmedChannels: confirmed,
    changedBaseTokens: input.changedBaseTokens
  };
  batch.invalidationReviews.push(review);
  return review;
}

/** 已确认通道按其确认时修订的快照，与最新修订的补发差异 */
export function reissueDiff(batch: ReleaseBatch, code: ChannelCode): TokenDiffRow[] {
  const delivery = batch.deliveries[code];
  if (!delivery || delivery.status !== 'confirmed') return [];
  const oldPkg = batch.tokenPackages[delivery.revision] ?? [];
  const newPkg = batch.tokenPackages[batch.currentRevision] ?? [];
  const oldById = new Map(oldPkg.map((t) => [t.id, t]));
  const newById = new Map(newPkg.map((t) => [t.id, t]));
  const rows: TokenDiffRow[] = [];
  newById.forEach((next, id) => {
    const prev = oldById.get(id);
    if (!prev || prev.resolvedValue !== next.resolvedValue || prev.value !== next.value) {
      rows.push({
        id,
        name: next.name,
        kind: next.kind,
        before: prev ? prev.resolvedValue : '（旧快照不存在）',
        after: next.resolvedValue
      });
    }
  });
  oldById.forEach((prev, id) => {
    if (!newById.has(id)) {
      rows.push({ id, name: prev.name, kind: prev.kind, before: prev.resolvedValue, after: '（新快照已移除）' });
    }
  });
  return rows;
}

/* ----------------------------- 批次闭合 ----------------------------- */

export function closeBatch(batch: ReleaseBatch, now = Date.now()): boolean {
  const allConfirmed = batch.channels.every((code) => batch.deliveries[code].status === 'confirmed');
  if (!allConfirmed) return false;
  batch.state = 'closed';
  batch.closedAt = now;
  return true;
}

export function batchProgress(batch: ReleaseBatch) {
  const total = batch.channels.length;
  const confirmed = batch.channels.filter((c) => batch.deliveries[c].status === 'confirmed').length;
  const disputed = batch.channels.filter((c) => batch.deliveries[c].status === 'disputed').length;
  const failed = batch.channels.filter((c) => batch.deliveries[c].status === 'failed').length;
  return { total, confirmed, disputed, failed, pending: total - confirmed - disputed - failed };
}
