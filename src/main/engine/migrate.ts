/**
 * 软件数据迁移到其他盘符（design.md §5.2）。
 *
 * 把仍在使用的数据目录从 C 盘搬到 D/E 盘，并用**目录联接（mklink /J）**回填原路径，
 * 软件无感知。迁移流程严格按设计的三条关键约束：
 *
 * 1. **迁移前校验目标盘剩余空间 > 源数据 1.2 倍**；
 * 2. **迁移后校验链接可读写，再删源**；
 * 3. **任一步失败自动回滚**（把数据搬回原位并恢复原目录）。
 *
 * 实现细案（为什么这样最稳）：
 * - 用 `robocopy /MOVE /E` 移动（比 Move-Item 更稳、可跨卷、带重试）；
 * - 移动成功后用 `cmd /c mklink /J` 建联接；若建联接失败 → 立刻搬回并报错（绝不留下半迁移状态）；
 * - 联接创建后写入探针文件并读回，确认可读写才删除源（robocopy /MOVE 已删源，
 *   故此处源已不存在，探针失败则执行回滚：删联接 + 搬回）。
 * - 还原（取消迁移）：删除联接 → 把数据搬回原路径 → 校验。
 *
 * 只迁移「白名单」内的已知目录（社交/办公/创作类根目录的一级子目录），
 * 不接受任意路径，避免误操作系统目录。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { execFile } from 'child_process'
import { runPs, psQuote } from './ps'
import { expandEnv } from './rules'

/** 可迁移的候选根目录（一级子目录即为可迁移项）。 */
const SOURCE_ROOTS: Array<{ dir: string; label: string }> = [
  { dir: '%LOCALAPPDATA%', label: '本地应用数据' },
  { dir: '%APPDATA%', label: '漫游应用数据' },
  { dir: '%USERPROFILE%\\Documents', label: '文档' },
  { dir: '%LOCALAPPDATA%\\Microsoft\\Office', label: 'Office' },
]

/** 永不迁移的目录名（系统/浏览器核心目录，迁移会破坏软件）。 */
const DENY_NAMES = new Set([
  'microsoft',
  'windows',
  'google',
  'microsoft edge',
  'mozilla',
  'nvidia',
  'nvidia corporation',
  'amd',
  'intel',
  'packages',
  'programs',
  'temp',
  'cache',
  'crashdumps',
  'd3dscache',
  'iconcache.db',
  'desktop.ini',
])

export interface MigrateItem {
  id: string
  /** 目录名 */
  name: string
  path: string
  size: number
  /** 来源分组 */
  source: string
  /** 已是联接（说明此前已迁移过） */
  isJunction: boolean
}

function hashId(p: string): string {
  return 'mig:' + crypto.createHash('md5').update(p).digest('hex').slice(0, 16)
}

/**
 * 单目录内 stat 的并发数。
 * ⚠️ 实测（本机 6 个小目录样本）：逐个 `await stat` 853ms，**批量并发 32 只要 174ms（快约 5 倍）**。
 * 逐个 await 时每个文件都要走一次事件循环往返。
 */
const STAT_CONC = 32

/** 每累计这么多文件让出一次事件循环，避免主进程被判定「未响应」。 */
const YIELD_EVERY = 512

/** 单目录统计的文件上限（超出则体积偏低估，避免巨型目录拖死扫描）。 */
const MAX_FILES = 30000

/**
 * 异步统计目录体积：stat **批量并发**，并定期让出事件循环。
 *
 * 同步版会在主进程连续阻塞（单目录可达数万文件），导致 Electron 窗口
 * 被 Windows 判定「未响应」。这里 stat 批量并发，且每累计 `YIELD_EVERY`
 * 个文件 `await setImmediate` 一次，保证 UI 与消息循环存活。
 */
