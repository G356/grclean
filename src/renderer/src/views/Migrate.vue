<script setup lang="ts">
import { ArrowLeftRight, SearchX } from "@lucide/vue";
import { ref, computed, watch, onMounted } from "vue";
import {
  listMigratable,
  listMigrateTargets,
  migrateDirectory,
  restoreDirectory,
  cancelScan,
  formatSize,
  listDisks,
  getCachedDisks,
  setCachedDisks,
  getLocal,
  setLocal,
  type MigrateItem,
  type MigrateTarget,
} from "../api/electron";
import OpenFolder from "../components/OpenFolder.vue";
import EmptyState from "../components/EmptyState.vue";
import Select from "../components/Select.vue";
import Modal from "../components/Modal.vue";

const items = ref<MigrateItem[]>([]);
const targets = ref<MigrateTarget[]>([]);
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const minMb = ref(200);
/** 是否完成过一次读取（区分「尚未读取」与「无符合目录」）。 */
const loaded = ref(false);
/** 扫描进度：已统计目录数 / 候选目录总数 */
const scannedDirs = ref(0);
const totalDirs = ref(0);

/** 目标盘符（默认选剩余空间最大的非系统盘） */
const targetLetter = ref("");
/** 目标子目录名 */
const subDir = ref("GrCleanData");

const selected = ref<Record<string, boolean>>({});
const selectedIds = computed(() =>
  items.value.filter((i) => selected.value[i.id] && !i.isJunction).map((i) => i.id),
);
/** 全部可选（非联接）条目是否已选中 —— 控制「全选 / 全不选」按钮文案。 */
const allSelected = computed(() => {
  const selectable = items.value.filter((i) => !i.isJunction);
  return selectable.length > 0 && selectable.every((i) => selected.value[i.id]);
});

const targetRoot = computed(() =>
  targetLetter.value ? `${targetLetter.value}:\\${subDir.value}` : "",
);

const activeTarget = computed(
  () => targets.value.find((t) => t.letter === targetLetter.value) || null,
);

const selectedBytes = computed(() =>
  items.value
    .filter((i) => selected.value[i.id] && !i.isJunction)
    .reduce((a, b) => a + b.size, 0),
);

/** 设计约束：目标盘剩余空间需 > 源数据 1.2 倍 */
const spaceEnough = computed(() => {
  const t = activeTarget.value;
  if (!t) return false;
  return t.freeBytes > selectedBytes.value * 1.2;
});

/** 记住上次选的目标盘符（排除系统盘） */
const TARGET_KEY = "grclean.migrate.target";

/** 刷新目标盘列表（引擎已排除系统盘），并恢复记忆 / 默认选中剩余空间最大的盘。 */
async function refreshTargets() {
  try {
    const ts = await listMigrateTargets();
    targets.value = ts;
    const saved = getLocal(TARGET_KEY);
    if (saved && ts.some((t) => t.letter === saved)) {
      targetLetter.value = saved;
    } else if (!targetLetter.value && ts.length) {
      // 默认选剩余空间最大的盘符（引擎已排除系统盘）
      targetLetter.value = [...ts].sort((a, b) => b.freeBytes - a.freeBytes)[0].letter;
    }
  } catch {
    /* 保留已有值 */
  }
}

/** 下拉选项：仅非系统盘（引擎已排除），展示剩余 / 总容量。 */
const targetOptions = computed(() =>
  targets.value.map((t) => ({
    value: t.letter,
    label: `${t.letter}: 剩余 ${formatSize(t.freeBytes)} / 共 ${formatSize(t.totalBytes)}`,
  })),
);

