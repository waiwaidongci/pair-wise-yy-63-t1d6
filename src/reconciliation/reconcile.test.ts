/* 端到端校验：可恢复发布对账流程的全部关键规则（node --experimental-vm 无关，纯 TS 直跑） */
import {
  appendRevision,
  buildPackage,
  CHANNEL_DIRECTORY,
  closeBatch,
  createBatch,
  isBaseToken,
  mergeReceipt,
  nextBatchNo,
  nextChannelSeq,
  packageChecksum,
  registerWrite,
  reissueDiff,
  resolveDispute
} from './reconcile';
import { buildReceipt } from './transport';
import type { ChannelCode, ReceiptRecord, ReleaseBatch, TokenPackageEntry } from './types';
import type { Token } from '../store';

declare const process: { exit(code: number): never };

let passed = 0;
function assert(cond: unknown, message: string) {
  if (!cond) { console.error(`✗ ${message}`); process.exit(1); }
  passed += 1;
  console.log(`✓ ${message}`);
}

const tokens: Token[] = [
  { id: 'color.base.blue.600', name: '品牌主色 600', category: 'color', value: '#2864dc', themes: { light: '#2864dc' }, usage: 1, status: 'stable', description: '' },
  { id: 'color.semantic.primary', name: '语义主色', category: 'color', value: '{color.base.blue.600}', ref: 'color.base.blue.600', themes: { light: '{color.base.blue.600}' }, usage: 1, status: 'stable', description: '' },
  { id: 'component.button.primary.bg', name: '主按钮背景', category: 'component', value: '{color.semantic.primary}', ref: 'color.semantic.primary', themes: { light: '{color.semantic.primary}' }, usage: 1, status: 'stable', description: '' }
];

assert(isBaseToken(tokens[0]) && !isBaseToken(tokens[1]), '基础令牌识别：无 ref 为基础，别名为非基础');

const no = nextBatchNo(1, new Date('2026-10-01T10:00:00').getTime());
assert(no === 'PB-20261001-001', `批次号格式正确：${no}`);

const channels: ChannelCode[] = ['component-lib', 'ops-console'];
const batch = createBatch({ no, version: '4.6.0-rc.2', note: 't', createdBy: 'tester', channels, tokens });
assert(batch.frozenTokens.length === 3, '创建批次冻结候选值快照');
assert(batch.tokenPackages[0].find((t) => t.id === 'component.button.primary.bg')?.resolvedValue === '#2864dc', '依赖快照递归解析：组件别名 → 语义别名 → 基础值');

const seqReg: Record<string, number> = {};
const code: ChannelCode = 'component-lib';
const pkg0: TokenPackageEntry[] = batch.tokenPackages[0];
const deliveries = batch.deliveries as Record<string, ReleaseBatch['deliveries'][ChannelCode]>;
const get = (c: ChannelCode) => deliveries[c];
const sum0 = packageChecksum(pkg0);

// 写入成功 + 正常回执确认
const s1 = nextChannelSeq(seqReg, code);
registerWrite(deliveries[code], s1, 0, sum0, 'written');
const ack1: ReceiptRecord = { batchNo: no, channel: code, seq: s1, revision: 0, checksum: sum0, receivedAt: Date.now() };
const r1 = mergeReceipt(batch, ack1);
assert(r1.kind === 'confirmed' && deliveries[code].status === 'confirmed', '正常回执确认通道');

// 同通道重复回执：完全一致，只留首次
const dup = { ...ack1, receivedAt: Date.now() + 1000 };
const r2 = mergeReceipt(batch, dup);
assert(r2.kind === 'duplicate-ack', '同通道重复回执识别为重复，不入账');
assert(deliveries[code].receipts.length === 1, '重复回执只留首次一份');

// 乱序回执：旧序号晚到（s2a 的回执直到 s2b 确认后才到达），双方保留进入待核
const c2: ChannelCode = 'ops-console';
const s2a = nextChannelSeq(seqReg, c2);
registerWrite(deliveries[c2], s2a, 0, sum0, 'written');
// 通道重发：s2b 写入并先收到回执
const s2b = nextChannelSeq(seqReg, c2);
registerWrite(deliveries[c2], s2b, 0, sum0, 'written');
const ack2: ReceiptRecord = { batchNo: no, channel: c2, seq: s2b, revision: 0, checksum: sum0, receivedAt: Date.now() };
mergeReceipt(batch, ack2);
// s2a 的回执此时才晚到（乱序）
const stale: ReceiptRecord = { batchNo: no, channel: c2, seq: s2a, revision: 0, checksum: sum0, receivedAt: Date.now() };
const r3 = mergeReceipt(batch, stale);
assert(r3.kind === 'dispute' && r3.reason === 'out-of-order', '序号乱到回执进入待核');
assert(deliveries[c2].receipts.length === 2, '乱序时双方回执都保留（先到 s2b + 晚到 s2a）');
assert(deliveries[c2].status === 'disputed', '乱序通道标记为待核');
resolveDispute(batch, c2, 'accept-first');
assert(deliveries[c2].status === 'confirmed' && deliveries[c2].confirmedKey?.startsWith(`${c2}#${s2b}`), '采纳先到（s2b）后通道闭合');

