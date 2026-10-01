import type { Token } from './store';

// ── 领域模型 ──────────────────────────────────────────────

export type ChannelStatus = 'pending' | 'sent' | 'confirmed' | 'failed' | 'review';
export type BatchStatus = 'open' | 'closed' | 'invalidated';
export type ReviewReason = 'seq_out_of_order' | 'content_mismatch' | 'duplicate';

export type FrozenToken = {
  id: string;
  name: string;
  category: string;
  value: string;
  ref?: string;
  themes: Record<string, string>;
  status: string;
};

export type FrozenSnapshot = {
  frozenAt: string;
  tokens: FrozenToken[];
  dependencyEdges: { from: string; to: string }[];
  contentHash: string;
};

export type ProductChannel = {
  channelNo: string;
  product: string;
  status: ChannelStatus;
  seq: number;
  contentHash: string;
  sentAt?: string;
  confirmedAt?: string;
  retryCount: number;
  lastError?: string;
};

export type Receipt = {
  id: string;
  batchNo: string;
  channelNo: string;
  seq: number;
  contentHash: string;
  receivedAt: string;
  raw: string;
};

export type ReviewItem = {
  id: string;
  batchNo: string;
  channelNo: string;
  reason: ReviewReason;
  firstReceipt: Receipt;
  secondReceipt: Receipt;
  status: 'pending' | 'resolved';
  createdAt: string;
  resolution?: string;
};

export type ReissueDiff = {
  channelNo: string;
  product: string;
  originalHash: string;
  currentHash: string;
  changedTokens: { id: string; name: string; before: string; after: string }[];
  computedAt: string;
};

export type ReleaseBatch = {
  batchNo: string;
  version: string;
  status: BatchStatus;
  createdAt: string;
  closedAt?: string;
  snapshot: FrozenSnapshot;
  originalSnapshot: FrozenSnapshot;
  channels: ProductChannel[];
  receipts: Receipt[];
  reviewItems: ReviewItem[];
  reissueDiffs: ReissueDiff[];
  invalidatedAt?: string;
  invalidateReason?: string;
  recalculatedAt?: string;
};

// ── 工具函数 ──────────────────────────────────────────────

