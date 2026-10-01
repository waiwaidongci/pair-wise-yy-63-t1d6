import { defineStore } from 'pinia';
import {
  appendRevision,
  batchProgress,
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
} from './reconciliation/reconcile';
import { buildReceipt, setWriteFault, writeToChannel } from './reconciliation/transport';
import type {
  ChannelCode,
  FaultMode,
  ReceiptRecord,
  ReleaseBatch,
  TokenDiffRow
} from './reconciliation/types';

export type TokenCategory = 'color' | 'font' | 'spacing' | 'radius' | 'shadow' | 'component';
export type Token = {
  id: string;
  name: string;
  category: TokenCategory;
  value: string;
  ref?: string;
  themes: Record<string, string>;
  usage: number;
  status: 'stable' | 'deprecated' | 'proposed';
  description: string;
};

export type ChangeRequest = {
  id: string;
  title: string;
  requester: string;
  scope: string;
  impact: number;
  status: '待评审' | '已接受' | '已退回';
  diff: { token: string; before: string; after: string };
};

const initialTokens: Token[] = [
  { id: 'color.base.blue.600', name: '品牌主色 600', category: 'color', value: '#2864dc', themes: { light: '#2864dc', dark: '#6f96ff', ops: '#24786a', contrast: '#0b4dba' }, usage: 184, status: 'stable', description: '主操作、链接和重点状态' },
  { id: 'color.semantic.primary', name: '语义主色', category: 'color', value: '{color.base.blue.600}', ref: 'color.base.blue.600', themes: { light: '{color.base.blue.600}', dark: '{color.base.blue.400}', ops: '{color.base.green.600}', contrast: '{color.base.blue.800}' }, usage: 126, status: 'stable', description: '组件库统一主色别名' },
  { id: 'color.base.blue.400', name: '品牌蓝 400', category: 'color', value: '#6f96ff', themes: { light: '#6f96ff', dark: '#6f96ff', ops: '#58a99a', contrast: '#2878e8' }, usage: 42, status: 'stable', description: '暗色主题主色' },
  { id: 'color.base.blue.800', name: '品牌蓝 800', category: 'color', value: '#0b4dba', themes: { light: '#0b4dba', dark: '#9ab9ff', ops: '#145c51', contrast: '#06358a' }, usage: 31, status: 'stable', description: '高对比主题主色' },
  { id: 'color.base.green.600', name: '运营绿 600', category: 'color', value: '#24786a', themes: { light: '#24786a', dark: '#54b2a0', ops: '#24786a', contrast: '#0d5a4d' }, usage: 67, status: 'proposed', description: '运营产品品牌替换色' },
  { id: 'color.text.primary', name: '正文主色', category: 'color', value: '#17202b', themes: { light: '#17202b', dark: '#f5f7fa', ops: '#152a25', contrast: '#000000' }, usage: 293, status: 'stable', description: '主要正文和标题' },
  { id: 'color.text.secondary', name: '正文次色', category: 'color', value: '#667582', themes: { light: '#667582', dark: '#a8b2bd', ops: '#62766f', contrast: '#303b46' }, usage: 211, status: 'stable', description: '辅助信息和说明' },
  { id: 'color.surface.canvas', name: '页面背景', category: 'color', value: '#f2f5f7', themes: { light: '#f2f5f7', dark: '#121821', ops: '#f1f6f4', contrast: '#ffffff' }, usage: 54, status: 'stable', description: '应用一级背景' },
  { id: 'font.family.sans', name: '无衬线字体', category: 'font', value: '"Noto Sans SC", sans-serif', themes: { light: '"Noto Sans SC", sans-serif', dark: '"Noto Sans SC", sans-serif', ops: '"Noto Sans SC", sans-serif', contrast: 'system-ui, sans-serif' }, usage: 388, status: 'stable', description: '产品界面默认真体' },
  { id: 'font.size.body', name: '正文字号', category: 'font', value: '14px', themes: { light: '14px', dark: '14px', ops: '14px', contrast: '16px' }, usage: 255, status: 'stable', description: '正文与表单文本' },
  { id: 'spacing.base.2', name: '基础间距 2', category: 'spacing', value: '8px', themes: { light: '8px', dark: '8px', ops: '8px', contrast: '8px' }, usage: 312, status: 'stable', description: '紧凑布局基础间距' },
  { id: 'radius.control', name: '控件圆角', category: 'radius', value: '6px', themes: { light: '6px', dark: '6px', ops: '4px', contrast: '4px' }, usage: 167, status: 'stable', description: '按钮、输入框和卡片' },
  { id: 'shadow.raised', name: '浮层阴影', category: 'shadow', value: '0 8px 28px rgba(22,35,48,.14)', themes: { light: '0 8px 28px rgba(22,35,48,.14)', dark: '0 8px 28px rgba(0,0,0,.42)', ops: '0 8px 28px rgba(21,54,45,.14)', contrast: '0 0 0 2px #303b46' }, usage: 36, status: 'stable', description: '菜单、弹窗和浮层' },
  { id: 'component.button.primary.bg', name: '主按钮背景', category: 'component', value: '{color.semantic.primary}', ref: 'color.semantic.primary', themes: { light: '{color.semantic.primary}', dark: '{color.semantic.primary}', ops: '{color.semantic.primary}', contrast: '{color.semantic.primary}' }, usage: 98, status: 'stable', description: '主要操作按钮' },
  { id: 'component.button.primary.text', name: '主按钮文字', category: 'component', value: '#ffffff', themes: { light: '#ffffff', dark: '#ffffff', ops: '#ffffff', contrast: '#ffffff' }, usage: 98, status: 'stable', description: '主要操作按钮文字' }
];