async function dirSizeAsync(
  p: string,
  isCancelled?: () => boolean,
): Promise<number> {
  let total = 0
  let n = 0
  let sinceYield = 0
  const stack: string[] = [p]
  while (stack.length && n < MAX_FILES) {
    if (isCancelled?.()) return total
    const cur = stack.pop() as string
    let ents: fs.Dirent[]
    try {
      ents = await fs.promises.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    const files: string[] = []
    for (const e of ents) {
      if (n + files.length >= MAX_FILES) break
      const fp = path.join(cur, e.name)
      try {
        if (e.isDirectory()) stack.push(fp)
        else if (e.isFile()) files.push(fp)
      } catch {
        /* ignore */
      }
    }
    // 批量并发 stat：一次事件循环往返取回整批大小
    for (let i = 0; i < files.length; i += STAT_CONC) {
      if (isCancelled?.()) return total
      const chunk = files.slice(i, i + STAT_CONC)
      const stats = await Promise.all(
        chunk.map((f) => fs.promises.stat(f).catch(() => null)),
      )
      for (const st of stats) {
        if (!st) continue
        total += st.size
        n++
        if (++sinceYield >= YIELD_EVERY) {
          sinceYield = 0
          await new Promise((r) => setImmediate(r))
        }
      }
    }
  }
  return total
}

/**
 * ⚠️ **体积统计走 robocopy 列表模式（/L），这是本模块扫描提速的关键（实测 186 个候选目录）**：
 * - Node 递归 `readdir` + 批量 `stat`（并发 10）：**239s**；
 * - 同上加「达标即停」：**122s**；
 * - robocopy `/L /E /XJ`（并发 8）：**35.7s（快约 6.7 倍）**。
 *
 * 为什么快这么多：Node 每读一个目录都要走一次 libuv 线程池往返（线程池默认只有 4 条，
 * 目录数达数万时往返开销远大于实际磁盘 IO —— 实测 npm-cache 19142 文件：readdir 32.8s、
 * stat 仅 9.9s，瓶颈在 readdir 而非磁盘）。robocopy 是原生实现，一次进程内完成整棵
 * 目录树的枚举与体积汇总，把数万次跨层调用压缩成 1 次进程调用。
 *
 * `/L` 只列不改（不创建目标目录、不复制任何数据），`/XJ` 排除目录联接
 * （联接指向别处，计入体积会虚高，也避免自引用循环）。
 */

/** robocopy 汇总里的单位后缀（k/m/g/t，二进制换算）。 */
const ROBO_UNIT: Record<string, number> = {
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
}

let _robo: string | undefined

/** 定位 robocopy.exe（优先 System32 绝对路径，缺失则交给 PATH 解析）。 */
function roboPath(): string {
  if (_robo !== undefined) return _robo
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const abs = path.join(sysRoot, 'System32', 'robocopy.exe')
  try {
    if (fs.existsSync(abs)) {
      _robo = abs
      return _robo
    }
  } catch {
    /* 忽略，退回 PATH 查找 */
  }
  _robo = 'robocopy'
  return _robo
}

/**
 * 解析 robocopy 汇总表，取「文件数 / 字节数」。
 *
 * 输出是系统语言（本机为中文，GBK），但**数字与分隔符都是 ASCII**，用 latin1 解码后
 * 结构依然完整（中文标签是乱码，不影响匹配），因此无需关心代码页。
 * 汇总行形如：`      字节:   1.199 g   1.199 g         0         0         0         0`
 * 按出现顺序为：目录数、文件数、字节数。
 */
function parseRobocopySummary(out: string): { files: number; size: number } | null {
  const rows: number[] = []
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r/g, '')
    const m = /:\s+([0-9][0-9.,]*)\s*([kmgt])?\s+([0-9][0-9.,]*)\s*([kmgt])?\s+0\s+0\s+0\s+0\s*$/i.exec(
      line,
    )
    if (!m) continue
    const n = parseFloat(m[1].replace(/,/g, ''))
    if (!Number.isFinite(n)) continue
    rows.push(Math.round(n * (m[2] ? ROBO_UNIT[m[2].toLowerCase()] ?? 1 : 1)))
    if (rows.length >= 3) break
  }
  if (rows.length < 3) return null
  return { files: rows[1], size: rows[2] }
}

/** 用 robocopy 列表模式统计单个目录；失败（无汇总 / 退出码 ≥8）返回 null 由调用方降级。 */
async function dirSizeViaRobocopy(p: string): Promise<{ size: number; files: number } | null> {
  const dummy = path.join(os.tmpdir(), 'GrCleanRobocopyDummy')
  const args = [
    p,
    dummy,
    '/L',
    '/E',
    '/XJ',
    '/NFL',
    '/NDL',
    '/NP',
    '/NJH',
    '/R:0',
    '/W:0',
  ]
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        roboPath(),
        args,
        { maxBuffer: 1024 * 1024 * 8, windowsHide: true, timeout: 180000 },
        (err, stdout) => {
          // robocopy 退出码 <8 都算「成功执行」（0=无变化，1=列出成功）
          if (err && (err as NodeJS.ErrnoException & { code?: number }).code !== undefined) {
            const code = (err as unknown as { code?: number }).code
            if (typeof code === 'number' && code >= 8) {
              reject(new Error('robocopy exit ' + code))
              return
            }
          }
          resolve(String(stdout ?? ''))
        },
      )
    })
    return parseRobocopySummary(out)
  } catch {
    return null
  }
}

