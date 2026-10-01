<script setup lang="ts">
import { computed, ref } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { RefreshIcon } from 'tdesign-icons-vue-next';
import { useTokenStore } from '../store';
import type { ReleaseBatch, ProductChannel, ReviewItem } from '../reconcile';

const store = useTokenStore();

const productOptions = [
  { label: '组件库', value: '组件库' },
  { label: '运营后台', value: '运营后台' },
  { label: '移动端组件', value: '移动端组件' },
  { label: '数据平台', value: '数据平台' }
];

const newVersion = ref(store.releaseVersion);
const newProducts = ref<string[]>(['组件库', '运营后台', '移动端组件']);
const selectedBatchNo = ref<string>(store.batches[0]?.batchNo ?? '');

const receiptChannelNo = ref('');
const receiptType = ref<'normal' | 'duplicate' | 'out_of_order' | 'content_mismatch'>('normal');

const selectedBatch = computed<ReleaseBatch | undefined>(() =>
  store.batches.find((b) => b.batchNo === selectedBatchNo.value)
);

const pendingReviews = computed<ReviewItem[]>(() =>
  selectedBatch.value?.reviewItems.filter((r) => r.status === 'pending') ?? []
);

function batchProgress(batch: ReleaseBatch): number {
  if (!batch.channels.length) return 0;
  return Math.round((batch.channels.filter((c) => c.status === 'confirmed').length / batch.channels.length) * 100);
}

function statusTheme(status: string): 'success' | 'warning' | 'danger' | 'default' | 'primary' {
  switch (status) {
    case 'confirmed': case 'closed': case 'resolved': return 'success';
    case 'sent': return 'primary';
    case 'failed': case 'invalidated': return 'danger';
    case 'review': case 'pending': case 'open': return 'warning';
    default: return 'default';
  }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: '待发送', sent: '已发送', confirmed: '已确认', failed: '写入失败', review: '待核',
    open: '进行中', closed: '已闭合', invalidated: '已失效',
    resolved: '已处理'
  };
  return map[status] ?? status;
}

function reasonLabel(reason: string): string {
  return reason === 'seq_out_of_order' ? '序号乱序' : reason === 'content_mismatch' ? '内容不一致' : '重复回执';
}

async function createBatch() {
  if (!newProducts.value.length) {
    MessagePlugin.warning('请至少选择一个目标产品');
    return;
  }
  const batchNo = store.createBatch(newVersion.value, newProducts.value);
  selectedBatchNo.value = batchNo;
  receiptChannelNo.value = '';
  MessagePlugin.success(`批次 ${batchNo} 已创建，候选值与依赖快照已冻结`);
}

async function sendChannel(channel: ProductChannel) {
  if (!selectedBatch.value) return;
  await store.sendChannel(selectedBatch.value.batchNo, channel.channelNo);
  const updated = selectedBatch.value.channels.find((c) => c.channelNo === channel.channelNo);
  if ( updated?.status === 'sent') {
    MessagePlugin.success(`通道 ${channel.channelNo} 写入成功`);
  } else if (updated?.status === 'failed') {
    MessagePlugin.error(`通道 ${channel.channelNo} 写入失败：${updated.lastError}`);
  }
}

async function retryAll() {
  if (!selectedBatch.value) return;
  await store.retryFailedChannels(selectedBatch.value.batchNo);
  MessagePlugin.info('已重试所有未完成通道');
}

function submitReceipt() {
  if (!selectedBatch.value || !receiptChannelNo.value) {
    MessagePlugin.warning('请选择回执通道');
    return;
  }
  const channel = selectedBatch.value.channels.find((c) => c.channelNo === receiptChannelNo.value);
  if (!channel) return;

  let seq = channel.seq;
  let contentHash = channel.contentHash;
  if (receiptType.value === 'out_of_order') seq = channel.seq + 1;
  if (receiptType.value === 'content_mismatch') contentHash = 'h-corrupted00';

  const raw = JSON.stringify({ batchNo: selectedBatch.value.batchNo, channelNo: channel.channelNo, seq, contentHash, type: receiptType.value });
  const { result } = store.submitReceipt(selectedBatch.value.batchNo, channel.channelNo, seq, contentHash, raw);

  if (result === 'accepted') MessagePlugin.success(`通道 ${channel.channelNo} 回执已确认`);
  else if (result === 'duplicate') MessagePlugin.warning(`通道 ${channel.channelNo} 重复回执，只保留首次`);
  else MessagePlugin.warning(`通道 ${channel.channelNo} 回执异常，已进入待核`);
}

