import type { FaultMode, ReceiptRecord, TokenPackageEntry } from './types';

/**
 * 模拟产品通道写入网关。真实环境对应各产品侧的推送/回执接口；
 * 这里用 Promise + 随机抖动模拟网络，writeFault 开启时写入直接失败，
 * 批次与已成功写入不受影响，调用方保留批次后可立即重试未完成通道。
 */
export interface WriteRequest {
  batchNo: string;
  channel: ReceiptRecord['channel'];
  seq: number;
  revision: number;
  pkg: TokenPackageEntry[];
  checksum: string;
}

export interface WriteOk {
  ok: true;
  checksum: string;
  writtenAt: number;
}

export interface WriteError {
  ok: false;
  error: string;
}

export type WriteResponse = WriteOk | WriteError;

let writeFault = false;

export function setWriteFault(on: boolean) {
  writeFault = on;
}

export function writeToChannel(request: WriteRequest): Promise<WriteResponse> {
  const latency = 220 + Math.round(Math.random() * 260);
  return new Promise((resolve) => {
    setTimeout(() => {
      if (writeFault || Math.random() < 0.04) {
        resolve({ ok: false, error: writeFault ? '通道写入失败（故障注入：连接被产品侧重置）' : '网络抖动：写入超时，未收到 ACK' });
        return;
      }
      resolve({ ok: true, checksum: request.checksum, writtenAt: Date.now() });
    }, latency);
  });
}

/** 模拟产品侧回执。autoAck 时为正常回执；故障模式下构造重复/乱序/篡改回执 */
export function buildReceipt(
  request: { batchNo: string; channel: ReceiptRecord['channel']; seq: number; revision: number; checksum: string },
  mode: FaultMode,
  knownSeqs: number[],
  now = Date.now()
): ReceiptRecord {
  const base: ReceiptRecord = {
    batchNo: request.batchNo,
    channel: request.channel,
    seq: request.seq,
    revision: request.revision,
    checksum: request.checksum,
    receivedAt: now
  };
  switch (mode) {
    case 'duplicate-receipt':
      // 产品侧重发：批次号、通道号、序号、内容指纹全部相同
      return { ...base, receivedAt: now, injected: 'duplicate' };
    case 'out-of-order': {
      // 旧序号晚到：拿一个更早的序号重放（序号乱到）
      const stale = knownSeqs.filter((s) => s < request.seq).pop();
      return { ...base, seq: stale ?? Math.max(1, request.seq - 1), receivedAt: now, injected: 'out-of-order' };
    }
    case 'tampered': {
      // 产品侧实际落的是旧别名/旧值：指纹对不上（内容不一致）
      const flipped = base.checksum.slice(0, 12).split('').map((ch) => (ch === '0' ? '1' : '0')).join('');
      return { ...base, checksum: `${flipped}${base.checksum.slice(12)}`, receivedAt: now, injected: 'tampered' };
    }
    default:
      return base;
  }
}
