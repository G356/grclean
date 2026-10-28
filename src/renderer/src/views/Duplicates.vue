<script setup lang="ts">
import { Copy, SearchX } from "@lucide/vue";
import { ref, computed, onMounted, watch } from "vue";
import {
  scanDuplicates,
  deleteDuplicates,
  cancelScan,
  formatSize,
  buildScopeOptions,
  getLocal,
  setLocal,
  getCachedDisks,
  ensureDisksLoaded,
  type DuplicateGroup,
  type DuplicateFile,
  type DiskInfo,
} from "../api/electron";
import { recordScan } from "../stores/history";
import LastScan from "../components/LastScan.vue";
import Select from "../components/Select.vue";
import Modal from "../components/Modal.vue";
import EmptyState from "../components/EmptyState.vue";
import { settings } from "../stores/settings";

const SCOPE_KEY = "grclean.scope.dup";

/** 扫描范围：'C'/'D'…=指定盘符；'all'=全部盘符。默认系统盘，已持久化记忆。 */
const scope = ref(getLocal(SCOPE_KEY) || "");
/** 盘符列表：先用缓存瞬时填充，再后台刷新并缓存（避免每次进入都跑 PowerShell 查询）。 */
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

const groups = ref<DuplicateGroup[]>([]);
const loading = ref(false);
/** 是否已执行过一次扫描（区分「暂未扫描」与「已扫描无结果」两种空态） */
const scanned = ref(false);
const error = ref("");
const minSizeMb = ref(1)
/** 最小大小输入框的显示值（用 text + 数字键盘，规避 Windows 下 number 输入卡顿）。 */
const minSizeText = ref('1')
function onMinSizeInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  minSizeText.value = raw
  const n = parseInt(raw, 10)
  minSizeMb.value = Number.isFinite(n) && n >= 0 ? n : 0
};
const progress = ref(0);
/** 枚举到的文件总数（取扫描期间 progress 最大值：哈希阶段上报的候选数更小，不能覆盖）。 */
const enumerated = ref(0);

// 勾选状态：key = `${group_id}:${file_id}` -> 是否删除
const selected = ref<Record<string, boolean>>({});
const busy = ref(false);
const result = ref<{
  deleted: number;
  size: number;
  errors: string[];
  skipped: { path: string; reason: string }[];
  notes?: string[];
} | null>(null);
/** 删除完成弹窗（重新扫描 / 暂不） */
const showDone = ref(false);
/** 删除前确认弹窗（替代原生 confirm，统一应用内风格） */
const showConfirm = ref(false);
/** 待删除的副本 id 列表（确认后再执行，避免打开弹窗时丢失勾选） */
const pendingIds = ref<string[]>([]);

const totalGroups = computed(() => groups.value.length);
const totalWasted = computed(() =>
  groups.value.reduce((a, g) => a + g.wasted, 0),
);
const selectedCount = computed(
  () => Object.values(selected.value).filter(Boolean).length,
);
/** 副本（不含每组首条）是否全部已勾选：默认首条不勾、其余勾选 → 先显示「清空副本全选」。 */
const allCopiesSelected = computed(() => {
  if (groups.value.length === 0) return false;
  for (const g of groups.value) {
    for (let i = 1; i < g.files.length; i++) {
      if (!selected.value[keyOf(g, g.files[i])]) return false;
    }
  }
  return true;
});

function toggleAllCopies() {
  if (allCopiesSelected.value) {
    groups.value.forEach(clearGroup);
  } else {
    groups.value.forEach(selectAllCopies);
  }
}

function keyOf(g: DuplicateGroup, f: DuplicateFile) {
  return `${g.group_id}:${f.id}`;
}

// 默认每组保留 1 份（取消勾选第一个），其余副本标记为删除
function keepFirst(g: DuplicateGroup) {
  g.files.forEach((f, i) => {
    selected.value[keyOf(g, f)] = i !== 0;
  });
}