function resolveReview(review: ReviewItem, resolution: 'confirmed' | 'rejected') {
  if (!selectedBatch.value) return;
  store.resolveReview(selectedBatch.value.batchNo, review.id, resolution);
  MessagePlugin.success(resolution === 'confirmed' ? '已确认首次回执有效' : '已驳回并重新发送');
}
</script>

<template>
  <div class="reconcile-page">
    <!-- 工具栏 -->
    <div class="panel reconcile-toolbar">
      <div class="toolbar-row">
        <div class="toolbar-field">
          <span>版本号</span>
          <t-input v-model="newVersion" size="small" placeholder="版本号" />
        </div>
        <div class="toolbar-field grow">
          <span>目标产品</span>
          <t-select v-model="newProducts" size="small" multiple :options="productOptions" placeholder="选择目标产品" />
        </div>
        <t-button theme="primary" size="small" @click="createBatch">创建批次</t-button>
        <label class="failure-toggle">
          <t-checkbox v-model="store.simulateFailure" />
          <span>模拟写入失败（演示中断重试）</span>
        </label>
      </div>
    </div>

    <div class="reconcile-layout">
      <!-- 批次列表 -->
      <div class="batch-list">
        <div v-for="batch in store.batches" :key="batch.batchNo" class="panel batch-card" :class="{ active: selectedBatchNo === batch.batchNo }" @click="selectedBatchNo = batch.batchNo">
          <div class="batch-card-head">
            <strong>{{ batch.batchNo }}</strong>
            <t-tag size="small" :theme="statusTheme(batch.status)" variant="light">{{ statusLabel(batch.status) }}</t-tag>
          </div>
          <div class="batch-card-meta">
            <span>{{ batch.version }}</span>
            <span>{{ new Date(batch.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }}</span>
          </div>
          <t-progress :percentage="batchProgress(batch)" size="small" />
          <div class="batch-card-stats">
            <span>{{ batch.channels.filter(c => c.status === 'confirmed').length }}/{{ batch.channels.length }} 已确认</span>
            <span v-if="batch.reviewItems.some(r => r.status === 'pending')" class="review-dot">{{ batch.reviewItems.filter(r => r.status === 'pending').length }} 待核</span>
          </div>
        </div>
        <div v-if="!store.batches.length" class="panel empty-batches">
          <t-icon name="inbox" size="32px" />
          <p>暂无发布批次</p>
          <span>创建批次后将冻结候选值与依赖快照</span>
        </div>
      </div>

      <!-- 批次详情 -->
      <div class="batch-detail" v-if="selectedBatch">
        <!-- 快照信息 -->
        <div class="panel detail-section">
          <div class="panel-head">
            <div><strong>冻结快照</strong><span>{{ selectedBatch.snapshot.tokens.length }} 个令牌 · {{ selectedBatch.snapshot.dependencyEdges.length }} 条依赖</span></div>
            <t-tag size="small" variant="light">{{ selectedBatch.snapshot.contentHash }}</t-tag>
          </div>
          <div class="snapshot-meta">
            <div><span>冻结时间</span><strong>{{ new Date(selectedBatch.snapshot.frozenAt).toLocaleString('zh-CN') }}</strong></div>
            <div v-if="selectedBatch.invalidatedAt"><span>失效时间</span><strong>{{ new Date(selectedBatch.invalidatedAt).toLocaleString('zh-CN') }}</strong></div>
            <div v-if="selectedBatch.recalculatedAt"><span>重算时间</span><strong>{{ new Date(selectedBatch.recalculatedAt).toLocaleString('zh-CN') }}</strong></div>
            <div v-if="selectedBatch.invalidateReason"><span>失效原因</span><strong>{{ selectedBatch.invalidateReason }}</strong></div>
          </div>
        </div>

        <!-- 产品通道 -->
        <div class="panel detail-section">
          <div class="panel-head">
            <div><strong>产品通道</strong><span>回执按批次号与通道号合并</span></div>
            <t-button size="small" variant="outline" :icon="RefreshIcon" @click="retryAll">重试未完成通道</t-button>
          </div>
          <table class="detail-table">
            <thead><tr><th>通道号</th><th>产品</th><th>状态</th><th>序号</th><th>内容哈希</th><th>发送时间</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="channel in selectedBatch.channels" :key="channel.channelNo">
                <td class="mono">{{ channel.channelNo }}</td>
                <td>{{ channel.product }}</td>
                <td><t-tag size="small" :theme="statusTheme(channel.status)" variant="light">{{ statusLabel(channel.status) }}</t-tag></td>
                <td class="mono">{{ channel.seq || '—' }}</td>
                <td class="mono hash">{{ channel.contentHash || '—' }}</td>
                <td>{{ channel.sentAt ? new Date(channel.sentAt).toLocaleTimeString('zh-CN') : '—' }}</td>
                <td>
                  <t-button size="small" variant="text" :disabled="channel.status === 'confirmed'" @click="sendChannel(channel)">
                    {{ channel.status === 'failed' ? '重试' : '发送' }}
                  </t-button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 回执提交 -->
        <div class="panel detail-section">
          <div class="panel-head"><div><strong>回执提交</strong><span>模拟产品侧回传回执，验证合并逻辑</span></div></div>
          <div class="receipt-form">
            <t-select v-model="receiptChannelNo" size="small" :options="selectedBatch.channels.map(c => ({ label: `${c.channelNo} · ${c.product}`, value: c.channelNo }))" placeholder="选择通道" style="width: 200px" />
            <t-select v-model="receiptType" size="small" :options="[
              { label: '正常回执（序号一致）', value: 'normal' },
              { label: '重复回执（同通道再次提交）', value: 'duplicate' },
              { label: '序号乱序', value: 'out_of_order' },
              { label: '内容不一致', value: 'content_mismatch' }
            ]" style="width: 240px" />
            <t-button size="small" theme="primary" @click="submitReceipt">提交回执</t-button>
          </div>
        </div>

        <!-- 待核 -->
        <div class="panel detail-section" v-if="pendingReviews.length">
          <div class="panel-head"><div><strong>待核事项</strong><span>序号乱序或内容不一致，保留双方回执</span></div></div>
          <div v-for="review in pendingReviews" :key="review.id" class="review-card">
            <div class="review-head">
              <t-tag size="small" theme="warning" variant="light">{{ reasonLabel(review.reason) }}</t-tag>
              <span class="mono">{{ review.channelNo }}</span>
            </div>
            <div class="review-receipts">
              <div class="review-receipt">
                <span>首次回执</span>
                <code>序号 {{ review.firstReceipt.seq }} · {{ review.firstReceipt.contentHash }}</code>
                <small>{{ new Date(review.firstReceipt.receivedAt).toLocaleString('zh-CN') }}</small>
              </div>
              <t-icon name="arrow-right" />
              <div class="review-receipt">
                <span>二次回执</span>
                <code>序号 {{ review.secondReceipt.seq }} · {{ review.secondReceipt.contentHash }}</code>
                <small>{{ new Date(review.secondReceipt.receivedAt).toLocaleString('zh-CN') }}</small>
              </div>
            </div>
            <div class="review-actions">
              <t-button size="small" variant="outline" @click="resolveReview(review, 'rejected')">驳回重发</t-button>
              <t-button size="small" theme="primary" @click="resolveReview(review, 'confirmed')">确认首次有效</t-button>
            </div>
          </div>
        </div>

        <!-- 补发差异 -->
        <div class="panel detail-section" v-if="selectedBatch.reissueDiffs.length">
          <div class="panel-head"><div><strong>补发差异</strong><span>基础令牌修改后，已确认通道按原快照可查，差异如下</span></div></div>
          <div v-for="diff in selectedBatch.reissueDiffs" :key="diff.channelNo" class="diff-card">
            <div class="diff-head">
              <strong>{{ diff.channelNo }} · {{ diff.product }}</strong>
              <span class="mono">{{ diff.originalHash }} → {{ diff.currentHash }}</span>
            </div>
            <div v-for="token in diff.changedTokens" :key="token.id" class="diff-token">
              <span>{{ token.name }}</span>
              <code class="mono">{{ token.id }}</code>
              <div class="diff-values"><del>{{ token.before }}</del><ins>{{ token.after }}</ins></div>
            </div>
            <p v-if="!diff.changedTokens.length" class="empty">快照内容无差异</p>
          </div>
        </div>

        <!-- 回执记录 -->
        <div class="panel detail-section" v-if="selectedBatch.receipts.length">
          <div class="panel-head"><div><strong>回执记录</strong><span>同通道重复回执只保留首次</span></div></div>
          <table class="detail-table">
            <thead><tr><th>通道号</th><th>序号</th><th>内容哈希</th><th>接收时间</th></tr></thead>
            <tbody>
              <tr v-for="receipt in selectedBatch.receipts" :key="receipt.id">
                <td class="mono">{{ receipt.channelNo }}</td>
                <td class="mono">{{ receipt.seq }}</td>
                <td class="mono hash">{{ receipt.contentHash }}</td>
                <td>{{ new Date(receipt.receivedAt).toLocaleString('zh-CN') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reconcile-page { display: grid; gap: 13px; }
.reconcile-toolbar { padding: 12px 14px; }
.toolbar-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.toolbar-field { display: grid; gap: 4px; }
.toolbar-field.grow { flex: 1; min-width: 180px; }
.toolbar-field span { color: var(--muted); font-size: 9px; font-weight: 700; }
.failure-toggle { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); padding-bottom: 5px; cursor: pointer; }
.reconcile-layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 13px; align-items: start; }
.batch-list { display: grid; gap: 10px; }
.batch-card { padding: 12px 14px; cursor: pointer; border: 1px solid var(--line); transition: .15s; }
.batch-card:hover { border-color: #b0c4de; }
.batch-card.active { border-color: var(--blue); box-shadow: 0 0 0 1px var(--blue); }
.batch-card-head { display: flex; justify-content: space-between; align-items: center; }
.batch-card-head strong { font-size: 13px; }
.batch-card-meta { display: flex; justify-content: space-between; margin: 6px 0 8px; font-size: 9px; color: var(--muted); }
.batch-card-stats { display: flex; justify-content: space-between; margin-top: 8px; font-size: 10px; color: var(--muted); }
.review-dot { color: var(--amber); font-weight: 700; }
.empty-batches { padding: 30px; text-align: center; color: var(--muted); }
.empty-batches p { margin: 10px 0 4px; font-size: 12px; color: var(--ink); }
.empty-batches span { font-size: 10px; }
.batch-detail { display: grid; gap: 13px; }
.detail-section { overflow: hidden; }
.snapshot-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; padding: 12px 14px; }
.snapshot-meta > div { display: grid; gap: 2px; }
.snapshot-meta span { color: var(--muted); font-size: 9px; }
.snapshot-meta strong { font-size: 10px; overflow-wrap: anywhere; }
.detail-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.detail-table th { text-align: left; padding: 8px 12px; color: var(--muted); font-size: 9px; font-weight: 700; border-bottom: 1px solid var(--line); background: #fafcfd; }
.detail-table td { padding: 8px 12px; border-bottom: 1px solid #edf1f3; }
.mono { font-family: ui-monospace, monospace; font-size: 10px; }
.hash { color: var(--muted); }
.receipt-form { display: flex; gap: 10px; padding: 12px 14px; align-items: center; flex-wrap: wrap; }
.review-card { padding: 12px 14px; border-bottom: 1px solid #edf1f3; }
.review-card:last-child { border-bottom: 0; }
.review-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.review-receipts { display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: center; }
.review-receipt { background: #f6f8fa; border: 1px solid var(--line); border-radius: 4px; padding: 8px 10px; display: grid; gap: 3px; }
.review-receipt span { color: var(--muted); font-size: 8px; }
.review-receipt code { font-size: 9px; overflow-wrap: anywhere; }
.review-receipt small { color: var(--muted); font-size: 8px; }
.review-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.diff-card { padding: 12px 14px; border-bottom: 1px solid #edf1f3; }
.diff-card:last-child { border-bottom: 0; }
.diff-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.diff-head strong { font-size: 12px; }
.diff-token { display: grid; grid-template-columns: 120px 1fr auto; gap: 8px; align-items: center; padding: 5px 0; font-size: 10px; }
.diff-token span { font-weight: 600; }
.diff-values { display: flex; gap: 6px; }
.diff-values del, .diff-values ins { padding: 2px 6px; font-size: 9px; border-radius: 3px; }
.diff-values del { color: #a34a48; background: #fdeceb; }
.diff-values ins { color: #17664b; background: #e7f5ef; text-decoration: none; }
@media (max-width: 1100px) {
  .reconcile-layout { grid-template-columns: 1fr; }
}
</style>