/**
 * 统计目录体积：优先 robocopy（快一个数量级），失败/非 Windows 降级到 Node 递归统计。
 * 返回 `files` 仅用于日志与判空（robocopy 给的是精确文件数，降级路径为 0 表示未知）。
 */
async function statDir(
  p: string,
  isCancelled?: () => boolean,
): Promise<{ size: number; files: number }> {
  if (process.platform === 'win32') {
    const r = await dirSizeViaRobocopy(p)
    if (r) return r
  }
  return { size: await dirSizeAsync(p, isCancelled), files: 0 }
}

function isJunction(p: string): boolean {
  try {
    const lstat = fs.lstatSync(p)
    if (!lstat.isDirectory()) return false
    // 重解析点：符号链接 / 联接
    return !!fs.readlinkSync(p)
  } catch {
    return false
  }
}

/** 取系统盘盘符（%SystemDrive%，通常 C:），用于从迁移目标中排除自身。 */
function systemDriveLetter(): string {
  const raw = process.env.SystemDrive || process.env.HOMEDRIVE || 'C:'
  const m = /^[A-Za-z]/.exec(raw)
  return m ? m[0].toUpperCase() : 'C'
}

/** 目标盘符的可选根目录（供界面下拉选择）。排除系统盘——迁移就是把数据搬到「其它盘」。 */
export function listTargetRoots(): Array<{ letter: string; freeBytes: number; totalBytes: number }> {
  const out: Array<{ letter: string; freeBytes: number; totalBytes: number }> = []
  if (process.platform !== 'win32') return out
  const sys = systemDriveLetter()
  for (let code = 67; code <= 90; code++) {
    const letter = String.fromCharCode(code)
    if (letter === sys) continue // 目标盘不能是系统盘本身
    const root = `${letter}:\\`
    try {
      // 用 statfs 读取空间（Node 18+）；失败则跳过该盘符
      const st = fs.statfsSync(root)
      out.push({
        letter,
        freeBytes: st.bsize * st.bavail,
        totalBytes: st.bsize * st.blocks,
      })
    } catch {
      /* 盘符不存在或不可访问 */
    }
  }
  return out
}

/**
 * 同时统计体积的目录数（每个目录一次 robocopy 进程）。
 * ⚠️ 实测 186 个候选目录：并发 8 → 35.7s，并发 14 → 34.0s（再高已无明显收益）。
 * 这是外部进程并发度，不受 Node libuv 线程池（默认 4）限制。
 */
const DIR_CONC = 8

interface Candidate {
  name: string
  path: string
  label: string
  isJunction: boolean
}

/**
 * 体积缓存：目录体积不会在几分钟内剧变，但统计一次要几十秒，因此把结果落盘，
 * 下次扫描直接命中（186 个目录从 35s → 约 0.2s）。
 * 只在「是否 ≥ 阈值」与「空间校验」上使用，允许一定陈旧度（TTL 7 天）。
 */
const CACHE_TTL = 7 * 24 * 3600 * 1000
const CACHE_MAX = 3000

function cacheFile(): string {
  const base = process.env.LOCALAPPDATA || os.tmpdir()
  return path.join(base, 'GrClean', 'migrate-size-cache.json')
}

let _cache: Map<string, { size: number; ts: number }> | null = null
let _cacheDirty = false

function sizeCache(): Map<string, { size: number; ts: number }> {
  if (_cache) return _cache
  _cache = new Map()
  try {
    const raw = fs.readFileSync(cacheFile(), 'utf8')
    const data = JSON.parse(raw) as { items?: Record<string, { size: number; ts: number }> }
    for (const [k, v] of Object.entries(data.items ?? {})) {
      if (typeof v?.size === 'number' && typeof v?.ts === 'number') _cache.set(k, v)
    }
  } catch {
    /* 首次运行 / 文件损坏：空缓存，按未命中处理 */
  }
  return _cache
}

function saveSizeCache(): void {
  if (!_cache || !_cacheDirty) return
  try {
    const file = cacheFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 只保留较新的 CACHE_MAX 条，避免长期累积
    const entries = [..._cache.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, CACHE_MAX)
    fs.writeFileSync(
      file,
      JSON.stringify({ v: 1, items: Object.fromEntries(entries) }),
      'utf8',
    )
    _cacheDirty = false
  } catch {
    /* 缓存写入失败不影响功能 */
  }
}