// 显式「选副本 / 全选副本」：勾选除首条外的全部副本（首条默认保留，需整组删除可自行勾选）
function selectAllCopies(g: DuplicateGroup) {
  g.files.forEach((f, i) => {
    selected.value[keyOf(g, f)] = i !== 0;
  });
}

function clearGroup(g: DuplicateGroup) {
  g.files.forEach((f) => {
    selected.value[keyOf(g, f)] = false;
  });
}

async function doScan() {
  loading.value = true;
  error.value = "";
  result.value = null;
  selected.value = {};
  groups.value = [];
  progress.value = 0;
  enumerated.value = 0;
  try {
    // 后端逐组发送重复组（从上方插入），并周期推送已哈希文件数；
    // 命令返回后用权威结果覆盖（按可释放空间降序）。
    const g = await scanDuplicates(
      minSizeMb.value,
      (group) => {
        groups.value.unshift(group);
        keepFirst(group);
      },
      (n) => {
        progress.value = n;
        if (n > enumerated.value) enumerated.value = n;
      },
      scope.value,
    );
    groups.value = g;
    g.forEach(keepFirst);
    void recordScan('dup', `${totalGroups.value} 组 · 可释放 ${formatSize(totalWasted.value)}`);
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
    scanned.value = true;
  }
}

async function doDelete() {
  const ids: string[] = [];
  for (const g of groups.value) {
    for (const f of g.files) {
      if (selected.value[keyOf(g, f)]) ids.push(f.id);
    }
  }
  if (ids.length === 0) {
    error.value = "没有选择要删除的副本。";
    return;
  }
  // 打开应用内确认弹窗（替代原生 confirm，统一风格）
  pendingIds.value = ids;
  showConfirm.value = true;
}

async function confirmDelete() {
  const ids = pendingIds.value;
  // 删除方式跟随全局配置：允许永久删除(allowPurge=true)→直接删除；否则移入回收站。
  const purge = settings.allowPurge;
  showConfirm.value = false;
  busy.value = true;
  error.value = "";
  try {
    const res = await deleteDuplicates(ids, purge);
    result.value = {
      deleted: res.deleted_count,
      size: res.deleted_size,
      errors: res.errors,
      skipped: (res.skipped ?? []).map((s) => ({
        path: s.path,
        reason: s.reason,
      })),
      notes: res.notes ?? [],
    };
    // 删除成功的条目从列表移除；被拦截 / 报错的条目保留，方便用户看到原因
    const skippedPaths = new Set((res.skipped ?? []).map((s) => s.path));
    const failed = (p: string) =>
      res.errors.some((e) => e.startsWith(p)) || skippedPaths.has(p);
    for (const g of groups.value) {
      g.files = g.files.filter(
        (f) => !ids.includes(f.id) || failed(f.path),
      );
    }
    groups.value = groups.value.filter((g) => g.files.length >= 2);
    selected.value = {};
    for (const g of groups.value) keepFirst(g);
    showDone.value = true;
  } catch (e: any) {
    error.value = `删除失败：${String(e)}`;
  } finally {
    busy.value = false;
  }
}

function doneRescan() {
  showDone.value = false;
  doScan();
}

/** 关闭错误弹框并清空错误（错误以弹框呈现，不在界面内联显示）。 */
function dismissError() {
  error.value = "";
}

