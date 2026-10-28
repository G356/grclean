import fg from 'fast-glob'
import fs from 'fs'
import { type BigFileEntry } from './model'

const BATCH = 40
// 并发 stat 上限：消除旧版逐文件串行 fs.statSync 的瓶颈（事件循环被阻塞）。
// 注意：fast-glob 的 walkStream 在「盘根目录 + stats:true」下不产出（@nodelib/fs.walk 已知问题），
// 因此这里改用 walkStream 不带 stats（盘根可正常递归）+ 并发异步 stat 取体积。
const STAT_CONC = 64

// 常见用户数据目录：英文 + 中文（适配中文 Windows）各取首个存在的
const USER_FOLDER_CANDIDATES: Record<string, string[]> = {
  Desktop: ['Desktop', '桌面'],
  Documents: ['Documents', '文档'],
  Downloads: ['Downloads', '下载'],
  Pictures: ['Pictures', '图片'],
  Videos: ['Videos', '视频'],
  Music: ['Music', '音乐'],
}

/** 解析存在的用户数据目录（USERPROFILE 下的已知文件夹）。 */
export function userDirs(): string[] {
  const base = process.env.USERPROFILE || process.env.HOME || ''
  if (!base) return []
  const out: string[] = []
  for (const names of Object.values(USER_FOLDER_CANDIDATES)) {
    for (const name of names) {
      const p = `${base}\\${name}`
      if (fs.existsSync(p)) {
        out.push(p)
        break
      }
    }
  }
  return out
}

/** 枚举存在的本地磁盘根（A:~Z:），实现「全盘」分析。 */
export function allDrives(): string[] {
  const roots: string[] = []
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`
    try {
      if (fs.existsSync(root)) roots.push(root)
    } catch {
      /* 不可访问的盘符（如空软驱）直接跳过 */
    }
  }
  return roots
}

export interface BigFileScanOpts {
  /** 最小体积（字节） */
  minSize: number
  /** true=全部存在盘符；false=仅用户数据目录 */
  includeAll: boolean
  /** 指定单个盘符（如 'D'）时只扫描该盘根目录，优先级高于 includeAll */
  drive?: string
  /** 遍历进度回调：每累积一定文件数回推「已遍历文件总数」（含未达阈值的文件），用于前端展示扫描进度 */
  onScanned?: (total: number) => void
}

/**
 * 大文件流式扫描：async generator 逐批产出 BigFileEntry[]。
 *
 * 复用 junk 扫描的丝滑策略：fast-glob 异步 IO 不阻塞事件循环，每 40 条 yield 一批并
 * `setImmediate` 让权；主进程通过 IPC 把每批推给前端，前端逐行（unshift）增量显示。
 * 仅分析、不涉及删除。
 */
export async function* scanBigFilesStream(
  opts: BigFileScanOpts,
  isCancelled: () => boolean,
): AsyncGenerator<BigFileEntry[], void, unknown> {
  const roots = opts.drive
    ? [`${opts.drive}:\\`]
    : opts.includeAll
      ? allDrives()
      : userDirs()
  const minBytes = Math.max(opts.minSize, 1)
  // 跨盘根累计的遍历总数（含未达阈值的文件），用于向前端回推扫描进度。
  let scannedTotal = 0

  for (const root of roots) {
    if (isCancelled()) return
    if (!fs.existsSync(root)) continue

    // 流式遍历：walkStream 不带 stats（盘根可正常递归产出路径字符串）。
    // 体积由下方并发异步 stat 取得，避免逐文件串行 fs.statSync 阻塞事件循环。
    const stream = fg.stream('**/*', {
      cwd: root,
      onlyFiles: true,
      dot: false,
      suppressErrors: true,
      absolute: true,
      deep: 8,
    })

    let batch: BigFileEntry[] = []
    const tasks: Promise<void>[] = []
    const statOne = async (filePath: string) => {
      try {
        const st = await fs.promises.stat(filePath)
        if (st.isFile() && st.size >= minBytes) {
          batch.push({ path: filePath, size: st.size })
        }
      } catch {
        /* 权限不足 / 已不存在等忽略 */
      }
    }

    for await (const filePath of stream) {
      if (isCancelled()) return
      scannedTotal++
      tasks.push(statOne(String(filePath)))
      // 滑动窗口：攒满 STAT_CONC 个 stat 任务即并发执行完，再 flush 结果批次。
      // 这样既限制并发数（不会几万 stat 同时飞），又让遍历-统计流水线化。
      if (tasks.length >= STAT_CONC) {
        await Promise.all(tasks.splice(0))
        if (batch.length >= BATCH) {
          yield batch
          batch = []
          await new Promise((r) => setImmediate(r))
        }
      }
      // 每 16 个文件回推一次遍历总数，使扫描进度数字平滑跳动（让用户直观看到扫描速度）
      if (opts.onScanned && scannedTotal % 16 === 0) opts.onScanned(scannedTotal)
    }
    await Promise.all(tasks)
    if (opts.onScanned) opts.onScanned(scannedTotal)
    if (batch.length) {
      yield batch
      batch = []
    }
  }
}