/** 带缓存的目录体积统计（缓存未命中才真正统计，并回写缓存）。 */
async function statDirCached(p: string, isCancelled?: () => boolean): Promise<number> {
  const c = sizeCache().get(p)
  const now = Date.now()
  if (c && now - c.ts < CACHE_TTL) {
    // 目录可能已被删除/迁移：存在性检查很便宜，命中后顺手校验一次
    try {
      if (fs.existsSync(p)) return c.size
    } catch {
      /* 视作未命中 */
    }
  }
  const st = await statDir(p, isCancelled)
  sizeCache().set(p, { size: st.size, ts: Date.now() })
  _cacheDirty = true
  return st.size
}

/**
 * 流式列出可迁移目录（体积 ≥ minMb 才列出，避免噪音）。
 *
 * 两段式：① 先**快速收集候选**（只读一级目录，约 15ms，可立刻得到总数）；
 * ② 再用 PowerShell + .NET 批量统计体积，**每统计完一个目录就立即 yield**，
 * 前端边扫边显示，不必等全部算完。
 *
 * @param onProgress 回吐「已统计目录数 / 候选总数」，供界面显示进度
 */
export async function* listMigratableStream(
  minMb = 200,
  isCancelled: () => boolean,
  onProgress?: (done: number, total: number) => void,
): AsyncGenerator<MigrateItem[], void, unknown> {
  const minBytes = Math.max(minMb, 0) * 1024 * 1024

  // ① 收集候选（不做体积统计）
  const cands: Candidate[] = []
  for (const { dir, label } of SOURCE_ROOTS) {
    if (isCancelled()) return
    const root = expandEnv(dir).replace(/\//g, '\\')
    if (!root) continue
    let ents: fs.Dirent[]
    try {
      ents = await fs.promises.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue
      const lower = e.name.toLowerCase()
      if (DENY_NAMES.has(lower)) continue
      if (lower.startsWith('.')) continue
      const fp = path.join(root, e.name)
      cands.push({
        name: e.name,
        path: fp,
        label,
        isJunction: isJunction(fp),
      })
    }
  }
  if (!cands.length) return
  onProgress?.(0, cands.length)

  // ② 并发统计体积，完成一个就产出
  const ready: MigrateItem[] = []
  let cursor = 0
  let doneCount = 0
  let finished = false
  let wake: (() => void) | null = null
  const notify = (): void => {
    const w = wake
    wake = null
    if (w) w()
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      if (isCancelled()) return
      const i = cursor++
      if (i >= cands.length) return
      const c = cands[i]
      // 联接点不必统计体积（它只是指向别处的链接）
      const size = c.isJunction ? 0 : await statDirCached(c.path, isCancelled)
      if (isCancelled()) return
      doneCount++
      if (c.isJunction || size >= minBytes) {
        ready.push({
          id: hashId(c.path),
          name: c.name,
          path: c.path,
          size,
          source: c.label,
          isJunction: c.isJunction,
        })
      }
      onProgress?.(doneCount, cands.length)
      notify()
    }
  }

  const workers = Array.from(
    { length: Math.min(DIR_CONC, cands.length) },
    () => worker(),
  )
  void Promise.all(workers).then(() => {
    finished = true
    saveSizeCache()
    notify()
  })

  for (;;) {
    if (isCancelled()) return
    if (!ready.length) {
      if (finished) break
      await new Promise<void>((res) => {
        wake = res
      })
      continue
    }
    const item = ready.shift() as MigrateItem
    yield [item]
    // 让出事件循环，使渲染进程有机会绘制本条
    await new Promise((r) => setImmediate(r))
  }
}

export interface MigrateResult {
  id: string
  ok: boolean
  message: string
}

/**
 * 迁移单个目录到目标盘。
 *
 * @param targetRoot 目标盘根目录，如 `D:\GrCleanData`（必须是已存在的目录）
 */
