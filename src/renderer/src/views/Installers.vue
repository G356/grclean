<script setup lang="ts">
import { PackageOpen, SearchX, FolderOpen, Trash2 } from "@lucide/vue";
import { ref, computed, onMounted, watch } from "vue";
import {
  scanInstallers,
  cancelScanInstallers,
  deleteInstallers,
  openPath,
  formatSize,
  buildScopeOptions,
  getLocal,
  setLocal,
  getCachedDisks,
  ensureDisksLoaded,
  type InstallerItem,
  type DiskInfo,
} from "../api/electron";
import { recordScan } from "../stores/history";
import LastScan from "../components/LastScan.vue";
import Select from "../components/Select.vue";
import Modal from "../components/Modal.vue";
import EmptyState from "../components/EmptyState.vue";

const SCOPE_KEY = "grclean.scope.installers";

/** 扫描范围：'C'/'D'…=指定盘符；'all'=全部盘符。默认系统盘，已持久化记忆。 */
const scope = ref(getLocal(SCOPE_KEY) || "");
/** 盘符列表：先用缓存瞬时填充，再后台刷新并缓存。 */
const disks = ref<DiskInfo[]>(getCachedDisks());
const scopeOptions = computed(() => buildScopeOptions(disks.value));

function ensureScope() {
  const valid = scopeOptions.value.some((o) => o.value === scope.value);
  if (!valid) scope.value = scopeOptions.value[0]?.value ?? "all";
}

watch(scope, (v) => setLocal(SCOPE_KEY, v));

onMounted(async () => {
  try {
    disks.value = await ensureDisksLoaded();
  } catch {
    /* 保留缓存值 */
  }
  ensureScope();
});

const items = ref<InstallerItem[]>([]);
const selected = ref<Record<string, boolean>>({});
const loading = ref(false);
/** 已扫描（检查过）的候选文件总数：由后端进度回调驱动，用于展示扫描速度 */
const enumerated = ref(0);
/** 是否已执行过一次扫描（区分「暂未扫描」与「已扫描无结果」两种空态） */
const scanned = ref(false);
const error = ref("");
/** 批量删除确认框：点击底部「清理选中」直接弹出（不再二次点击 / 不再用系统 confirm） */
const showBatchConfirm = ref(false);
const batchBusy = ref(false);
/** 待批量删除的 id 列表（打开确认框时锁定，避免期间勾选变化导致结果错位） */
const batchDelIds = ref<string[]>([]);
/** 单行删除确认（软件 Modal，替代系统 confirm） */
const showRowDel = ref(false);
const rowDelBusy = ref(false);
const rowDelTarget = ref<InstallerItem | null>(null);
/** 删除结果弹窗：统一呈现「完成信息 / 失败原因」 */
const resultOpen = ref(false);
const resultTitle = ref("");
const resultMsg = ref("");
const resultErrors = ref<string[]>([]);
const resultShowRescan = ref(true);

/** 默认阈值：体积 ≥ 10MB 且存放 ≥ 30 天（设计：不自动删，需用户确认） */
const minSizeMb = ref(10);
const minDays = ref(30);

const selectedIds = computed(() =>
  items.value.filter((i) => selected.value[i.id]).map((i) => i.id),
);
const selectedBytes = computed(() =>
  items.value
    .filter((i) => selected.value[i.id])
    .reduce((a, b) => a + b.size, 0),
);
const totalBytes = computed(() => items.value.reduce((a, b) => a + b.size, 0));
const allChecked = computed(
  () => items.value.length > 0 && selectedIds.value.length === items.value.length,
);

function toggleAll(on: boolean) {
  for (const i of items.value) selected.value[i.id] = on;
}

function baseName(p: string) {
  return p.split("\\").pop() || p;
}

/** 中间省略号（头尾显示）：路径过长时保留「盘符/目录前缀」与「文件名后缀」，中间用省略号衔接。 */
function midEllipsis(p: string, max = 56): string {
  if (p.length <= max) return p;
  const keep = max - 1; // 给省略号留 1 个字符
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return p.slice(0, head) + "…" + p.slice(p.length - tail);
}

/** 把操作系统级错误信息翻译成中文原因（文件被占用 / 权限不足 / 已不存在等）。 */
function describeErr(msg: string): string {
  const m = msg.toLowerCase();
  if (
    m.includes("being used by another process") ||
    m.includes("ebusy") ||
    m.includes("resource busy")
  )
    return "文件被占用（可能被其它程序打开）";
  if (m.includes("denied") || m.includes("eacces") || m.includes("permission"))
    return "权限不足，无法删除";
  if (m.includes("enoent") || m.includes("not found") || m.includes("不存在"))
    return "文件已不存在";
  if (m.includes("still in place") || m.includes("未移入回收站"))
    return "未能移入回收站";
  return msg;
}