// 内容不一致（篡改/旧别名）：双方保留进入待核
const c3: ChannelCode = 'mobile-kit';
batch.channels.push(c3);
deliveries[c3] = { code: c3, name: '移动端组件', status: 'pending', revision: 0, attempts: [], receipts: [] };
const s3 = nextChannelSeq(seqReg, c3);
registerWrite(deliveries[c3], s3, 0, sum0, 'written');
const tampered = buildReceipt({ batchNo: no, channel: c3, seq: s3, revision: 0, checksum: sum0 }, 'tampered', [s3]);
const r4 = mergeReceipt(batch, tampered);
assert(r4.kind === 'dispute' && r4.reason === 'checksum-mismatch', '内容不一致回执进入待核');
assert(deliveries[c3].receipts[0] && deliveries[c3].receipts.length === 1, '内容不一致时保留先到的一份作为首留');

// 写入失败：保留批次与尝试，可重试；失败尝试也占序号
const c4: ChannelCode = 'data-platform';
batch.channels.push(c4);
deliveries[c4] = { code: c4, name: '数据平台', status: 'pending', revision: 0, attempts: [], receipts: [] };
const s4a = nextChannelSeq(seqReg, c4);
registerWrite(deliveries[c4], s4a, 0, sum0, 'write-failed', '连接重置');
assert(deliveries[c4].status === 'failed' && batch.state === 'open', '写入失败后通道失败、批次保留');
assert(deliveries[c4].attempts.length === 1, '失败尝试记录保留');
const s4b = nextChannelSeq(seqReg, c4);
registerWrite(deliveries[c4], s4b, 0, sum0, 'written');
assert(s4b === s4a + 1, '通道序号单调递增，失败尝试也占序号');
const ack4: ReceiptRecord = { batchNo: no, channel: c4, seq: s4b, revision: 0, checksum: sum0, receivedAt: Date.now() };
mergeReceipt(batch, ack4);
assert(deliveries[c4].status === 'confirmed', '失败后重试可确认');

// 基础令牌改动：未闭合批次失效重算；已确认通道按原快照可查，未完成通道回到待发
// 重置一个未完成通道
batch.channels.push('component-lib'); // 已确认
const changedTokens = tokens.map((t) => ({ ...t, themes: { ...t.themes } }));
changedTokens[0] = { ...changedTokens[0], value: '#1f57c8', themes: { light: '#1f57c8' } };
const review = appendRevision({ batch, tokens: changedTokens, reason: '基础令牌品牌主色调整', changedBaseTokens: ['color.base.blue.600'] });
assert(batch.currentRevision === 1, '基础令牌改动后批次产生新修订 rev 1');
assert(review.affectedChannels.includes(c3), '未确认通道（待核）失效重算，回到待发');
assert(review.confirmedChannels.includes(code), '已确认通道不重发，保留原快照');
assert(deliveries[code].status === 'confirmed' && deliveries[code].revision === 0, '已确认通道仍按 rev 0 快照可查');
assert(deliveries[c3].status === 'pending' && deliveries[c3].revision === 1, '待核通道按 rev 1 回到待发');

const newPkg = buildPackage(batch.tokenPackages[1]);
const diffs = reissueDiff(batch, code);
assert(diffs.some((d) => d.id === 'color.base.blue.600' && d.before === '#2864dc' && d.after === '#1f57c8'), '补发差异列出已确认通道 rev0 → rev1 的变化');
assert(diffs.some((d) => d.id === 'component.button.primary.bg'), '补发差异包含经别名解析后受影响的组件别名');

// 重试不生成已确认通道：模拟 retryUnfinished 的选择逻辑
const unfinished = batch.channels.filter((c) => ['pending', 'failed', 'awaiting'].includes(deliveries[c].status));
assert(!unfinished.includes(code), '已确认通道不在重试集合内');
assert(unfinished.includes(c3), '未完成通道在重试集合内');

// 闭合：全部确认才闭合
assert(closeBatch(batch) === false, '存在未确认通道时批次不可闭合');
// 把剩余 pending 通道全部确认
Object.values(batch.deliveries).forEach((d) => {
  if (d.status !== 'confirmed') {
    const seq = nextChannelSeq(seqReg, d.code);
    const sum = packageChecksum(batch.tokenPackages[d.revision] ?? newPkg);
    registerWrite(d, seq, d.revision, sum, 'written');
    mergeReceipt(batch, { batchNo: no, channel: d.code, seq, revision: d.revision, checksum: sum, receivedAt: Date.now() });
  }
});
assert(closeBatch(batch) === true && batch.state === 'closed', '全部通道确认后批次可闭合');

console.log(`\n全部 ${passed} 项断言通过`);