const changes: ChangeRequest[] = [
  { id: 'CR-412', title: '运营产品切换语义主色', requester: '运营设计组', scope: '4 个产品 · 238 处引用', impact: 86, status: '待评审', diff: { token: 'color.semantic.primary', before: '{color.base.blue.600}', after: '{color.base.green.600}' } },
  { id: 'CR-418', title: '高对比度正文尺寸调整', requester: '无障碍专项组', scope: '2 个产品 · 74 处引用', impact: 42, status: '待评审', diff: { token: 'font.size.body', before: '14px', after: '16px' } },
  { id: 'CR-423', title: '统一浮层圆角', requester: '组件维护组', scope: '12 个组件 · 36 处引用', impact: 28, status: '待评审', diff: { token: 'radius.control', before: '8px', after: '6px' } }
];

const storageKey = 'yy63-token-governance';
const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null;
const saved = raw ? JSON.parse(raw) : null;

export type LedgerEvent = {
  at: number;
  batchNo: string;
  channel: ChannelCode;
  level: 'info' | 'success' | 'warning' | 'danger';
  text: string;
};

/** 等待回执的定时器，只存在于会话内，刷新后可在控制台手动补收回执 */
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
function timerKey(batchNo: string, channel: ChannelCode, seq: number) {
  return `${batchNo}:${channel}:${seq}`;
}
function clearPendingTimers(batchNo?: string) {
  pendingTimers.forEach((timer, key) => {
    if (!batchNo || key.startsWith(`${batchNo}:`)) {
      clearTimeout(timer);
      pendingTimers.delete(key);
    }
  });
}