/** 引擎返回 "path: message"，转成 "文件名：原因"，路径过长中间省略。 */
function fmtErr(s: string): string {
  const idx = s.indexOf(": ");
  if (idx < 0) return s;
  const p = s.slice(0, idx);
  const reason = describeErr(s.slice(idx + 2));
  return `${baseName(p)}：${reason}`;
}

function showResult(
  title: string,
  msg: string,
  errors: string[] = [],
  showRescan = true,
) {
  resultTitle.value = title;
  resultMsg.value = msg;
  resultErrors.value = errors;
  resultShowRescan.value = showRescan;
  resultOpen.value = true;
}

function resultRescan() {
  resultOpen.value = false;
  doScan();
}

async function doScan() {
  loading.value = true;
  error.value = "";
  items.value = [];
  selected.value = {};
  enumerated.value = 0;
  try {
    const all = await scanInstallers(
      minSizeMb.value,
      minDays.value,
      scope.value,
      (it) => {
        items.value.unshift(it);
      },
      (n) => {
        // 后端回推的「已检查候选文件数」，平滑跳动，避免看起来像没扫描
        enumerated.value = n;
      },
    );
    items.value = all.sort((a, b) => b.size - a.size);
    void recordScan('installers', `${items.value.length} 个 · ${formatSize(totalBytes.value)}`);
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
    scanned.value = true;
  }
}

/** 点击底部「清理选中」：直接弹出确认框（不再二次点击 / 不再用系统 confirm）。 */
function askBatchDelete() {
  const ids = selectedIds.value;
  if (!ids.length) {
    error.value = "没有选择要清理的安装包。";
    return;
  }
  batchDelIds.value = ids.slice();
  showBatchConfirm.value = true;
}

async function confirmBatchDelete() {
  const ids = batchDelIds.value;
  if (!ids.length) return;
  batchBusy.value = true;
  error.value = "";
  try {
    const res = await deleteInstallers(ids, false);
    const done = new Set(ids);
    items.value = items.value.filter((i) => !done.has(i.id));
    for (const id of ids) delete selected.value[id];
    if (res.errors.length) {
      const allFailed = res.deleted_count === 0;
      showResult(
        allFailed ? "删除未完成" : "部分已删除",
        `已移入回收站 ${res.deleted_count} 个安装包，释放 ${formatSize(res.deleted_size)}。`,
        res.errors.slice(0, 8).map(fmtErr),
      );
    } else {
      showResult(
        "清理完成",
        `已移入回收站 ${res.deleted_count} 个安装包，释放 ${formatSize(res.deleted_size)}。默认进回收站，可从回收站还原。`,
      );
    }
  } catch (e: any) {
    showResult("删除失败", `清理时发生错误：${String(e)}`);
  } finally {
    batchBusy.value = false;
    showBatchConfirm.value = false;
  }
}

/** 打开文件所在目录（资源管理器定位到父目录）。 */
async function openFolder(it: InstallerItem) {
  const r = await openPath(it.path);
  if (!r.ok && r.error) error.value = `无法打开目录：${r.error}`;
}

/** 单行删除：先弹 Modal 确认（显示完整路径，中间省略），再调用与批量相同的回收站删除。 */
function askDeleteRow(it: InstallerItem) {
  rowDelTarget.value = it;
  showRowDel.value = true;
}

