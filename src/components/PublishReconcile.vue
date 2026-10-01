<script setup lang="ts">
import { computed, ref } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { HistoryIcon } from 'tdesign-icons-vue-next';
import { useTokenStore } from '../store';
import { CHANNEL_DIRECTORY } from '../reconciliation/reconcile';
import type { ChannelCode, FaultMode, ReleaseBatch, RevisionSeq, TokenPackageEntry } from '../reconciliation/types';

const store = useTokenStore();

const version = ref(store.releaseVersion);
const selectedChannels = ref<ChannelCode[]>(['component-lib', 'ops-console', 'mobile-kit']);
const note = ref('更新语义主色、统一控件圆角，并修复暗色主题正文对比度。');

const faultOptions = [
  { label: '正常', value: 'none' },
  { label: '重复回执', value: 'duplicate-receipt' },
  { label: '回执乱序', value: 'out-of-order' },
  { label: '内容不一致（旧别名）', value: 'tampered' }
] as { label: string; value: FaultMode }[];

const channelOptions = CHANNEL_DIRECTORY.map((item) => ({ label: `${item.name}（${item.product}）`, value: item.code }));

const openBatch = computed(() => store.openBatch);
const progress = computed(() => (openBatch.value ? store.batchProgressOf(openBatch.value) : null));
const disputed = computed(() => store.disputedDeliveries);

/* ------------------------------- 快照查看 ------------------------------- */

const snapshotDialog = ref(false);
const snapshotChannel = ref<ChannelCode | null>(null);
const snapshotRevision = ref<RevisionSeq>(0);

const snapshotBatch = computed(() => openBatch.value);
const snapshotPkg = computed<TokenPackageEntry[]>(() => {
  const batch = snapshotBatch.value;
  if (!batch) return [];
  return batch.tokenPackages[snapshotRevision.value] ?? [];
});
const snapshotViewRevision = computed<RevisionSeq | 'latest'>(() => {
  const batch = snapshotBatch.value;
  if (!batch) return 0;
  return snapshotChannel.value
    ? batch.deliveries[snapshotChannel.value].revision
    : batch.currentRevision;
});
const snapshotBaseChanged = computed(() => {
  const batch = snapshotBatch.value;
  if (!batch) return [];
  const rev0 = batch.tokenPackages[0] ?? [];
  const view = snapshotPkg.value;
  const oldById = new Map(rev0.map((t) => [t.id, t]));
  return view.filter((t) => {
    const old = oldById.get(t.id);
    return old && (old.resolvedValue !== t.resolvedValue || old.value !== t.value);
  });
});

const confirmedSnapshotChannels = computed<ChannelCode[]>(() => {
  const batch = openBatch.value;
  return batch ? batch.channels.filter((code) => batch.deliveries[code].status === 'confirmed') : [];
});

function channelName(code: ChannelCode) {
  return CHANNEL_DIRECTORY.find((item) => item.code === code)?.name ?? code;
}

const reissueTarget = ref<{ batch: ReleaseBatch; code: ChannelCode } | null>(null);
const reissueVisible = computed({
  get: () => !!reissueTarget.value,
  set: (value: boolean) => { if (!value) reissueTarget.value = null; }
});
const reissueRows = computed(() => (reissueTarget.value ? store.reissueDiffFor(reissueTarget.value.batch.no, reissueTarget.value.code) : []));

/* -------------------------------- 动作 -------------------------------- */

function createBatch() {
  if (!version.value.trim()) {
    MessagePlugin.error('请填写版本号');
    return;
  }
  if (!selectedChannels.value.length) {
    MessagePlugin.error('至少选择一个产品通道');
    return;
  }
  const batch = store.createReleaseBatch({
    version: version.value.trim(),
    channels: [...selectedChannels.value],
    note: note.value
  });
  if (batch) MessagePlugin.success(`批次 ${batch.no} 已创建，候选值与依赖快照已冻结`);
}

function send(code: ChannelCode) {
  const batch = openBatch.value;
  if (!batch) return;
  void store.sendToChannel(batch.no, code);
}

function retryAll() {
  const batch = openBatch.value;
  if (!batch) return;
  store.retryUnfinished(batch.no);
  MessagePlugin.info('已对未完成通道发起重试，已确认通道不会重发');
}

function manualAck(code: ChannelCode) {
  const batch = openBatch.value;
  if (!batch) return;
  store.ackManually(batch.no, code);
}