/** 简单确定性哈希，用于内容比对 */
export function hashContent(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return `h${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/** 冻结候选值与依赖快照 */
export function freezeSnapshot(tokens: Token[]): FrozenSnapshot {
  const frozenTokens: FrozenToken[] = tokens.map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    value: t.value,
    ref: t.ref,
    themes: { ...t.themes },
    status: t.status
  }));
  const dependencyEdges = tokens
    .filter((t) => t.ref)
    .map((t) => ({ from: t.ref!, to: t.id }));
  const contentHash = hashContent(JSON.stringify({ tokens: frozenTokens, edges: dependencyEdges }));
  return {
    frozenAt: new Date().toISOString(),
    tokens: frozenTokens,
    dependencyEdges,
    contentHash
  };
}

export function nextBatchNo(existing: ReleaseBatch[]): string {
  return `B${String(existing.length + 1).padStart(4, '0')}`;
}

export function nextChannelNo(existing: ProductChannel[]): string {
  return `CH${String(existing.length + 1).padStart(3, '0')}`;
}

/** 判断某令牌是否为基础令牌（被其他令牌引用） */
export function isBaseToken(tokenId: string, tokens: Token[]): boolean {
  return tokens.some((t) => t.ref === tokenId);
}

// ── 回执合并 ──────────────────────────────────────────────

export type MergeResult = 'accepted' | 'duplicate' | 'review';

/**
 * 按 (批次号, 通道号) 合并回执。
 * - 首次回执：接受并确认通道
 * - 重复回执：只留首次
 * - 序号乱到或内容不一致：保留双方并进入待核
 */
export function mergeReceipt(
  batch: ReleaseBatch,
  receipt: Omit<Receipt, 'id' | 'receivedAt'>
): { batch: ReleaseBatch; result: MergeResult; reviewItem?: ReviewItem } {
  const now = new Date().toISOString();
  const fullReceipt: Receipt = {
    ...receipt,
    id: `R${Date.now()}${Math.floor(Math.random() * 1000)}`,
    receivedAt: now
  };

  const existing = batch.receipts.find(
    (r) => r.batchNo === receipt.batchNo && r.channelNo === receipt.channelNo
  );
  const channel = batch.channels.find((c) => c.channelNo === receipt.channelNo);

  if (!existing) {
    const updatedBatch: ReleaseBatch = {
      ...batch,
      receipts: [...batch.receipts, fullReceipt],
      channels: batch.channels.map((c) =>
        c.channelNo === receipt.channelNo
          ? { ...c, status: 'confirmed', confirmedAt: now }
          : c
      )
    };
    if (updatedBatch.channels.every((c) => c.status === 'confirmed')) {
      updatedBatch.status = 'closed';
      updatedBatch.closedAt = now;
    }
    return { batch: updatedBatch, result: 'accepted' };
  }

  // 重复回执：只留首次
  const isDuplicate = existing.seq === receipt.seq && existing.contentHash === receipt.contentHash;
  const seqOutOfOrder = channel ? receipt.seq !== channel.seq : false;
  const contentMismatch = channel ? receipt.contentHash !== channel.contentHash : false;

  if (isDuplicate && !seqOutOfOrder && !contentMismatch) {
    return { batch, result: 'duplicate' };
  }

  // 序号乱到或内容不一致：保留双方，进入待核
  const reason: ReviewReason = seqOutOfOrder ? 'seq_out_of_order' : 'content_mismatch';
  const reviewItem: ReviewItem = {
    id: `RV${Date.now()}${Math.floor(Math.random() * 1000)}`,
    batchNo: receipt.batchNo,
    channelNo: receipt.channelNo,
    reason,
    firstReceipt: existing,
    secondReceipt: fullReceipt,
    status: 'pending',
    createdAt: now
  };

  const updatedBatch: ReleaseBatch = {
    ...batch,
    receipts: batch.receipts,
    reviewItems: [...batch.reviewItems, reviewItem],
    channels: batch.channels.map((c) =>
      c.channelNo === receipt.channelNo ? { ...c, status: 'review' } : c
    )
  };

  return { batch: updatedBatch, result: 'review', reviewItem };
}

// ── 补发差异 ──────────────────────────────────────────────

/** 计算已确认通道的补发差异（原快照 vs 当前重算快照） */
export function computeReissueDiff(
  channel: ProductChannel,
  originalSnapshot: FrozenSnapshot,
  currentSnapshot: FrozenSnapshot
): ReissueDiff {
  const originalTokens = new Map(originalSnapshot.tokens.map((t) => [t.id, t]));
  const changedTokens: ReissueDiff['changedTokens'] = [];

  for (const current of currentSnapshot.tokens) {
    const original = originalTokens.get(current.id);
    if (!original) {
      changedTokens.push({ id: current.id, name: current.name, before: '新增', after: current.value });
    } else if (original.value !== current.value || JSON.stringify(original.themes) !== JSON.stringify(current.themes)) {
      changedTokens.push({ id: current.id, name: current.name, before: original.value, after: current.value });
    }
  }

  const currentIds = new Set(currentSnapshot.tokens.map((t) => t.id));
  for (const original of originalSnapshot.tokens) {
    if (!currentIds.has(original.id)) {
      changedTokens.push({ id: original.id, name: original.name, before: original.value, after: '删除' });
    }
  }

  return {
    channelNo: channel.channelNo,
    product: channel.product,
    originalHash: originalSnapshot.contentHash,
    currentHash: currentSnapshot.contentHash,
    changedTokens,
    computedAt: new Date().toISOString()
  };
}

/**
 * 基础令牌修改后，未闭合批次立即失效重算。
 * - 已确认通道：保留原快照，列出补发差异
 * - 未确认通道：按新快照重置为待发送
 */
export function recalculateBatch(batch: ReleaseBatch, currentTokens: Token[], reason: string): ReleaseBatch {
  const now = new Date().toISOString();
  const newSnapshot = freezeSnapshot(currentTokens);

  const reissueDiffs = batch.channels
    .filter((c) => c.status === 'confirmed')
    .map((c) => computeReissueDiff(c, batch.originalSnapshot, newSnapshot));

  const updatedChannels = batch.channels.map((c) => {
    if (c.status === 'confirmed') return c;
    return { ...c, status: 'pending' as ChannelStatus, contentHash: '', lastError: undefined };
  });

  return {
    ...batch,
    status: 'open',
    snapshot: newSnapshot,
    channels: updatedChannels,
    reissueDiffs,
    invalidatedAt: now,
    invalidateReason: reason,
    recalculatedAt: now
  };
}
