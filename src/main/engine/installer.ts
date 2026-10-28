/**
 * 安装包清理（design.md §3.7）。
 *
 * 扫描常见下载目录中的 `*.exe / *.msi / *.iso / *.zip / *.rar / *.7z`，
 * 按「超过 N 天且体积 > 阈值」列出。**不自动删**，需用户勾选确认。
 *
 * 安装包特征识别（避免把日常工作文档误判为安装包）：
 * - 扩展名命中安装包集合；
 * - 且（文件名含 setup/install/安装包/驱动 等关键字，或体积 ≥ 10MB）。
 *
 * 删除沿用纵深防御：会话 id 反查 → `isProtected` → 仅文件 → 默认回收站 → 审计。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import fg from 'fast-glob'
import { expandEnv } from './rules'
import { isProtected } from './protected'
import { logDeletion } from './audit'
import { moveToRecycleBin } from './trash-bin'
import type { CleanResult } from './model'

/** 安装包相关扩展名。 */
const EXTS = ['exe', 'msi', 'iso', 'zip', 'rar', '7z', 'cab', 'msix', 'appx']

/** 文件名特征关键字（命中即可认定为安装包，即便体积不大）。 */
const NAME_HINTS = [
  'setup',
  'install',
  'installer',
  'uninstall',
  'driver',
  '安装包',
  '驱动',
  '绿色版',
  'portable',
]

/** 体积 ≥ 此值即视为安装包候选（即便文件名无特征）。 */
const BIG_ENOUGH = 10 * 1024 * 1024

export interface InstallerItem {
  id: string
  path: string
  size: number
  /** 修改时间（毫秒时间戳） */
  mtime: number
  /** 文件天数 */
  days: number
  ext: string
  /** 是否命中文件名特征 */
  byName: boolean
}

function hashId(p: string): string {
  return 'ins:' + crypto.createHash('md5').update(p).digest('hex').slice(0, 16)
}

/** 待扫描的下载类目录（展开环境变量后去重，不存在则跳过）。 */
function downloadDirs(): string[] {
  const raw = [
    '%USERPROFILE%\\Downloads',
    '%USERPROFILE%\\Desktop',
    '%USERPROFILE%\\Documents',
    '%USERPROFILE%\\OneDrive\\桌面',
    '%USERPROFILE%\\OneDrive\\文档',
    '%USERPROFILE%\\Downloads\\Programs',
  ]
  const out: string[] = []
  for (const r of raw) {
    const p = expandEnv(r).replace(/\//g, '\\')
    if (!p) continue
    try {
      if (fs.existsSync(p) && !out.includes(p)) out.push(p)
    } catch {
      /* ignore */
    }
  }
  return out
}

function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

/** 系统盘盘符（WINDIR/SystemDrive/USERPROFILE 推断，兼容非 C: 系统盘）。 */
function systemDriveLetter(): string {
  for (const raw of [process.env.SystemDrive, process.env.WINDIR, process.env.USERPROFILE]) {
    const v = (raw || '').trim().replace(/\//g, '\\')
    if (/^[a-zA-Z]:/.test(v)) return v[0].toUpperCase()
  }
  return 'C'
}

/** 枚举存在的盘符字母（A:~Z:）。 */
function allDriveLetters(): string[] {
  const out: string[] = []
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c)
    try {
      if (fs.existsSync(`${letter}:\\`)) out.push(letter)
    } catch {
      /* 不可访问的盘符跳过 */
    }
  }
  return out
}

/**
 * 判定是否为安装包候选。
 * @param minSizeMb 用户设置的体积下限（MB）。为 0 表示「不限大小」，此时不再用
 *                  内部 10MB 门槛二次卡体积（否则「设 0M 却仍漏掉小 rar」会让人困惑）。
 */
function isInstallerLike(
  name: string,
  size: number,
  minSizeMb: number,
): boolean {
  const lower = name.toLowerCase()
  const byName = NAME_HINTS.some((h) => lower.includes(h))
  // 文件名命中关键字 → 直接认定（与体积下限无关）；
  // 否则仅在「用户设置了体积下限」时才用 10MB 内部门槛兜底，避免把小压缩包误判。
  if (byName) return true
  return minSizeMb > 0 ? size >= BIG_ENOUGH : true
}

/**
 * 安装包流式扫描。
 * @param minSizeMb 体积下限（MB）
 * @param minDays   存放天数下限
 * @param drive     扫描范围：'' / 'all' = 所有盘符；'C' / 'D'… = 仅该盘符下的下载目录
 * @param onProgress 已扫描（检查过）的候选文件数回调，用于界面展示扫描速度
 */