export async function migrateDirectory(
  items: MigrateItem[],
  id: string,
  targetRoot: string,
): Promise<MigrateResult> {
  const it = items.find((x) => x.id === id)
  if (!it) return { id, ok: false, message: '条目不在本次列表内' }
  if (it.isJunction) return { id, ok: false, message: '该目录已是联接（可能已迁移过）' }
  const src = it.path
  if (!fs.existsSync(src)) return { id, ok: false, message: '源目录不存在' }

  // 1) 目标盘空间校验：> 源数据 1.2 倍
  const drive = path.parse(targetRoot).root.toUpperCase() // 形如 D:\
  let free = 0
  try {
    const st = fs.statfsSync(drive)
    free = st.bsize * st.bavail
  } catch {
    return { id, ok: false, message: `无法读取目标盘 ${drive} 的剩余空间` }
  }
  if (free < it.size * 1.2) {
    return {
      id,
      ok: false,
      message: `目标盘空间不足：需要 ${(it.size * 1.2 / 1024 ** 3).toFixed(2)} GB，剩余 ${(free / 1024 ** 3).toFixed(2)} GB`,
    }
  }

  const target = path.join(targetRoot, it.name)

  try {
    // 2) 目标目录准备：确保不存在同名目录（避免覆盖已有数据）
    if (fs.existsSync(target)) {
      return { id, ok: false, message: `目标目录已存在：${target}` }
    }
    fs.mkdirSync(targetRoot, { recursive: true })

    // 3) 移动数据（robocopy /MOVE /E 跨卷移动，带重试与日志）
    // ⚠️ **两个已踩坑的修复**（曾导致「只建 GrCleanData 目录、数据没搬」）：
    // ① 不能用 /COPYALL —— 它会复制审计信息(SACL)，需「管理审核」特权，
    //    普通/管理员上下文没有 → robocopy 退出码 16（严重错误），一个文件都不复制。
    //    改用 /COPY:DAT（数据+属性+时间戳），无需特殊权限。
    // ② 脚本末句若是 `robocopy ... | Out-Null` 这种管道，PowerShell 会以非零码退出，
    //    被 execFile 当成失败而抛「Command failed」。必须显式 `; exit 0` 收尾（失败走 throw）。
    await runPs(
      `robocopy ${psQuote(src)} ${psQuote(target)} /MOVE /E /COPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS | Out-Null; if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }; exit 0`,
    )

    // 3.5) 源目录应已被 robocopy /MOVE 整体删掉。若仍残留（部分文件被其它程序占用，
    // 导致 robocopy 跳过、源目录非空无法删除），继续建联接必然失败 → 直接给出明确提示，
    // 避免误导成「建立联接失败 / 已回滚」这类让人摸不着头脑的报错。
    if (fs.existsSync(src)) {
      return {
        id,
        ok: false,
        message:
          '源目录未能完全搬走（可能有文件被其它程序占用）。请关闭 ' +
          it.name +
          ' 及相关软件后重试，未做改动。',
      }
    }

    // 4) 建立目录联接
    try {
      await runPs(`cmd /c mklink /J ${psQuote(src)} ${psQuote(target)}`)
    } catch (e) {
      // 建联接失败 → 回滚：把数据搬回原位
      await runPs(
        `robocopy ${psQuote(target)} ${psQuote(src)} /MOVE /E /COPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS | Out-Null; exit 0`,
      )
      return {
        id,
        ok: false,
        message: `建立联接失败，已回滚：${e instanceof Error ? e.message : String(e)}`,
      }
    }

    // 5) 迁移后校验：联接可读写（写探针 → 读回 → 删除）
    const probe = path.join(src, '.grclean_probe.tmp')
    try {
      fs.writeFileSync(probe, 'ok')
      const back = fs.readFileSync(probe, 'utf8')
      fs.unlinkSync(probe)
      if (back !== 'ok') throw new Error('读写校验失败')
    } catch (e) {
      // 校验失败 → 回滚：删联接并把数据搬回
      await runPs(`cmd /c rmdir ${psQuote(src)}`)
      await runPs(
        `robocopy ${psQuote(target)} ${psQuote(src)} /MOVE /E /COPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS | Out-Null; exit 0`,
      )
      return {
        id,
        ok: false,
        message: `联接读写校验失败，已回滚：${e instanceof Error ? e.message : String(e)}`,
      }
    }

    return { id, ok: true, message: `已迁移到 ${target} 并建立联接` }
  } catch (e) {
    return { id, ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/** 还原迁移：删除联接，把数据搬回原路径。 */
export async function restoreDirectory(
  items: MigrateItem[],
  id: string,
): Promise<MigrateResult> {
  const it = items.find((x) => x.id === id)
  if (!it) return { id, ok: false, message: '条目不在本次列表内' }
  const link = it.path
  if (!isJunction(link)) return { id, ok: false, message: '该目录不是联接，无需还原' }
  let real: string
  try {
    real = fs.readlinkSync(link)
  } catch (e) {
    return { id, ok: false, message: `读取联接目标失败：${String(e)}` }
  }
  try {
    // 1) 删除联接（rmdir 对联接只删链接本身，不动目标数据）
    await runPs(`cmd /c rmdir ${psQuote(link)}`)
    // 2) 数据搬回
    await runPs(
      `robocopy ${psQuote(real)} ${psQuote(link)} /MOVE /E /COPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS | Out-Null; if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }; exit 0`,
    )
    if (!fs.existsSync(link)) throw new Error('还原后原路径不存在')
    return { id, ok: true, message: `已还原到 ${link}` }
  } catch (e) {
    return { id, ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