function settle(code: ChannelCode, action: 'accept-first' | 'accept-conflict') {
  const batch = openBatch.value;
  if (!batch) return;
  store.settleDispute(batch.no, code, action);
}

function closeBatch() {
  const batch = openBatch.value;
  if (!batch) return;
  if (store.closeOpenBatch(batch.no)) MessagePlugin.success(`批次 ${batch.no} 对账闭合，发布已锁定`);
  else MessagePlugin.warning('仍有通道未确认或存在待核，无法闭合');
}

function openSnapshot(code: ChannelCode | null) {
  snapshotChannel.value = code;
  const batch = openBatch.value;
  if (batch) snapshotRevision.value = code ? batch.deliveries[code].revision : batch.currentRevision;
  snapshotDialog.value = true;
}

function showReissue(batch: ReleaseBatch, code: ChannelCode) {
  reissueTarget.value = { batch, code };
}

/* ------------------------------- 展示辅助 ------------------------------- */

const STATUS_META: Record<string, { text: string; theme: 'default' | 'primary' | 'success' | 'warning' | 'danger' }> = {
  pending: { text: '待写入', theme: 'default' },
  awaiting: { text: '等待回执', theme: 'primary' },
  confirmed: { text: '已确认', theme: 'success' },
  failed: { text: '写入失败', theme: 'danger' },
  disputed: { text: '待核', theme: 'warning' }
};

function statusMeta(code: string) {
  return STATUS_META[code] ?? { text: code, theme: 'default' as const };
}