export const useTokenStore = defineStore('tokens', {
  state: () => ({
    tokens: (saved?.tokens as Token[]) ?? initialTokens,
    changes: (saved?.changes as ChangeRequest[]) ?? changes,
    activeTheme: (saved?.activeTheme as string) ?? 'light',
    selectedTokenId: (saved?.selectedTokenId as string) ?? 'color.semantic.primary',
    search: (saved?.search as string) ?? '',
    category: (saved?.category as string) ?? '全部',
    releaseVersion: '4.6.0-rc.2',
    locked: (saved?.locked as boolean) ?? false,
    lastPublished: (saved?.lastPublished as string) ?? 'DS 4.5.2',
    baseline: initialTokens.map((token) => ({ id: token.id, value: token.value })),
    /* ---- 可恢复对账流程：批次、通道序号、事件流水 ---- */
    batches: (saved?.batches as ReleaseBatch[]) ?? [],
    batchSeq: (saved?.batchSeq as number) ?? 0,
    channelSeq: (saved?.channelSeq as Record<string, number>) ?? {},
    ledger: [] as LedgerEvent[],
    /* ---- 故障注入与会话开关（不落盘） ---- */
    writeFault: false,
    autoAck: true,
    channelFault: {} as Partial<Record<ChannelCode, FaultMode>>,
    inflightChannels: [] as string[]
  }),
  getters: {
    selectedToken(state): Token | undefined {
      return state.tokens.find((token) => token.id === state.selectedTokenId);
    },
    filteredTokens(state): Token[] {
      const query = state.search.toLowerCase();
      return state.tokens.filter((token) => {
        const matchesSearch = !query || token.id.toLowerCase().includes(query) || token.name.includes(state.search);
        const matchesCategory = state.category === '全部' || token.category === state.category;
        return matchesSearch && matchesCategory;
      });
    },
    dependencyEdges(state) {
      return state.tokens.filter((token) => token.ref).map((token) => ({ from: token.ref!, to: token.id }));
    },
    cycleNodes(state): string[] {
      const graph = new Map<string, string>();
      state.tokens.filter((token) => token.ref).forEach((token) => graph.set(token.id, token.ref!));
      const cycle = new Set<string>();
      graph.forEach((_, start) => {
        const path: string[] = [];
        let current: string | undefined = start;
        while (current && !path.includes(current)) {
          path.push(current);
          current = graph.get(current);
        }
        if (current && path.includes(current)) path.slice(path.indexOf(current)).forEach((id) => cycle.add(id));
      });
      return [...cycle];
    },
    invalidReferences(state) {
      const ids = new Set(state.tokens.map((token) => token.id));
      return state.tokens.filter((token) => token.ref && !ids.has(token.ref));
    },
    contrastIssues(state) {
      const text = state.tokens.find((token) => token.id === 'color.text.primary');
      const surface = state.tokens.find((token) => token.id === 'color.surface.canvas');
      const values = [text?.themes[state.activeTheme], surface?.themes[state.activeTheme]].filter(Boolean) as string[];
      if (values.length < 2) return [];
      const ratio = contrastRatio(values[0], values[1]);
      return ratio < 4.5 ? [{ title: '正文与页面背景对比度不足', detail: `当前 ${ratio.toFixed(2)}:1，要求至少 4.5:1。` }] : [];
    },
    diffRows(state) {
      return state.tokens.filter((token) => {
        const base = state.baseline.find((item) => item.id === token.id);
        return !base || base.value !== token.value;
      }).map((token) => {
        const base = state.baseline.find((item) => item.id === token.id);
        return { id: token.id, before: base?.value ?? '新增', after: token.value, name: token.name };
      });
    },
    releaseReadiness(state): number {
      const base = 100 - this.cycleNodes.length * 25 - this.invalidReferences.length * 20 - this.contrastIssues.length * 15;
      return Math.max(0, base);
    },
    /* ------------------------------- 对账视图 ------------------------------- */
    openBatch(state): ReleaseBatch | undefined {
      return state.batches.find((batch) => batch.state === 'open');
    },
    closedBatches(state): ReleaseBatch[] {
      return state.batches.filter((batch) => batch.state === 'closed').sort((a, b) => b.closedAt! - a.closedAt!);
    },
    batchById(state) {
      return (no: string) => state.batches.find((batch) => batch.no === no);
    },
    batchProgressOf() {
      return (batch: ReleaseBatch) => batchProgress(batch);
    },
    /** 待核通道（跨批次汇总，供侧边清单使用） */
    disputedDeliveries(state) {
      return state.batches.flatMap((batch) =>
        batch.channels
          .map((code) => batch.deliveries[code])
          .filter((delivery) => delivery.status === 'disputed')
          .map((delivery) => ({ batch, delivery }))
      );
    }
  },
  actions: {
    selectToken(id: string) {
      this.selectedTokenId = id;
      this.persist();
    },
    updateTokenValue(id: string, value: string) {
      const token = this.tokens.find((item) => item.id === id);
      if (!token) return;
      const wasBase = isBaseToken(token);
      const beforeValue = token.value;
      const beforeRef = token.ref;
      token.value = value;
      token.themes[this.activeTheme] = value;
      if (value.startsWith('{') && value.endsWith('}')) token.ref = value.slice(1, -1);
      else delete token.ref;
      // 基础令牌值改动（或依赖关系变动）后，未闭合批次立即失效重算
      const baseChanged = (wasBase || !token.ref || beforeRef !== token.ref) && (beforeValue !== value || beforeRef !== token.ref);
      if (baseChanged) this.invalidateOpenBatches(`基础令牌 ${token.name}（${id}）已修改：${beforeValue} → ${value}`, [id]);
      this.persist();
    },
    addToken(token: Token) {
      if (!this.tokens.some((item) => item.id === token.id)) this.tokens.push(token);
      this.persist();
    },
    setTheme(theme: string) {
      this.activeTheme = theme;
      this.persist();
    },
    setSearch(value: string) { this.search = value; this.persist(); },
    setCategory(value: string) { this.category = value; this.persist(); },
    acceptChange(id: string) {
      const change = this.changes.find((item) => item.id === id);
      if (!change) return;
      const token = this.tokens.find((item) => item.id === change.diff.token);
      if (token) this.updateTokenValue(token.id, change.diff.after);
      change.status = '已接受';
      this.persist();
    },
    rejectChange(id: string) {
      const change = this.changes.find((item) => item.id === id);
      if (change) change.status = '已退回';
      this.persist();
    },
    rollback() {
      const changed: string[] = [];
      this.baseline.forEach((base) => {
        const token = this.tokens.find((item) => item.id === base.id);
        if (token && token.value !== base.value) {
          changed.push(token.id);
          token.value = base.value;
        }
      });
      if (changed.length) this.invalidateOpenBatches(`回滚到已发布基线，涉及 ${changed.length} 个令牌`, changed);
      this.persist();
    },
    /* ============================ 可恢复发布对账 ============================ */

    logEvent(event: Omit<LedgerEvent, 'at'>) {
      this.ledger.unshift({ ...event, at: Date.now() });
      if (this.ledger.length > 80) this.ledger.length = 80;
    },

    /** 创建批次：冻结候选值与依赖快照。批次立即落盘，写入中断也不丢。 */
    createReleaseBatch(input: { version: string; channels: ChannelCode[]; note: string }) {
      if (this.openBatch) return undefined;
      if (!input.channels.length) return undefined;
      this.batchSeq += 1;
      const no = nextBatchNo(this.batchSeq);
      const batch = createBatch({
        no,
        version: input.version,
        note: input.note,
        createdBy: '顾清 · Core DS',
        channels: input.channels,
        tokens: this.tokens
      });
      this.batches.push(batch);
      this.locked = false;
      this.logEvent({ batchNo: no, channel: input.channels[0], level: 'info', text: `批次 ${no} 创建：冻结候选值与依赖快照（rev 0），目标 ${input.channels.length} 个产品通道` });
      this.persist();
      return batch;
    },

    invalidateOpenBatches(reason: string, changedBaseTokens: string[]) {
      const open = this.batches.filter((batch) => batch.state === 'open');
      open.forEach((batch) => {
        clearPendingTimers(batch.no);
        const review = appendRevision({ batch, tokens: this.tokens, reason, changedBaseTokens });
        const diffs = review.confirmedChannels
          .map((code) => ({ code, count: reissueDiff(batch, code).length }))
          .filter((item) => item.count > 0);
        this.logEvent({
          batchNo: batch.no,
          channel: review.affectedChannels[0] ?? review.confirmedChannels[0] ?? batch.channels[0],
          level: 'warning',
          text: `基础令牌改动，批次 ${batch.no} 未闭合部分失效，已按 rev ${review.revision.seq} 重算；${review.affectedChannels.length} 个未完成通道待重发，${review.confirmedChannels.length} 个已确认通道仍按原快照可查${diffs.length ? `，补发差异 ${diffs.map((d) => `${batch.deliveries[d.code].name} ${d.count} 项`).join('、')}` : ''}`
        });
      });
      this.persist();
    },

    reissueDiffFor(batchNo: string, code: ChannelCode): TokenDiffRow[] {
      const batch = this.batchById(batchNo);
      return batch ? reissueDiff(batch, code) : [];
    },

    /** 对单个通道写入。序号在写入前预占，失败也保留尝试记录。 */
    async sendToChannel(batchNo: string, code: ChannelCode) {
      const batch = this.batches.find((item) => item.no === batchNo);
      if (!batch || batch.state !== 'open') return;
      const delivery = batch.deliveries[code];
      if (!delivery || delivery.status === 'confirmed' || delivery.status === 'disputed') return;
      const inflightKey = `${batchNo}:${code}`;
      if (this.inflightChannels.includes(inflightKey)) return;
      this.inflightChannels.push(inflightKey);

      const seq = nextChannelSeq(this.channelSeq, code);
      const revision = batch.currentRevision;
      const pkg = batch.tokenPackages[revision];
      const checksum = packageChecksum(pkg);
      const request = { batchNo, channel: code, seq, revision, pkg, checksum };

      try {
        const response = await writeToChannel(request);
        if (!response.ok) {
          registerWrite(delivery, seq, revision, checksum, 'write-failed', response.error);
          this.logEvent({ batchNo, channel: code, level: 'danger', text: `写入 ${delivery.name} 失败（序号 ${seq}）：${response.error}。批次已保留，可立即重试该通道。` });
          this.persist();
          return;
        }
        registerWrite(delivery, seq, revision, checksum, 'written');
        this.logEvent({ batchNo, channel: code, level: 'info', text: `${delivery.name} 写入成功（序号 ${seq} / rev ${revision}），等待产品侧回执` });
        this.persist();
        this.scheduleReceipts(batch, code, { batchNo, channel: code, seq, revision, checksum });
      } finally {
        this.inflightChannels = this.inflightChannels.filter((key) => key !== inflightKey);
      }
    },

    /** 按通道故障模式安排回执：正常自动 ACK、重复回执、乱序、篡改 */
    scheduleReceipts(batch: ReleaseBatch, code: ChannelCode, request: { batchNo: string; channel: ChannelCode; seq: number; revision: number; checksum: string }) {
      const mode = this.channelFault[code] ?? 'none';
      const known = batch.deliveries[code].attempts.filter((a) => a.result === 'written').map((a) => a.seq);
      const push = (receipt: ReceiptRecord, delay: number) => {
        const key = timerKey(receipt.batchNo, receipt.channel, receipt.seq) + `:${delay}:${Math.random().toString(36).slice(2, 7)}`;
        pendingTimers.set(key, setTimeout(() => {
          pendingTimers.delete(key);
          this.deliverReceipt(receipt);
        }, delay));
      };
      if (!this.autoAck) {
        this.logEvent({ batchNo: batch.no, channel: code, level: 'info', text: `${batch.deliveries[code].name} 自动回执已关闭，等待控制台手动补收（序号 ${request.seq}）` });
        return;
      }
      if (mode === 'duplicate-receipt') {
        push(buildReceipt(request, 'none', known), 600);
        push(buildReceipt(request, 'duplicate-receipt', known), 1500);
        return;
      }
      if (mode !== 'none') {
        push(buildReceipt(request, mode, known), 800);
        return;
      }
      push(buildReceipt(request, 'none', known), 650 + Math.round(Math.random() * 500));
    },

    /** 接收并合并一份产品侧回执（按批次号 + 通道号对账） */
    deliverReceipt(receipt: ReceiptRecord) {
      const batch = this.batches.find((item) => item.no === receipt.batchNo);
      if (!batch) return;
      const outcome = mergeReceipt(batch, receipt);
      const delivery = batch.deliveries[receipt.channel];
      if (outcome.kind === 'confirmed') {
        this.logEvent({ batchNo: receipt.batchNo, channel: receipt.channel, level: 'success', text: `${delivery.name} 回执确认（序号 ${receipt.seq} / rev ${receipt.revision}，指纹 ${receipt.checksum.slice(0, 8)}）` });
      } else if (outcome.kind === 'duplicate-ack') {
        this.logEvent({ batchNo: receipt.batchNo, channel: receipt.channel, level: 'info', text: `${delivery.name} 重复回执（序号 ${receipt.seq}，与首次指纹一致），只保留首次回执，不重复入账` });
      } else if (outcome.reason === 'out-of-order') {
        this.logEvent({ batchNo: receipt.batchNo, channel: receipt.channel, level: 'warning', text: `${delivery.name} 回执序号乱到（序号 ${receipt.seq}）：${delivery.dispute?.note ?? ''}。双方均保留，进入待核` });
      } else {
        this.logEvent({ batchNo: receipt.batchNo, channel: receipt.channel, level: 'danger', text: `${delivery.name} 回执内容不一致（序号 ${receipt.seq}）：${delivery.dispute?.note ?? ''}。双方均保留，进入待核` });
      }
      this.persist();
    },

    /** 手动补收：针对通道最近一次成功写入构造回执（自动回执关闭或刷新页面后恢复用） */
    ackManually(batchNo: string, code: ChannelCode, overrideMode?: FaultMode) {
      const batch = this.batchById(batchNo);
      if (!batch) return;
      const delivery = batch.deliveries[code];
      const last = [...delivery.attempts].reverse().find((a) => a.result === 'written');
      if (!last) return;
      const known = delivery.attempts.filter((a) => a.result === 'written').map((a) => a.seq);
      const mode = overrideMode ?? this.channelFault[code] ?? 'none';
      const receipt = buildReceipt({ batchNo, channel: code, seq: last.seq, revision: last.revision, checksum: last.checksum }, mode, known);
      this.deliverReceipt(receipt);
    },

    /** 写入失败后立即重试：只重试未完成通道，已确认通道不再生成任何发包 */
    retryUnfinished(batchNo: string) {
      const batch = this.batchById(batchNo);
      if (!batch || batch.state !== 'open') return;
      batch.channels.forEach((code) => {
        const status = batch.deliveries[code].status;
        if (status === 'pending' || status === 'failed' || status === 'awaiting') {
          void this.sendToChannel(batchNo, code);
        }
      });
    },

    settleDispute(batchNo: string, code: ChannelCode, action: 'accept-first' | 'accept-conflict') {
      const batch = this.batchById(batchNo);
      if (!batch) return;
      const delivery = batch.deliveries[code];
      resolveDispute(batch, code, action);
      if (delivery.status === 'confirmed') {
        this.logEvent({ batchNo, channel: code, level: 'success', text: `${delivery.name} 待核已处理（${action === 'accept-first' ? '采纳先到回执' : '采纳后到回执'}），通道确认闭合` });
      } else {
        this.logEvent({ batchNo, channel: code, level: 'warning', text: `${delivery.name} 待核已处理（${action === 'accept-first' ? '采纳先到回执' : '采纳后到回执'}），采纳内容无对应发包，通道回到待发等待补发` });
      }
      this.persist();
    },

    closeOpenBatch(batchNo: string) {
      const batch = this.batchById(batchNo);
      if (!batch) return false;
      if (closeBatch(batch)) {
        this.locked = true;
        this.lastPublished = `DS ${batch.version}`;
        clearPendingTimers(batchNo);
        this.logEvent({ batchNo, channel: batch.channels[0], level: 'success', text: `批次 ${batchNo} 全部通道已确认，对账闭合，发布锁定 DS ${batch.version}` });
        this.persist();
        return true;
      }
      return false;
    },

    setWriteFaultMode(on: boolean) {
      this.writeFault = on;
      setWriteFault(on);
    },
    setAutoAck(on: boolean) {
      this.autoAck = on;
    },
    setChannelFault(code: ChannelCode, mode: FaultMode) {
      if (mode === 'none') delete this.channelFault[code];
      else this.channelFault[code] = mode;
    },

    persist() {
      if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey, JSON.stringify({
        tokens: this.tokens,
        changes: this.changes,
        activeTheme: this.activeTheme,
        selectedTokenId: this.selectedTokenId,
        search: this.search,
        category: this.category,
        locked: this.locked,
        lastPublished: this.lastPublished,
        batches: this.batches,
        batchSeq: this.batchSeq,
        channelSeq: this.channelSeq
      }));
    }
  }
});

function contrastRatio(a: string, b: string) {
  const luminance = (hex: string) => {
    const clean = hex.replace('#', '');
    if (clean.length !== 6) return .5;
    const channels = [0, 2, 4].map((index) => parseInt(clean.slice(index, index + 2), 16) / 255).map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  };
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
}