function truncate(s: string, n = 64) {
  return s.length > n ? "…" + s.slice(s.length - n) : s;
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <Copy :size="22" class="title-icon" />
      重复文件
    </h1>
    <p class="muted">
      三级筛选：大小分组 → 头部哈希预筛 → 全量 SHA-256 确认。默认扫描系统盘，
      也可选择指定盘符或全盘；删除沿用七道防线（受保护路径拦截 · 默认回收站 · 审计）。（默认保留第一份，剩余则为副本）
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading" @click="doScan">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "扫描中…" : "扫描重复文件" }}
        </button>
        <button v-if="loading" class="btn" @click="cancelScan">
          取消
        </button>
        <label class="ms">扫描范围</label>
        <Select v-model="scope" :options="scopeOptions" :width="180" />
        <label class="ms">最小大小</label>
        <input
          :value="minSizeText"
          @input="onMinSizeInput"
          class="num"
          type="text"
          inputmode="numeric"
          min="0"
        />
        <span class="muted">MB</span>
        <LastScan module="dup" />
        <span class="muted scan-summary" v-if="loading">
          已扫描 {{ enumerated }} 个文件
        </span>
        <span class="muted scan-summary" v-else-if="totalGroups">
          本次共扫描 {{ enumerated }} 个文件 · 共 {{ totalGroups }} 组 · 可释放 {{ formatSize(totalWasted) }}
        </span>
      </div>
      <div v-if="loading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <div class="list fill-list" v-if="groups.length">
        <div v-for="g in groups" :key="g.group_id" class="group">
          <div class="group-head">
            <span class="badge">{{ g.count }} 份相同</span>
            <span class="muted">{{ formatSize(g.size) }} / 份</span>
            <span class="muted">可释放 {{ formatSize(g.wasted) }}</span>
            <span class="spacer" />
            <button class="btn tiny" @click="selectAllCopies(g)">
              选副本
            </button>
            <button class="btn tiny" @click="clearGroup(g)">清空</button>
          </div>
          <div v-for="f in g.files" :key="f.id" class="row">
            <label class="chk">
              <input
                type="checkbox"
                v-model="selected[keyOf(g, f)]"
              />
            </label>
            <div class="info">
              <div class="path" :title="f.path">{{ truncate(f.path) }}</div>
              <div class="meta muted">{{ formatSize(f.size) }}</div>
            </div>
          </div>
        </div>
      </div>
      <EmptyState
        v-else-if="loading"
        loading
        :icon="Copy"
        title="扫描中……"
      >
        <template #title-suffix>
          <span class="enum-hint">已枚举 {{ enumerated }} 个文件…</span>
        </template>
      </EmptyState>
      <EmptyState
        v-else-if="!scanned"
        :icon="Copy"
        title="暂未扫描"
        desc="选择扫描范围，点击「开始扫描」查找内容相同的重复文件。"
      />
      <EmptyState
        v-else
        :icon="SearchX"
        title="未发现对应记录"
        desc="当前范围内没有发现重复文件。"
      />

      <div v-if="groups.length" class="actions">
        <button
          class="btn btn-danger"
          :disabled="busy || selectedCount === 0"
          @click="doDelete"
        >
          {{
            busy
              ? "删除中…"
              : settings.allowPurge
                ? `直接删除所选（${selectedCount}）`
                : `删除所选（${selectedCount}）`
          }}
        </button>
        <button
          class="btn"
          :disabled="busy"
          @click="toggleAllCopies"
        >
          {{ allCopiesSelected ? "清空副本全选" : "全选副本" }}
        </button>
        <span class="muted"
          >勾选要删除的副本；整组勾选将彻底移除该文件（无保留副本）。</span
        >
      </div>
    </div>

    <!-- 删除前确认（替代原生 confirm，与删除完成弹窗统一风格） -->
    <Modal
      :open="showConfirm"
      title="删除重复副本"
      width="460px"
      @update:open="showConfirm = $event"
    >
      <p>
        确认将 <b>{{ pendingIds.length }}</b> 个重复副本{{
          settings.allowPurge ? "直接删除（不可恢复）" : "移入回收站"
        }}？可自由选择要删除的副本，整组勾选会彻底移除该文件。
      </p>
      <p class="muted small" v-if="!settings.allowPurge">
        移入回收站后仍可在回收站中还原；如需彻底删除，请在回收站里单独清空。
      </p>
      <p class="muted small warn-line" v-else>
        已开启「允许永久删除」，这些副本将被永久删除且无法还原，请确认无误。
      </p>
      <template #footer>
        <button class="btn" @click="showConfirm = false">取消</button>
        <button
          class="btn btn-danger"
          :disabled="busy"
          @click="confirmDelete"
        >
          {{ busy ? "删除中…" : "确认删除" }}
        </button>
      </template>
    </Modal>

    <!-- 删除完成提示：成功 / 被拦截 / 失败 明细，并提供重新扫描 -->
    <Modal
      :open="showDone"
      title="删除完成"
      width="480px"
      @update:open="showDone = $event"
    >
      <template v-if="result">
        <p v-if="result.deleted > 0">
          {{ settings.allowPurge ? "已永久删除" : "已移入回收站" }}
          <b>{{ result.deleted }}</b> 个副本，释放
          {{ formatSize(result.size) }}。
        </p>
        <p v-else class="err-line">
          未能删除任何副本（{{ result.errors.length + result.skipped.length }}
          项被拦截或失败，详见下方）。
        </p>
        <p v-if="result.deleted === 0 && !settings.allowPurge" class="muted small">
          若这些文件位于「无回收站」的卷（如可移动盘 / 网络盘 / exFAT），移入回收站会失败。可在「设置 → 允许永久删除」开启后改为直接删除。
        </p>
        <p v-if="result.notes?.length" class="muted small">
          {{ result.notes[0] }}<span v-if="result.notes.length > 1"> 等 {{ result.notes.length }} 项</span>
        </p>
        <p v-if="result.skipped.length" class="warn-line">
          {{ result.skipped.length }} 项被安全策略拦截（未删除）：
        </p>
        <ul v-if="result.skipped.length" class="detail-list">
          <li v-for="(s, i) in result.skipped.slice(0, 5)" :key="i">
            <span class="muted">{{ s.reason }}</span>
            <div class="detail-path">{{ s.path }}</div>
          </li>
        </ul>
        <p v-if="result.errors.length" class="err-line">
          删除失败 {{ result.errors.length }} 项：
        </p>
        <ul v-if="result.errors.length" class="detail-list">
          <li v-for="(e, i) in result.errors.slice(0, 5)" :key="i">
            <div class="detail-path">{{ e }}</div>
          </li>
        </ul>
      </template>
      <template #footer>
        <button class="btn" @click="showDone = false">暂不</button>
        <button class="btn btn-primary" @click="doneRescan">重新扫描</button>
      </template>
    </Modal>

    <!-- 错误提示：统一以弹框呈现，不在界面内联显示 -->
    <Modal
      :open="!!error"
      title="操作失败"
      width="460px"
      @update:open="(v: boolean) => { if (!v) dismissError() }"
    >
      <p class="err-line">{{ error }}</p>
      <template #footer>
        <button class="btn btn-primary" @click="dismissError">我知道了</button>
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
.scan-summary {
  margin-left: auto;
}
.ms {
  font-size: calc(13px * var(--fs-scale));
  color: var(--muted);
}
.num {
  width: 72px;
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 7px 10px;
  font-size: calc(14px * var(--fs-scale));
  background: var(--bg);
  color: var(--text);
}
.list {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.group {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.spacer {
  flex: 1;
}
.badge {
  background: var(--primary-weak);
  color: var(--primary);
  border-radius: 6px;
  padding: 2px 10px;
  font-size: calc(12px * var(--fs-scale));
  font-weight: 600;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 2px;
  border-top: 1px solid var(--border);
}
.chk {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  width: 20px;
}
.info {
  min-width: 0;
}
.path {
  font-size: calc(13px * var(--fs-scale));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 70vw;
}
.meta {
  font-size: calc(11px * var(--fs-scale));
}
.tiny {
  padding: 4px 10px;
  font-size: calc(12px * var(--fs-scale));
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}
.err {
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
  margin-top: 10px;
}
.warn-line {
  color: var(--warn, #d98324);
  font-size: calc(13px * var(--fs-scale));
  margin-top: 10px;
}
.err-line {
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
  margin-top: 10px;
}
.detail-list {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: calc(12px * var(--fs-scale));
}
.detail-path {
  word-break: break-all;
  color: var(--muted);
}
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
.enum-hint {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.small {
  font-size: calc(12px * var(--fs-scale));
}
</style>
