import crypto from 'crypto'
import fg from 'fast-glob'
import fs from 'fs'
import { type DuplicateGroup } from './model'
import { userDirs, allDrives } from './bigfile'
import { hashFilesConcurrently, headerHashFilesConcurrently } from './hash-pool'

/**
 * 重复扫描的目录忽略清单（与垃圾清理"非系统盘忽略系统目录"约定一致）：
 * 这些目录基本不存在用户想清理的大重复文件，跳过可省掉海量枚举、数倍提速。
 * - 系统目录：$Recycle.Bin / System Volume Information / Windows / WinSxS /
 *   ProgramData / Program Files / Program Files (x86) / Recovery / $WinREAgent
 * - 开发缓存：node_modules / .git / .svn（重装可得，体积大、枚举极慢）
 */
const TOP_SKIP = new Set([
  '$recycle.bin', 'system volume information', 'windows', 'winxs',
  'program files', 'program files (x86)', 'programdata', 'recovery', '$winreagent',
  'node_modules', '.git', '.svn',
])
const DUP_IGNORE = [
  '**/node_modules/**', '**/.git/**', '**/.svn/**',
  '**/$Recycle.Bin/**', '**/System Volume Information/**',
  '**/Windows/**', '**/WinSxS/**', '**/ProgramData/**',
  '**/Program Files/**', '**/Program Files (x86)/**', '**/AppData/**',
  '**/Recovery/**', '**/$WinREAgent/**',
]

const HEADER_BYTES = 4096
const TAIL_BYTES = 4096

/** 由路径生成稳定 id（同一文件每次扫描 id 相同，便于前端维持勾选状态）。 */
function hashId(p: string): string {
  return crypto.createHash('md5').update(p.toLowerCase()).digest('hex')
}

/** 头部哈希预筛：读文件头 4KB + 尾 4KB 做 SHA-256，快速排除「大小相同但内容不同」。 */
function headerHash(path: string): string | null {
  let fd: number
  try {
    fd = fs.openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const total = fs.fstatSync(fd).size
    let buf = Buffer.alloc(0)
    const headLen = Math.min(HEADER_BYTES, total)
    if (headLen > 0) {
      const head = Buffer.alloc(headLen)
      fs.readSync(fd, head, 0, headLen, 0)
      buf = Buffer.concat([buf, head])
    }
    if (total > HEADER_BYTES + TAIL_BYTES) {
      const tail = Buffer.alloc(TAIL_BYTES)
      fs.readSync(fd, tail, 0, TAIL_BYTES, total - TAIL_BYTES)
      buf = Buffer.concat([buf, tail])
    }
    return crypto.createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* 关闭失败忽略 */
    }
  }
}

/** 全量哈希：流式读取整个文件计算 SHA-256，作为重复判定的最终依据。 */
function fullHash(path: string): string | null {
  let fd: number
  try {
    fd = fs.openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const h = crypto.createHash('sha256')
    const buf = Buffer.alloc(65536)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
    }
    return h.digest('hex')
  } catch {
    return null
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* 关闭失败忽略 */
    }
  }
}

export interface DupScanOpts {
  /** 最小文件体积（MB），过滤极小文件以降低噪音 */
  minMb: number
  /** 自定义扫描目录；为空则按 drive 决定扫描范围 */
  dirs?: string[] | null
  /** 扫描盘符：''=默认用户数据目录；'all'=全部盘符；'C'/'D'…=仅该盘根目录 */
  drive?: string
}

/** 流式事件：progress=哈希进度（已处理文件数）；group=新发现的重复组。 */
export type DupScanEvent =
  | { type: 'progress'; n: number }
  | { type: 'group'; group: DuplicateGroup }

/**
 * 重复文件扫描（三级筛选：大小 → 头部哈希 → 全量 SHA-256）。
 *
 * 与垃圾清理/大文件同构：async generator 逐步产出事件；fast-glob 收集阶段不阻塞
 * 事件循环，哈希阶段每处理若干文件 `setImmediate` 让权，保证 UI 不卡顿、可随时取消。
 * 每构建出一个重复组即 yield，前端「边扫边显示」逐组从上方插入。
 */