onMounted(async () => {
  // 先用磁盘缓存瞬时填充下拉（避免每次进入都重查），再后台刷新并缓存
  const cached = getCachedDisks();
  if (cached.length) {
    const sys = cached.find((d) => d.system)?.letter || "C";
    targets.value = cached
      .filter((d) => d.letter.toUpperCase() !== sys.toUpperCase())
      .map((d) => ({
        letter: d.letter,
        freeBytes: d.freeBytes,
        totalBytes: d.totalBytes,
      }));
    const saved = getLocal(TARGET_KEY);
    if (saved && targets.value.some((t) => t.letter === saved)) {
      targetLetter.value = saved;
    } else if (!targetLetter.value && targets.value.length) {
      targetLetter.value = [...targets.value].sort((a, b) => b.freeBytes - a.freeBytes)[0].letter;
    }
  }
  try {
    const list = await listDisks();
    setCachedDisks(list);
  } catch {
    /* 忽略 */
  }
  await refreshTargets();
});

// 目标盘选择变化即记忆，下次进入自动恢复
watch(targetLetter, (v) => {
  if (v) setLocal(TARGET_KEY, v);
});

async function load() {
  loading.value = true;
  error.value = "";
  notice.value = "";
  selected.value = {};
  items.value = [];
  try {
    // 后端逐条发送可迁移目录（从上方插入），前端边扫边显示；
    // 返回按体积降序的权威结果后覆盖。
    // seen 用 Set 去重：避免每来一项都对整表 some() 扫描（O(n²) → O(n)）
    scannedDirs.value = 0;
    totalDirs.value = 0;
    const seen = new Set<string>();
    items.value = await listMigratable(
      minMb.value,
      (it) => {
        if (!seen.has(it.id)) {
          seen.add(it.id);
          items.value.unshift(it);
        }
      },
      (done, total) => {
        scannedDirs.value = done;
        totalDirs.value = total;
      },
    );
    await refreshTargets();
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
    loaded.value = true;
  }
}

// 不再进入页面自动读取，等待用户点击按钮触发

const showConfirm = ref(false);
/** 迁移确认对话框提示文案（软件自带 Modal 替代系统 confirm）。 */
const confirmTip = ref("");

async function doMigrate() {
  const ids = selectedIds.value;
  if (!ids.length) {
    error.value = "没有选择要迁移的目录。";
    return;
  }
  if (!targetRoot.value) {
    error.value = "请选择目标盘符。";
    return;
  }
  if (!spaceEnough.value) {
    error.value =
      "目标盘剩余空间不足（需大于待迁移数据的 1.2 倍），请换一个盘符或减少选择。";
    return;
  }
  confirmTip.value =
    `确认把 ${ids.length} 个目录迁移到 ${targetRoot.value}？\n\n` +
    `流程：robocopy 移动 → mklink /J 建目录联接 → 读写校验；\n` +
    `任一步失败会自动回滚。软件不会感知路径变化。\n\n` +
    `注意：迁移过程中请勿关闭软件或断电。`;
  showConfirm.value = true;
}

/** Modal「确认迁移」回调：执行实际迁移流程，并实时刷新进度 Modal。 */
const showMigrating = ref(false);
const migProgress = ref<{ done: number; total: number; current: string }>({
  done: 0,
  total: 0,
  current: "",
});

async function confirmMigrate() {
  showConfirm.value = false;
  const ids = selectedIds.value;
  busy.value = true;
  error.value = "";
  notice.value = "";
  const msgs: string[] = [];
  // 打开进度 Modal（不可关闭，提示勿关软件）
  showMigrating.value = true;
  migProgress.value = { done: 0, total: ids.length, current: "" };
  try {
    for (const id of ids) {
      const it = items.value.find((x) => x.id === id);
      migProgress.value.current = it ? it.name : id;
      const r = await migrateDirectory(id, targetRoot.value);
      msgs.push(`${r.ok ? "✓" : "✗"} ${r.message}`);
      migProgress.value.done++;
    }
    notice.value = msgs.join("\n");
    await load();
  } catch (e: any) {
    error.value = `迁移失败：${String(e)}`;
  } finally {
    busy.value = false;
    showMigrating.value = false;
  }
}

async function doRestore(id: string) {
  if (!confirm("确认还原该目录？将删除联接并把数据搬回原路径。")) return;
  busy.value = true;
  error.value = "";
  try {
    const r = await restoreDirectory(id);
    notice.value = `${r.ok ? "✓" : "✗"} ${r.message}`;
    await load();
  } catch (e: any) {
    error.value = `还原失败：${String(e)}`;
  } finally {
    busy.value = false;
  }
}