export async function* scanInstallersStream(
  minSizeMb: number,
  minDays: number,
  isCancelled: () => boolean,
  drive = '',
  onProgress?: (n: number) => void,
): AsyncGenerator<InstallerItem[], void, unknown> {
  const minBytes = Math.max(minSizeMb, 0) * 1024 * 1024
  const cutoff = Date.now() - Math.max(minDays, 0) * 86400_000
  let scannedTotal = 0

  // 扫描根 + 递归深度：
  // - 系统盘 / 默认：用户下载类目录（deep 3，安装包基本都在浅层）；
  // - 其他盘：用户目录恒在系统盘，按盘符过滤下载目录必然得到空集 —— 这正是
  //   「其他盘有 zip 却扫不出来」的根因。改为直接扫该盘盘根（deep 8，与日志 /
  //   大文件的整盘扫描一致），安装包可能在盘内任意位置也能被找到；
  // - 全部磁盘：系统盘下载目录 + 所有非系统盘盘根。
  const sysLetter = systemDriveLetter()
  const downloadRoots = downloadDirs()
  const roots: Array<{ root: string; deep: number }> = []
  const d = (drive || '').trim()
  if (d && d !== 'all') {
    const up = d.toUpperCase().slice(0, 1)
    if (up === sysLetter) {
      for (const r of downloadRoots) roots.push({ root: r, deep: 3 })
    } else {
      roots.push({ root: `${up}:\\`, deep: 8 })
    }
  } else if (d === 'all') {
    for (const r of downloadRoots) roots.push({ root: r, deep: 3 })
    for (const letter of allDriveLetters()) {
      if (letter === sysLetter) continue
      roots.push({ root: `${letter}:\\`, deep: 8 })
    }
  } else {
    for (const r of downloadRoots) roots.push({ root: r, deep: 3 })
  }

  for (const { root, deep } of roots) {
    if (isCancelled()) return
    let batch: InstallerItem[] = []
    // ⚠️ 必须用 fg.stream 边遍历边产出：一次 `await fg()` 扫整盘要等几十秒才返回，
    // 期间前端一条结果都收不到，看起来就像「扫不出来」。
    const stream = fg.stream(`**/*.{${EXTS.join(',')}}`, {
      cwd: root,
      onlyFiles: true,
      dot: false,
      absolute: true,
      deep,
      suppressErrors: true,
    })
    try {
      for await (const entry of stream) {
        if (isCancelled()) return
        const p = String(entry)
        // 每检查 16 个候选文件回推一次「已扫描文件数」，让界面数字平滑跳动。
        scannedTotal++
        if (scannedTotal % 16 === 0) onProgress?.(scannedTotal)
        const st = statSafe(p)
        if (!st || !st.isFile()) continue
        if (st.size < minBytes) continue
        if (st.mtimeMs > cutoff) continue
        const name = path.basename(p)
        if (!isInstallerLike(name, st.size, minSizeMb)) continue
        batch.push({
          id: hashId(p),
          path: p,
          size: st.size,
          mtime: Math.round(st.mtimeMs),
          days: Math.floor((Date.now() - st.mtimeMs) / 86400_000),
          ext: path.extname(p).replace('.', '').toLowerCase(),
          byName: NAME_HINTS.some((h) => name.toLowerCase().includes(h)),
        })
        if (batch.length >= 40) {
          yield batch
          batch = []
          await new Promise((r) => setImmediate(r))
        }
      }
    } catch {
      /* 目录不可访问等：跳过该扫描根 */
    } finally {
      // 提前 return（取消）时销毁流，避免继续遍历整盘
      try {
        ;(stream as unknown as { destroy?: () => void }).destroy?.()
      } catch {
        /* ignore */
      }
    }
    if (batch.length) {
      yield batch
      await new Promise((r) => setImmediate(r))
    }
    // 每个扫描根结束时回推一次最终值（保证切换盘符时数字不倒退、不漏报）
    onProgress?.(scannedTotal)
  }
}

/** 删除安装包（默认回收站，purge 才永久删除）。 */
export async function deleteInstallers(
  items: Map<string, InstallerItem>,
  ids: string[],
  purge: boolean,
): Promise<CleanResult> {
  const result: CleanResult = {
    deleted_count: 0,
    deleted_size: 0,
    skipped: [],
    errors: [],
  }
  const audit: import('./model').CleanCandidate[] = []

  for (const id of ids) {
    const it = items.get(id)
    if (!it) {
      result.skipped.push({ id, path: '', reason: '条目不在本次扫描会话内' })
      continue
    }
    if (isProtected(it.path)) {
      result.skipped.push({ id, path: it.path, reason: '受保护路径，已拦截' })
      continue
    }
    const st = statSafe(it.path)
    if (!st || !st.isFile()) {
      result.skipped.push({ id, path: it.path, reason: '非文件或已不存在' })
      continue
    }
    try {
      if (purge) fs.unlinkSync(it.path)
      else await moveToRecycleBin(it.path)
      result.deleted_count += 1
      result.deleted_size += st.size
      audit.push({
        id,
        path: it.path,
        size: st.size,
        category: '安装包',
        rule_id: 'installer',
      })
    } catch (e) {
      result.errors.push(`${it.path}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (audit.length) logDeletion(audit, purge)
  return result
}