function fmtTime(at?: number) {
  return at ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

function fmtDateTime(at: number) {
  return new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function attemptLabel(seq: number) {
  return `#${seq}`;
}

const allConfirmed = computed(() => {
  const batch = openBatch.value;
  return !!batch && batch.channels.every((code) => batch.deliveries[code].status === 'confirmed');
});

const unfinishedCount = computed(() => {
  const batch = openBatch.value;
  if (!batch) return 0;
  return batch.channels.filter((code) => ['pending', 'failed', 'awaiting'].includes(batch.deliveries[code].status)).length;
});

function eventTheme(level: string) {
  return level === 'success' ? 'success' : level === 'danger' ? 'danger' : level === 'warning' ? 'warning' : 'default';
}
</script>

<template>
  <div class="reconcile-page">
    <!-- 批次创建 / 进行中批次 -->
    <section class="panel reconcile-main">
      <div class="panel-head">
        <div>
          <strong>发布批次与产品通道对账</strong>
          <span>创建批次时冻结候选值与依赖快照；回执按批次号 + 通道号合并，失败可恢复重试</span>
        </div>
        <t-tag v-if="openBatch" theme="primary" variant="light">进行中 {{ openBatch.no }}</t-tag>
        <t-tag v-else theme="warning" variant="light">无未闭合批次</t-tag>
      </div>

      <!-- 创建批次表单 -->
      <div v-if="!openBatch" class="reconcile-create">
        <div class="create-form">
          <label><span>版本号</span><t-input v-model="version" placeholder="4.6.0-rc.2" /></label>
          <label class="grow"><span>目标产品通道</span>
            <t-checkbox-group v-model="selectedChannels">
              <t-checkbox v-for="opt in channelOptions" :key="opt.value" :value="opt.value" :label="opt.label" />
            </t-checkbox-group>
          </label>
          <label class="full"><span>发布说明</span><t-textarea v-model="note" :autosize="{ minRows: 2, maxRows: 4 }" /></label>
        </div>
        <div class="create-actions">
          <p>创建后立即冻结当前候选令牌与依赖解析快照；基础令牌再被修改时，未完成通道自动按新修订重算。</p>
          <t-button theme="primary" @click="createBatch">创建批次并冻结快照</t-button>
        </div>
      </div>

      <template v-else>
        <!-- 批次概览与故障注入 -->
        <div class="batch-overview">
          <div class="batch-meta">
            <div><span>批次号</span><strong>{{ openBatch.no }}</strong></div>
            <div><span>版本</span><strong>DS {{ openBatch.version }}</strong></div>
            <div><span>当前修订</span><strong>rev {{ openBatch.currentRevision }}</strong></div>
            <div><span>创建于</span><strong>{{ fmtDateTime(openBatch.createdAt) }}</strong></div>
            <div><span>确认进度</span><strong>{{ progress?.confirmed }}/{{ progress?.total }}<em v-if="progress?.disputed"> · 待核 {{ progress.disputed }}</em><em v-if="progress?.failed"> · 失败 {{ progress.failed }}</em></strong></div>
          </div>
          <div class="fault-console">
            <span class="fault-title">通道故障模拟（写入中断 / 重复 / 乱序 / 旧别名）</span>
            <div class="fault-controls">
              <t-switch :value="store.writeFault" label="写入故障" @change="(v: boolean) => store.setWriteFaultMode(v)" />
              <t-switch :value="store.autoAck" label="自动回执" @change="(v: boolean) => store.setAutoAck(v)" />
              <t-button size="small" variant="outline" :disabled="!unfinishedCount" @click="retryAll">立即重试未完成通道（{{ unfinishedCount }}）</t-button>
              <t-button size="small" theme="primary" :disabled="!allConfirmed" @click="closeBatch">对账闭合批次</t-button>
            </div>
          </div>
        </div>

        <!-- 失效重算留档 -->
        <div v-if="openBatch.invalidationReviews.length" class="invalidation-strip">
          <div v-for="review in openBatch.invalidationReviews" :key="review.revision.seq" class="invalidation-card">
            <t-icon name="refresh" />
            <div>
              <strong>基础令牌改动 → rev {{ review.revision.seq }} 已重算</strong>
              <span>{{ review.revision.reason }}</span>
              <span class="invalidate-detail">
                重发通道：{{ review.affectedChannels.length ? review.affectedChannels.map(channelName).join('、') : '无' }}
                ；已确认按原快照可查：{{ review.confirmedChannels.length ? review.confirmedChannels.map(channelName).join('、') : '无' }}
              </span>
            </div>
          </div>
        </div>

        <!-- 通道表 -->
        <div class="channel-table">
          <div class="channel-row channel-head-row">
            <span>产品通道</span><span>状态</span><span>当前修订 / 序号</span><span>尝试记录</span><span>首次回执</span><span>回执留档</span><span style="text-align:right">操作</span>
          </div>
          <div v-for="code in openBatch.channels" :key="code" class="channel-row">
            <span class="ch-name"><strong>{{ openBatch.deliveries[code].name }}</strong><small>{{ CHANNEL_DIRECTORY.find(c => c.code === code)?.product }}</small></span>
            <span><t-tag size="small" :theme="statusMeta(openBatch.deliveries[code].status).theme">{{ statusMeta(openBatch.deliveries[code].status).text }}</t-tag></span>
            <span class="ch-rev">rev {{ openBatch.deliveries[code].revision }}<small>确认于 {{ fmtTime(openBatch.deliveries[code].confirmedAt) }}</small></span>
            <span class="ch-attempts">
              <t-tag v-for="a in openBatch.deliveries[code].attempts" :key="a.seq" size="small" :theme="a.result === 'written' ? 'default' : 'danger'" variant="light-outline" :title="a.error ?? ''">
                {{ attemptLabel(a.seq) }}{{ a.result === 'written' ? '✓' : '×' }}
              </t-tag>
              <em v-if="!openBatch.deliveries[code].attempts.length">尚未写入</em>
            </span>
            <span class="ch-first">
              <template v-if="openBatch.deliveries[code].receipts.length">
                <strong>#{{ openBatch.deliveries[code].receipts[0].seq }}</strong>
                <code>{{ openBatch.deliveries[code].receipts[0].checksum.slice(0, 8) }}</code>
                <small>{{ fmtTime(openBatch.deliveries[code].receipts[0].receivedAt) }}</small>
              </template>
              <em v-else>—</em>
            </span>
            <span class="ch-kept">
              <t-tag v-for="(r, i) in openBatch.deliveries[code].receipts" :key="`${r.seq}-${r.checksum}-${i}`" size="small"
                :theme="r.injected === 'tampered' ? 'danger' : r.injected ? 'warning' : openBatch.deliveries[code].confirmedKey && i === openBatch.deliveries[code].receipts.length - 1 ? 'success' : 'default'"
                variant="light" :title="`指纹 ${r.checksum}`">
                #{{ r.seq }}{{ r.injected === 'duplicate' ? ' 重复' : r.injected === 'out-of-order' ? ' 乱序' : r.injected === 'tampered' ? ' 篡改' : '' }}
              </t-tag>
            </span>
            <span class="ch-actions">
              <t-select
                :value="store.channelFault[code] ?? 'none'" size="small" style="width: 150px"
                :options="faultOptions"
                @change="(v: FaultMode) => store.setChannelFault(code, v)"
              />
              <t-button v-if="openBatch.deliveries[code].status === 'pending' || openBatch.deliveries[code].status === 'failed'" size="small" theme="primary"
                :loading="store.inflightChannels.includes(`${openBatch.no}:${code}`)" @click="send(code)">
                {{ openBatch.deliveries[code].status === 'failed' ? '立即重试' : '写入' }}
              </t-button>
              <t-button v-else-if="openBatch.deliveries[code].status === 'awaiting'" size="small" variant="outline" @click="manualAck(code)">手动补收回执</t-button>
              <t-button v-else-if="openBatch.deliveries[code].status === 'disputed'" size="small" variant="outline" @click="settle(code, 'accept-first')">采纳先到</t-button>
              <t-button v-if="openBatch.deliveries[code].status === 'confirmed' && openBatch.deliveries[code].revision < openBatch.currentRevision"
                size="small" theme="warning" variant="light" @click="showReissue(openBatch, code)">补发差异</t-button>
            </span>
          </div>
          <!-- 待核展开说明 -->
          <div v-for="code in openBatch.channels" :key="`dispute-${code}`">
            <div v-if="openBatch.deliveries[code].dispute" class="dispute-row">
              <t-icon :name="openBatch.deliveries[code].dispute.reason === 'out-of-order' ? 'order-ascending' : 'error-circle'" />
              <div>
                <strong>{{ openBatch.deliveries[code].name }} · {{ openBatch.deliveries[code].dispute.reason === 'out-of-order' ? '序号乱到' : '内容不一致' }} · 双方已保留待核</strong>
                <span>{{ openBatch.deliveries[code].dispute.note }}</span>
                <small v-if="openBatch.deliveries[code].dispute.resolved">
                  已处理：{{ openBatch.deliveries[code].dispute.resolved.action === 'accept-first' ? '采纳先到回执' : '采纳后到回执' }}（{{ fmtTime(openBatch.deliveries[code].dispute.resolved.at) }}）
                </small>
              </div>
              <template v-if="!openBatch.deliveries[code].dispute.resolved">
                <t-button size="small" variant="outline" @click="settle(code, 'accept-conflict')">采纳后到</t-button>
                <t-button size="small" theme="primary" @click="settle(code, 'accept-first')">采纳先到</t-button>
              </template>
            </div>
          </div>
        </div>
      </template>
    </section>

    <!-- 右侧：待核 / 快照 / 补发 / 历史 / 流水 -->
    <aside class="reconcile-side">
      <div class="panel dispute-panel">
        <div class="panel-head"><div><strong>待核清单</strong><span>跨批次汇总，重复回执只留首次，乱到与不一致双方保留</span></div><t-tag :theme="disputed.length ? 'warning' : 'success'">{{ disputed.length }}</t-tag></div>
        <p v-if="!disputed.length" class="empty">暂无待核通道。可在通道行切换「回执乱序 / 内容不一致」后重试观察。</p>
        <div v-for="item in disputed" :key="`${item.batch.no}-${item.delivery.code}`" class="dispute-side-row">
          <t-tag size="small" theme="warning" variant="light">{{ item.batch.no }}</t-tag>
          <div><strong>{{ item.delivery.name }}</strong><span>{{ item.delivery.dispute?.reason === 'out-of-order' ? '序号乱到' : '内容不一致' }} · 留档 {{ item.delivery.receipts.length }} 份</span></div>
        </div>
      </div>

      <div class="panel snapshot-panel">
        <div class="panel-head"><div><strong>冻结快照与依赖解析</strong><span>批次创建时的候选值，按修订只读留存</span></div>
          <t-button v-if="openBatch" size="small" variant="text" @click="openSnapshot(null)">查看</t-button>
        </div>
        <div v-if="openBatch" class="snapshot-summary">
          <div v-for="rev of openBatch.revisions" :key="rev.seq" class="rev-row" :class="{ current: rev.seq === openBatch.currentRevision }">
            <t-tag size="small" :theme="rev.seq === 0 ? 'default' : 'warning'" variant="light">rev {{ rev.seq }}</t-tag>
            <div><strong>{{ rev.seq === 0 ? '创建冻结' : '失效重算' }}</strong><span>{{ rev.reason }}</span></div>
          </div>
          <button class="snapshot-link" v-for="code in confirmedSnapshotChannels" :key="code" @click="openSnapshot(code)">
            {{ openBatch.deliveries[code].name }} 确认快照 rev {{ openBatch.deliveries[code].revision }} →
          </button>
        </div>
        <p v-else class="empty">创建批次后在此查看冻结的候选值与依赖链。</p>
      </div>

      <div class="panel history-panel">
        <div class="panel-head"><div><strong>已闭合批次</strong><span>已确认通道按确认时快照可查</span></div><HistoryIcon /></div>
        <p v-if="!store.closedBatches.length" class="empty">暂无已闭合批次。</p>
        <div v-for="batch in store.closedBatches" :key="batch.no" class="closed-row">
          <t-tag size="small" theme="success" variant="light">已闭合</t-tag>
          <div><strong>{{ batch.no }} · DS {{ batch.version }}</strong><span>{{ batch.channels.length }} 通道 · {{ fmtDateTime(batch.closedAt!) }}</span></div>
        </div>
      </div>

      <div class="panel ledger-panel">
        <div class="panel-head"><div><strong>对账流水</strong><span>写入、合并、失效重算与确认全记录</span></div></div>
        <div class="ledger-list">
          <div v-for="(event, i) in store.ledger.slice(0, 14)" :key="i" class="ledger-row">
            <t-tag size="small" :theme="eventTheme(event.level)" variant="light-outline">{{ fmtTime(event.at) }}</t-tag>
            <span>{{ event.text }}</span>
          </div>
          <p v-if="!store.ledger.length" class="empty">创建批次后开始记录。</p>
        </div>
      </div>
    </aside>

    <!-- 快照对话框 -->
    <t-dialog v-model:visible="snapshotDialog" header="冻结快照与依赖解析" width="720px" :footer="false">
      <div v-if="snapshotBatch" class="snapshot-dialog-body">
        <div class="snapshot-toolbar">
          <t-radio-group v-if="!snapshotChannel" v-model="snapshotRevision" size="small">
            <t-radio-button v-for="rev of snapshotBatch.revisions" :key="rev.seq" :value="rev.seq">rev {{ rev.seq }}（{{ rev.seq === 0 ? '创建冻结' : '重算' }}）</t-radio-button>
          </t-radio-group>
          <t-tag v-else theme="primary" variant="light">
            {{ snapshotChannel ? channelName(snapshotChannel) : '' }} 确认时快照 · rev {{ snapshotViewRevision }}
          </t-tag>
          <t-tag :theme="snapshotBaseChanged.length ? 'warning' : 'success'" variant="light">
            {{ snapshotBaseChanged.length ? `${snapshotBaseChanged.length} 项相对 rev 0 变化` : '与 rev 0 一致' }}
          </t-tag>
        </div>
        <div class="snapshot-table">
          <div class="snap-head"><span>令牌</span><span>原始值 / 引用</span><span>依赖链解析</span></div>
          <div v-for="entry in snapshotPkg" :key="entry.id" class="snap-row" :class="{ changed: snapshotBaseChanged.some(t => t.id === entry.id), cycle: entry.cycle }">
            <span><strong>{{ entry.name }}</strong><code>{{ entry.id }}</code></span>
            <span><code>{{ entry.value }}</code><small v-if="entry.ref">→ {{ '{' + entry.ref + '}' }}</small></span>
            <span><code :class="{ bad: entry.cycle }">{{ entry.cycle ? entry.chain.join(' → ') + '（循环）' : entry.resolvedValue }}</code><small>{{ entry.chain.length > 1 ? entry.chain.join(' → ') : '基础值' }}</small></span>
          </div>
        </div>
      </div>
    </t-dialog>

    <!-- 补发差异对话框 -->
    <t-dialog v-model:visible="reissueVisible" :header="reissueTarget ? `补发差异 · ${reissueTarget.batch.deliveries[reissueTarget.code].name}` : ''" width="640px" :footer="false">
      <div v-if="reissueTarget" class="reissue-body">
        <p class="reissue-hint">
          该通道已按 <strong>rev {{ reissueTarget.batch.deliveries[reissueTarget.code].revision }}</strong> 的快照确认，
          当前批次已重算到 <strong>rev {{ reissueTarget.batch.currentRevision }}</strong>。以下是补发需要对齐的差异：
        </p>
        <p v-if="!reissueRows.length" class="empty">解析结果无差异，无需补发。</p>
        <div v-for="row in reissueRows" :key="row.id" class="reissue-row">
          <div><strong>{{ row.name }}</strong><code>{{ row.id }}</code></div>
          <div class="reissue-values"><del>{{ row.before }}</del><ins>{{ row.after }}</ins></div>
        </div>
      </div>
    </t-dialog>
  </div>
</template>