/** 一键「全选 / 全不选」：切换所有非联接条目的勾选状态（绑定次级按钮）。 */
function toggleSelectAll() {
  const on = !allSelected.value;
  for (const it of items.value) {
    if (it.isJunction) continue;
    selected.value[it.id] = on;
  }
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <ArrowLeftRight :size="22" class="title-icon" />
      软件数据迁移
    </h1>
    <p class="muted">
      把仍在使用的软件数据目录从 C 盘搬到其它盘，并用<b>目录联接（mklink /J）</b>回填原路径，
      软件无感知。迁移前校验目标盘空间 &gt; 源数据 1.2 倍，迁移后读写校验，失败自动回滚。（排除系统/浏览器等核心目录，如已是链接可以还原）
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading || busy" @click="load">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "读取中…" : items.length ? "重新读取" : "开始读取" }}
        </button>
        <label class="lbl">最小体积</label>
        <input v-model.number="minMb" class="num" type="number" min="0" />
        <span class="muted">MB</span>
        <button v-if="loading" class="btn" @click="cancelScan">取消</button>
        <span class="spacer" />
        <span class="muted" v-if="loading && totalDirs">
          已统计 {{ scannedDirs }} / {{ totalDirs }} 个目录
        </span>
        <span class="muted" v-else-if="items.length">共 {{ items.length }} 个目录</span>
      </div>

      <div v-if="loading" class="progress toolbar-progress">
        <div
          class="bar"
          :class="{ indeterminate: !totalDirs }"
          :style="
            totalDirs
              ? { width: Math.round((scannedDirs / totalDirs) * 100) + '%' }
              : undefined
          "
        ></div>
      </div>

      <div class="target-bar">
        <label class="lbl">迁移到</label>
        <Select
          v-model="targetLetter"
          :options="targetOptions"
          :disabled="loading"
          :width="230"
          :row-height="48"
        />
        <span class="muted">\</span>
        <input v-model="subDir" class="kw" placeholder="目标子目录" />
        <span class="muted small">目标：{{ targetRoot || "（未选择）" }}</span>
      </div>

      <p v-if="!loading && !targetOptions.length" class="muted small empty-target">
        未检测到其它非系统盘符，请在至少一块非系统盘上进行迁移。
      </p>

      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="notice" class="notice">{{ notice }}</div>

      <div v-if="items.length" class="list fill-list">
        <div v-for="it in items" :key="it.id" class="row">
          <label class="chk" :class="{ disabled: it.isJunction }">
            <input
              type="checkbox"
              v-model="selected[it.id]"
              :disabled="it.isJunction"
            />
          </label>
          <div class="info">
            <div class="name">
              {{ it.name }}
              <span class="src">{{ it.source }}</span>
              <span v-if="it.isJunction" class="tag">已迁移（联接）</span>
            </div>
            <div class="path muted small" :title="it.path">{{ it.path }}</div>
          </div>
          <span class="spacer" />
          <button v-if="it.isJunction" class="btn tiny" @click="doRestore(it.id)">
            还原
          </button>
          <span class="size">{{ it.isJunction ? "—" : formatSize(it.size) }}</span>
          <OpenFolder :path="it.path" />
        </div>
      </div>
      <EmptyState
        v-else-if="loading"
        loading
        :icon="ArrowLeftRight"
        title="读取中……"
      />
      <EmptyState
        v-else-if="!loaded"
        :icon="ArrowLeftRight"
        title="暂未扫描"
        desc="点击「开始读取」扫描可迁移的软件数据目录。"
      />
      <EmptyState
        v-else
        :icon="SearchX"
        title="未发现对应记录"
        desc="没有符合体积阈值的可迁移目录。"
      />

      <div v-if="items.length" class="actions">
        <button
          class="btn btn-primary"
          :disabled="busy || selectedIds.length === 0 || !spaceEnough"
          @click="doMigrate"
        >
          {{ busy ? "迁移中…" : `迁移选中（${selectedIds.length} · ${formatSize(selectedBytes)}）` }}
        </button>
        <button class="btn" :disabled="busy || !items.length" @click="toggleSelectAll">
          {{ allSelected ? "全不选" : "全选" }}
        </button>
        <span v-if="selectedIds.length" class="space" :class="{ bad: !spaceEnough }">
          待迁移 {{ formatSize(selectedBytes) }}
          <template v-if="activeTarget">
            · 目标盘剩余 {{ formatSize(activeTarget.freeBytes) }}
            {{ spaceEnough ? "（空间充足）" : "（空间不足）" }}
          </template>
        </span>
      </div>
    </div>

    <!-- 迁移确认对话框（软件自带 Modal，替代系统 confirm） -->
    <Modal
      :open="showConfirm"
      title="确认迁移"
      width="460px"
      @update:open="showConfirm = $event"
    >
      <p style="white-space: pre-line">{{ confirmTip }}</p>
      <template #footer>
        <button class="btn" @click="showConfirm = false">取消</button>
        <button class="btn btn-primary" :disabled="busy" @click="confirmMigrate">
          确认迁移
        </button>
      </template>
    </Modal>

    <!-- 迁移进度对话框：迁移期间常驻，不可关闭，提示勿关软件 -->
    <Modal
      :open="showMigrating"
      title="迁移中…"
      width="460px"
      :close-on-mask="false"
      :hide-close="true"
    >
      <div class="mig-progress">
        <div class="mig-warn">
          ⚠ 迁移过程中请<b>不要关闭软件或断电</b>，否则可能导致数据不完整。
        </div>
        <div class="mig-bar">
          <div
            class="mig-fill"
            :style="{
              width: migProgress.total
                ? Math.round((migProgress.done / migProgress.total) * 100) + '%'
                : '0%',
            }"
          ></div>
        </div>
        <div class="mig-stat">
          已完成 {{ migProgress.done }} / {{ migProgress.total }} 个目录
        </div>
        <div v-if="migProgress.current" class="mig-cur">
          正在迁移：<b>{{ migProgress.current }}</b>
        </div>
      </div>
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
.target-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
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
  background: var(--panel);
  color: var(--text);
}
.kw {
  width: 140px;
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 6px 10px;
  font-size: calc(13px * var(--fs-scale));
  background: var(--panel);
  color: var(--text);
}
.empty-target {
  margin-top: 10px;
}
.spacer {
  flex: 1;
}
.small {
  font-size: calc(11px * var(--fs-scale));
}
.space {
  font-size: calc(12px * var(--fs-scale));
  color: var(--success);
}
.space.bad {
  color: var(--danger);
}
.list {
  margin-top: 14px;
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
  flex-shrink: 0;
}
.chk.disabled {
  opacity: 0.4;
}
.src {
  display: inline-block;
  font-size: calc(10px * var(--fs-scale));
  color: var(--primary);
  background: var(--primary-weak);
  border-radius: 5px;
  padding: 1px 7px;
  margin-left: 6px;
  vertical-align: 1px;
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
  max-width: 44vw;
}
.size {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  flex-shrink: 0;
  min-width: 78px;
  text-align: right;
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
.notice {
  margin-top: 10px;
  white-space: pre-wrap;
  font-size: calc(12px * var(--fs-scale));
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--bg);
}
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
.mig-progress { display: flex; flex-direction: column; gap: 14px; }
.mig-warn {
  font-size: calc(13px * var(--fs-scale));
  color: #d98324;
  background: rgba(217, 131, 36, 0.1);
  border: 1px solid rgba(217, 131, 36, 0.35);
  border-radius: 10px;
  padding: 10px 12px;
  line-height: 1.6;
}
.mig-bar {
  height: 10px;
  border-radius: 6px;
  background: var(--border);
  overflow: hidden;
}
.mig-fill {
  height: 100%;
  background: var(--primary);
  border-radius: 6px;
  transition: width 0.25s ease;
}
.mig-stat {
  font-size: calc(13px * var(--fs-scale));
  color: var(--text);
}
.mig-cur {
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
}
.mig-cur b { color: var(--text); }
</style>