export async function* scanDuplicatesStream(
  opts: DupScanOpts,
  isCancelled: () => boolean,
): AsyncGenerator<DupScanEvent, void, unknown> {
  const minBytes = Math.max(opts.minMb, 0) * 1024 * 1024
  let roots: string[]
  if (opts.dirs && opts.dirs.length) {
    roots = opts.dirs
  } else if (opts.drive === 'all') {
    roots = allDrives()
  } else if (opts.drive) {
    roots = [`${opts.drive.toUpperCase()}:\\`]
  } else {
    roots = userDirs()
  }
  if (!roots.length) return

  // 1) 收集文件：每个根目录按顶层子目录并发扫描（IO 重叠），并对系统/缓存类目录走
  //    ignore 跳过（见 TOP_SKIP / DUP_IGNORE），避免枚举海量无关文件。枚举期间周期
  //    yield 'progress' 让 UI 显示实时进度，避免长时间枚举看似卡死。
  const t0 = Date.now()
  const files: Array<{ path: string; size: number }> = []
  const scanState = { scanned: 0, matched: 0 }
  const SUB_LIMIT = 8
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    // 列顶层条目：文件直接判定；目录作为并发单元（跳过 TOP_SKIP 系统/缓存目录）
    let top: fs.Dirent[]
    try {
      top = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    const subdirs: string[] = []
    for (const d of top) {
      if (isCancelled()) break
      const full = root.replace(/[\\/]+$/, '') + '\\' + d.name
      if (d.isDirectory()) {
        if (TOP_SKIP.has(d.name.toLowerCase())) continue
        subdirs.push(full)
      } else if (d.isFile()) {
        let st: fs.Stats | undefined
        try {
          st = fs.statSync(full)
        } catch {
          continue
        }
        if (!st) continue
        scanState.scanned++
        // 根目录顶层可能直接堆着大量文件（如 C:\Windows\Fonts），此循环是同步的，
        // 若不在此回推，整段会一次性跳完、看起来像「一千一千加」。每 16 个回推一次。
        if (scanState.scanned % 16 === 0) {
          yield { type: 'progress', n: scanState.scanned }
        }
        if (st.size >= minBytes) {
          scanState.matched++
          files.push({ path: full, size: st.size })
        }
      }
    }
    if (isCancelled()) return
    // 并发扫描各顶层子目录（共享队列，限 SUB_LIMIT 路）
    let qi = 0
    let doneWorkers = 0
    const totalWorkers = Math.min(SUB_LIMIT, subdirs.length)
    const worker = async () => {
      try {
        for (;;) {
          const i = qi++
          if (i >= subdirs.length) break
          if (isCancelled()) return
          const stream = fg.stream('**/*', {
            cwd: subdirs[i],
            onlyFiles: true,
            dot: false,
            suppressErrors: true,
            absolute: true,
            deep: 16,
            ignore: DUP_IGNORE,
          })
          for await (const entry of stream) {
            if (isCancelled()) return
            const p = String(entry)
            let st: fs.Stats | undefined
            try {
              st = fs.statSync(p)
            } catch {
              continue
            }
            if (!st || !st.isFile()) continue
            scanState.scanned++
            if (st.size >= minBytes) {
              scanState.matched++
              files.push({ path: p, size: st.size })
            }
          }
        }
      } finally {
        doneWorkers++
      }
    }
    const workers: Promise<void>[] = []
    for (let k = 0; k < totalWorkers; k++) workers.push(worker())
    // 枚举期间按「已扫描文件数」周期上报（每 16 个一次），让界面数字平滑跳动。
    // 用 setImmediate 让权而非定时器：每个事件循环轮次 worker 只推进少量文件，
    // 因此上报粒度接近真实的「每 16 个一次」，不再成段大跳（此前每 400ms 才报一次，
    // 枚举快时一次跳几千，看起来像「一千一千加」）。
    let lastReported = 0
    for (;;) {
      if (doneWorkers >= totalWorkers) break
      if (scanState.scanned - lastReported >= 16) {
        lastReported = scanState.scanned
        yield { type: 'progress', n: scanState.scanned }
      }
      await new Promise((r) => setImmediate(r))
    }
    await Promise.all(workers)
    yield { type: 'progress', n: scanState.scanned }
  }
  const tCollect = Date.now()
  console.log(`[dup] collected ${files.length} files >= ${minBytes} bytes from ${roots.length} root(s) in ${tCollect - t0}ms`)
  if (isCancelled()) return
  if (!files.length) return

  // 2) 按大小分组，仅保留 >= 2 个的组
  const bySize = new Map<number, Array<{ path: string; size: number }>>()
  for (const f of files) {
    if (f.size === 0) continue
    const arr = bySize.get(f.size)
    if (arr) arr.push(f)
    else bySize.set(f.size, [f])
  }
  const sizeGroups = Array.from(bySize.values()).filter((g) => g.length >= 2)
  const sizeFiles = sizeGroups.reduce((a, g) => a + g.length, 0)
  console.log(`[dup] size-groups=${sizeGroups.length} (${sizeFiles} files) in ${Date.now() - tCollect}ms`)
  if (!sizeGroups.length) return

  // 3) 头部哈希预筛（4KB 头 + 4KB 尾），按 (size, header) 分组。
  //    ⚠️ 改用并发线程池：原串行 openSync/readSync 逐文件阻塞，HDD 上随机小读极慢。
  //    并发 16 路 IO 重叠后，大量候选文件的预筛耗时大幅下降。
  const byHeader = new Map<string, Array<{ path: string; size: number }>>()
  let headerFellBack = false
  const flatSize = sizeGroups.flat()
  if (flatSize.length) {
    try {
      const results = await headerHashFilesConcurrently(
        flatSize.map((f) => ({ path: f.path })),
        { isCancelled },
      )
      const sizeByPath = new Map(flatSize.map((f) => [f.path, f.size]))
      let anyHeader = false
      for (const r of results) {
        const size = sizeByPath.get(r.path)
        if (size === undefined) continue
        if (r.hash) {
          anyHeader = true
          const key = `${size}:${r.hash}`
          const arr = byHeader.get(key)
          if (arr) arr.push({ path: r.path, size })
          else byHeader.set(key, [{ path: r.path, size }])
        }
      }
      // 线程池“静默”返回全空哈希（Electron 某些环境下 worker 不抛错却算不出
      // 哈希）时，主动抛错回退到主进程串行，保证结果正确、绝不为 0。
      if (!anyHeader && flatSize.length) throw new Error('header pool returned no valid hashes')
    } catch {
      headerFellBack = true
      // 线程池不可用时的回退：原串行 headerHash（保留取消检查与让权）
      let processed = 0
      for (const g of sizeGroups) {
        for (const f of g) {
          if (isCancelled()) return
          const h = headerHash(f.path)
          if (h) {
            const key = `${f.size}:${h}`
            const arr = byHeader.get(key)
            if (arr) arr.push(f)
            else byHeader.set(key, [f])
          }
          if (++processed % 20 === 0) await new Promise((r) => setImmediate(r))
        }
      }
    }
  }
  if (isCancelled()) return
  const headerGroups = Array.from(byHeader.values()).filter((g) => g.length >= 2)
  console.log(`[dup] header-groups=${headerGroups.length} in ${Date.now() - tCollect}ms (fallback=${headerFellBack})`)
  if (!headerGroups.length) return

  // 4) 全量 SHA-256 确认（并发线程池加速；线程池不可用时回退同步）
  const flat = headerGroups.flat()
  const totalToHash = flat.length
  yield { type: 'progress', n: totalToHash }
  const byFull = new Map<string, Array<{ path: string; size: number }>>()
  let poolOk = true
  try {
    const results = await hashFilesConcurrently(
      flat.map((f) => ({ path: f.path })),
      { isCancelled },
    )
    const sizeByPath = new Map(flat.map((f) => [f.path, f.size]))
    let anyFull = false
    for (const r of results) {
      const size = sizeByPath.get(r.path)
      if (size === undefined) continue
      if (r.hash) {
        anyFull = true
        const arr = byFull.get(r.hash)
        if (arr) arr.push({ path: r.path, size })
        else byFull.set(r.hash, [{ path: r.path, size }])
      }
    }
    // 线程池静默返回全空哈希时主动回退主进程串行，确保结果正确。
    if (!anyFull && flat.length) throw new Error('full pool returned no valid hashes')
  } catch {
    poolOk = false
  }
  if (poolOk) {
    yield { type: 'progress', n: totalToHash }
  } else {
    // 回退：原串行逻辑（保留进度上报与取消检查）
    let done = 0
    for (const g of headerGroups) {
      for (const f of g) {
        if (isCancelled()) return
        const h = fullHash(f.path)
        done += 1
        if (done % 10 === 0 || done === totalToHash) {
          yield { type: 'progress', n: done }
        }
        if (h) {
          const arr = byFull.get(h)
          if (arr) arr.push(f)
          else byFull.set(h, [f])
        }
        await new Promise((r) => setImmediate(r))
      }
    }
  }
  if (isCancelled()) return
  console.log(`[dup] full-hash done in ${Date.now() - tCollect}ms (poolOk=${poolOk})`)

  // 5) 构建重复组并逐组产出（前端边扫边显示）
  let totalGroups = 0
  for (const fv2 of byFull.values()) if (fv2.length >= 2) totalGroups++
  console.log(`[dup] grouped ${totalGroups} duplicate groups in ${Date.now() - t0}ms total`)
  for (const [hash, fv] of byFull) {
    if (fv.length < 2) continue
    const size = fv[0].size
    const count = fv.length
    const group: DuplicateGroup = {
      group_id: hash,
      hash,
      size,
      count,
      wasted: size * (count - 1),
      files: fv.map((f) => ({ id: hashId(f.path), path: f.path, size: f.size })),
    }
    yield { type: 'group', group }
    await new Promise((r) => setImmediate(r))
  }
}