async function confirmRowDelete() {
  const it = rowDelTarget.value;
  if (!it) return;
  rowDelBusy.value = true;
  error.value = "";
  try {
    const res = await deleteInstallers([it.id], false);
    if (res.errors.length) {
      // 失败：保留列表，给出原因（如被占用）
      showResult(
        "删除失败",
        "以下安装包未能删除：",
        res.errors.slice(0, 8).map(fmtErr),
        false,
      );
    } else {
      // 成功：只移除已删项、保留结果列表（与批量删除一致）；
      // 完成提示复用多选完成方式——只报数量与结果，不列文件名（避免长路径溢出框）
      items.value = items.value.filter((x) => x.id !== it.id);
      delete selected.value[it.id];
      showResult(
        "删除完成",
        `已将 ${res.deleted_count} 个安装包移入回收站，可从回收站还原。`,
        [],
        false,
      );
    }
  } catch (e: any) {
    showResult("删除失败", `删除时发生错误：${String(e)}`, [], false);
  } finally {
    rowDelBusy.value = false;
    showRowDel.value = false;
    rowDelTarget.value = null;
  }
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <PackageOpen :size="22" class="title-icon" />
      安装包清理
    </h1>
    <p class="muted">
      扫描指定盘符中的
      <code>*.exe / *.msi / *.iso / *.zip / *.rar / *.7z</code>
      等安装包，按「体积 + 存放天数」过滤。<b>默认不勾选、不自动删</b>，确认后再清理。（设置0M、0天表示不限制体积和时间）
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading" @click="doScan">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "扫描中…" : "扫描安装包" }}
        </button>
        <button v-if="loading" class="btn" @click="cancelScanInstallers">
          取消
        </button>
        <label class="lbl">扫描范围</label>
        <Select v-model="scope" :options="scopeOptions" :width="180" />
        <label class="lbl">最小体积</label>
        <input v-model.number="minSizeMb" class="num" type="number" min="0" />
        <span class="muted">MB</span>
        <label class="lbl">存放超过</label>
        <input v-model.number="minDays" class="num" type="number" min="0" />
        <span class="muted">天</span>
        <span class="muted" v-if="items.length">
          共 {{ items.length }} 个 · {{ formatSize(totalBytes) }}
        </span>
        <LastScan module="installers" />
      </div>
      <div v-if="loading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <div v-if="error" class="err">{{ error }}</div>

      <div v-if="items.length" class="list fill-list">
        <div class="list-head">
          <label class="chk">
            <input
              type="checkbox"
              :checked="allChecked"
              @change="toggleAll(($event.target as HTMLInputElement).checked)"
            />
            <span class="muted small">全选</span>
          </label>
          <span class="spacer" />
          <span class="muted small">已选 {{ selectedIds.length }} 个</span>
        </div>
        <div v-for="it in items" :key="it.id" class="row">
          <label class="chk">
            <input type="checkbox" v-model="selected[it.id]" />
          </label>
          <span class="ext">{{ it.ext.toUpperCase() }}</span>
          <div class="info">
            <div class="name">
              {{ midEllipsis(baseName(it.path), 42) }}
              <span v-if="it.byName" class="tag">安装包特征</span>
            </div>
            <div class="path muted small" :title="it.path">{{ it.path }}</div>
          </div>
          <span class="spacer" />
          <span class="muted small">{{ it.days }} 天前</span>
          <span class="size">{{ formatSize(it.size) }}</span>
          <span class="row-actions">
            <button
              class="icon-btn"
              :title="'打开所在目录'"
              @click="openFolder(it)"
            >
              <FolderOpen :size="16" />
            </button>
            <button
              class="icon-btn danger"
              :title="'删除此文件'"
              @click="askDeleteRow(it)"
            >
              <Trash2 :size="16" />
            </button>
          </span>
        </div>
      </div>
      <EmptyState
        v-else-if="loading"
        loading
        :icon="PackageOpen"
        title="扫描中……"
      />
      <EmptyState
        v-else-if="!scanned"
        :icon="PackageOpen"
        title="暂未扫描"
        desc="选择扫描范围与阈值，点击「开始扫描」查找安装包与压缩包。"
      />
      <EmptyState
        v-else
        :icon="SearchX"
        title="未发现对应记录"
        desc="当前范围内没有发现符合阈值的安装包。"
      />

      <div v-if="loading || items.length" class="actions">
        <button
          class="btn btn-primary"
          :disabled="batchBusy || selectedIds.length === 0"
          @click="askBatchDelete"
        >
          <template v-if="batchBusy">清理中…</template>
          <template v-else>
            清理选中（{{ selectedIds.length }} ·
            {{ formatSize(selectedBytes) }}）
          </template>
        </button>
        <span class="muted">默认移入回收站，可从回收站还原。</span>
        <span class="muted actions-stat">
          已扫描 {{ enumerated }} 个文件，{{ items.length }} 项结果
        </span>
      </div>
    </div>

    <!-- 批量删除确认：点击「清理选中」直接弹出（不再二次点击 / 不再用系统 confirm） -->
    <Modal
      :open="showBatchConfirm"
      title="清理安装包"
      width="460px"
      @update:open="showBatchConfirm = $event"
    >
      <p>
        确认将选中的 <b>{{ batchDelIds.length }}</b> 个安装包（{{
          formatSize(selectedBytes)
        }}）移入回收站？可从回收站还原。
      </p>
      <template #footer>
        <button class="btn" :disabled="batchBusy" @click="showBatchConfirm = false">
          取消
        </button>
        <button class="btn btn-danger" :disabled="batchBusy" @click="confirmBatchDelete">
          {{ batchBusy ? "清理中…" : "移入回收站" }}
        </button>
      </template>
    </Modal>

    <!-- 删除结果：完成信息 / 失败原因 -->
    <Modal
      :open="resultOpen"
      :title="resultTitle"
      width="460px"
      @update:open="resultOpen = $event"
    >
      <p v-if="resultMsg">{{ resultMsg }}</p>
      <template v-if="resultErrors.length">
        <p class="muted">以下未能删除：</p>
        <ul class="err-list">
          <li v-for="(e, i) in resultErrors" :key="i">{{ e }}</li>
        </ul>
      </template>
      <template #footer>
        <button class="btn" @click="resultOpen = false">好的</button>
        <button v-if="resultShowRescan" class="btn btn-primary" @click="resultRescan">
          重新扫描
        </button>
      </template>
    </Modal>

    <!-- 单行删除确认（软件 Modal，替代系统 confirm；完整路径中间省略） -->
    <Modal
      :open="showRowDel"
      title="删除安装包"
      width="460px"
      @update:open="showRowDel = $event"
    >
      <p v-if="rowDelTarget">确认将以下安装包移入回收站？可从回收站还原。</p>
      <div v-if="rowDelTarget" class="path-box">
        <div class="path-item single" :title="rowDelTarget.path">
          {{ midEllipsis(rowDelTarget.path, 60) }}
        </div>
      </div>
      <template #footer>
        <button class="btn" :disabled="rowDelBusy" @click="showRowDel = false">
          取消
        </button>
        <button
          class="btn btn-danger"
          :disabled="rowDelBusy"
          @click="confirmRowDelete"
        >
          {{ rowDelBusy ? "删除中…" : "移入回收站" }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.lbl {
  font-size: calc(13px * var(--fs-scale));
  color: var(--muted);
}
.num {
  width: 72px;
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 6px 10px;
  font-size: calc(13px * var(--fs-scale));
  background: var(--bg);
  color: var(--text);
}
.spacer {
  flex: 1;
}
.small {
  font-size: calc(11px * var(--fs-scale));
}
.list {
  margin-top: 14px;
}
.list-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--border);
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(13px * var(--fs-scale));
  flex-shrink: 0;
}
.ext {
  flex-shrink: 0;
  font-size: calc(10px * var(--fs-scale));
  font-weight: 700;
  color: var(--primary);
  background: var(--primary-weak);
  border-radius: 5px;
  padding: 2px 7px;
  min-width: 42px;
  text-align: center;
}
.info {
  min-width: 0;
}
.name {
  font-size: calc(13px * var(--fs-scale));
}
.tag {
  font-size: calc(10px * var(--fs-scale));
  color: var(--success);
  border: 1px solid var(--success);
  border-radius: 5px;
  padding: 0 6px;
  margin-left: 6px;
}
.path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 46vw;
}
.size {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  flex-shrink: 0;
  min-width: 78px;
  text-align: right;
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}
/* 扫描统计：推到卡片右下方（清理按钮之后、行末） */
.actions-stat {
  margin-left: auto;
  font-size: calc(12px * var(--fs-scale));
  white-space: nowrap;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.icon-btn:hover {
  color: var(--primary);
  border-color: var(--primary);
}
.icon-btn.danger:hover {
  color: var(--danger);
  border-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, var(--panel));
}
.err {
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
  margin-top: 10px;
}
.ok {
  color: var(--success);
  font-size: calc(13px * var(--fs-scale));
  margin-top: 10px;
}
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
/* 弹窗内路径列表：中间省略的长路径不溢出，可滚动 */
.path-box {
  margin-top: 12px;
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg);
  padding: 8px 10px;
}
.path-item {
  font-size: calc(12px * var(--fs-scale));
  line-height: 1.7;
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow-wrap: anywhere;
}
.path-item.single {
  font-size: calc(13px * var(--fs-scale));
}
.path-more {
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
  margin-top: 4px;
}
.err-list {
  margin: 4px 0 0;
  padding-left: 18px;
}
.err-list li {
  font-size: calc(12.5px * var(--fs-scale));
  line-height: 1.6;
  color: var(--danger);
  overflow-wrap: anywhere;
}
</style>
