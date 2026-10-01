export type TokenKind = 'base' | 'alias' | 'component';

export type ChannelCode = 'component-lib' | 'ops-console' | 'mobile-kit' | 'data-platform';

export type ChannelStatus = 'pending' | 'awaiting' | 'confirmed' | 'failed' | 'disputed';

export type RevisionSeq = number;

export type FaultMode = 'none' | 'write-fail' | 'duplicate-receipt' | 'out-of-order' | 'tampered';

export interface TokenSnapshotEntry {
  id: string;
  name: string;
  kind: TokenKind;
  value: string;
  ref?: string;
  themes: Record<string, string>;
}

export interface TokenPackageEntry extends TokenSnapshotEntry {
  /** 依赖解析链：别名 -> 基础令牌 */
  chain: string[];
  resolvedValue: string;
  cycle: boolean;
}

export interface RevisionInfo {
  seq: RevisionSeq;
  reason: string;
  createdAt: number;
  baseFingerprint: string;
}

export interface ReceiptRecord {
  batchNo: string;
  channel: ChannelCode;
  /** 通道单调序号，每次写入（含失败尝试）递增 */
  seq: number;
  revision: RevisionSeq;
  /** 回包内容指纹 */
  checksum: string;
  receivedAt: number;
  injected?: 'duplicate' | 'out-of-order' | 'tampered';
}

export interface AttemptRecord {
  at: number;
  seq: number;
  revision: RevisionSeq;
  checksum: string;
  result: 'written' | 'write-failed';
  error?: string;
}

export interface ChannelDispute {
  reason: 'out-of-order' | 'checksum-mismatch';
  note: string;
  at: number;
  /** 先到的一方 */
  firstKey: string;
  resolved?: { action: 'accept-first' | 'accept-conflict'; receiptKey: string; at: number };
}

export interface ChannelDelivery {
  code: ChannelCode;
  name: string;
  status: ChannelStatus;
  /** 当前修订（最近一次写入对应的批次修订） */
  revision: RevisionSeq;
  attempts: AttemptRecord[];
  /** 保留双方：首次回执与冲突回执全部留档 */
  receipts: ReceiptRecord[];
  confirmedAt?: number;
  confirmedKey?: string;
  dispute?: ChannelDispute;
}

export interface InvalidationReview {
  revision: RevisionInfo;
  /** 失效重算的未确认通道 */
  affectedChannels: ChannelCode[];
  /** 已确认、仍按原快照可查的通道 */
  confirmedChannels: ChannelCode[];
  /** 触发原因涉及的基础令牌 */
  changedBaseTokens: string[];
}

export type BatchState = 'open' | 'closed';

export interface ReleaseBatch {
  no: string;
  version: string;
  note: string;
  createdBy: string;
  createdAt: number;
  state: BatchState;
  currentRevision: RevisionSeq;
  channels: ChannelCode[];
  /** 创建批次时冻结的候选值（rev 0） */
  frozenTokens: TokenSnapshotEntry[];
  /** 每个修订的发包内容（含依赖解析） */
  tokenPackages: Record<number, TokenPackageEntry[]>;
  revisions: RevisionInfo[];
  deliveries: Record<ChannelCode, ChannelDelivery>;
  /** 基础令牌改动导致的失效重算留档 */
  invalidationReviews: InvalidationReview[];
  closedAt?: number;
}

export type MergeOutcome =
  | { kind: 'confirmed'; receipt: ReceiptRecord }
  | { kind: 'duplicate-ack'; first: ReceiptRecord }
  | { kind: 'dispute'; reason: 'out-of-order' | 'checksum-mismatch'; receipt: ReceiptRecord; kept: ReceiptRecord };

export interface TokenDiffRow {
  id: string;
  name: string;
  kind: TokenKind;
  before: string;
  after: string;
}
