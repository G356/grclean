import fs from 'fs'
import {
  type CleanCandidate,
  type CleanResult,
} from './model'
import { isProtected } from './protected'
import { logDeletion } from './audit'
import { moveManyToRecycleBin } from './trash-bin'

/**
 * 通用删除核心（垃圾清理、重复文件、定时隐私清理共用）。
 *
 * 纵深防御：
 * 1. 仅接受候选 `id`，从会话反查真实路径，前端无法注入任意路径；
 * 2. 执行期再次校验 `isProtected`（受保护路径一律拦截）；
 * 3. 仅删除文件，目录跳过；
 * 4. 默认移入回收站（purge=false），purge=true 才永久删除；
 * 5. 删除成功者写入审计日志。
 */
export async function deleteCandidates(
  candidates: Map<string, CleanCandidate>,
  ids: string[] | null,
  purge: boolean,
  opts?: import('./protected').ProtectedOptions & {
    /** 每成功删除一批即回调（用于清理过程实时进度推送，批量回传以降低重渲染开销） */
    onDeleted?: (items: CleanCandidate[]) => void
    /**
     * 回收站模式（purge=false）下，若个别文件移入回收站失败（如所在卷无回收站、
     * 无窗口站/COM 受限），是否兜底改为直接永久删除。开启后「确认删除」的意图一定
     * 兑现，不会因回收站不可用而整批不动；仅当连 rm 也失败时仍计入 errors。
     */
    fallbackToPurge?: boolean
  },
): Promise<CleanResult> {
  const toDelete: CleanCandidate[] = ids
    ? ids
        .map((id) => candidates.get(id))
        .filter((c): c is CleanCandidate => !!c)
    : Array.from(candidates.values())

  const result: CleanResult = {
    deleted_count: 0,
    deleted_size: 0,
    skipped: [],
    errors: [],
    notes: [],
  }
  const deleted: CleanCandidate[] = []

  // 进度节流：以较小粒度回传，保证「已删除 N 条」实时随动，又不至于逐条 IPC 卡顿
  const progressBuf: CleanCandidate[] = []
  let lastFlush = Date.now()
  const flushProgress = (force = false) => {
    const now = Date.now()
    if (
      progressBuf.length > 0 &&
      (force || progressBuf.length >= 6 || now - lastFlush > 60)
    ) {
      opts?.onDeleted?.(progressBuf.splice(0, progressBuf.length))
      lastFlush = now
    }
  }

  // 先分类：受保护 / 目录 -> 跳过；其余按 purge 进入永久删除或回收站清单
  // （移入回收站改为批量传参给 windows-trash.exe，进程数从 N 降到 ⌈N/200⌉，
  //  这是原来逐条串行删除导致清理缓慢的根因）
  const recycleList: CleanCandidate[] = []
  const purgeList: CleanCandidate[] = []

  for (const c of toDelete) {
    // 防线：执行期再次校验受保护路径
    // （系统级清理项需本次显式勾选且路径落在声明目录内才放行）
    if (isProtected(c.path, opts)) {
      result.skipped.push({
        id: c.id,
        path: c.path,
        reason: '受保护路径，已拦截',
      })
      continue
    }
    // 快捷方式(.lnk)：扫描阶段已隐藏，这里再兜底——清理时自动跳过，不报错、不提示
    if (c.path.toLowerCase().endsWith('.lnk')) {
      result.skipped.push({
        id: c.id,
        path: c.path,
        reason: '快捷方式(.lnk)已排除',
      })
      continue
    }
    // 仅删文件，目录跳过（更安全）
    let isDir = false
    try {
      isDir = fs.statSync(c.path).isDirectory()
    } catch {
      /* 文件可能已不存在，下方删除会报错并记录 */
    }
    if (isDir) {
      result.skipped.push({
        id: c.id,
        path: c.path,
        reason: '不支持删除目录，已跳过',
      })
      continue
    }
    if (purge) purgeList.push(c)
    else recycleList.push(c)
  }

  // 永久删除：并发原生删除（限并发 8），远快于逐条同步 unlink；
  // 删前清只读属性 + maxRetries 抗瞬时占用，减少偶发失败。
  if (purgeList.length) {
    let pidx = 0
    const CONC = 8
    const worker = async () => {
      while (pidx < purgeList.length) {
        const c = purgeList[pidx++]
        try {
          try {
            await fs.promises.chmod(c.path, 0o666)
          } catch {
            /* 只读属性可能不可改，交 rm 重试兜底 */
          }
          await fs.promises.rm(c.path, {
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          })
          result.deleted_count += 1
          result.deleted_size += c.size
          deleted.push(c)
          progressBuf.push(c)
          flushProgress()
        } catch (e) {
          const code = (e as NodeJS.ErrnoException)?.code
          const msg = e instanceof Error ? e.message : String(e)
          // 被其他进程占用(EBUSY/ETXTBSY)或无权限(EPERM/EACCES)的文件：
          // 当前无法删除属正常现象（多为程序正在使用的临时/锁文件、已加载的模块等），
          // 归入「跳过」而非「失败」，避免清理结束弹出吓人的「N 项失败」提示。
          if (
            code === 'EBUSY' ||
            code === 'EPERM' ||
            code === 'EACCES' ||
            code === 'ETXTBSY' ||
            /busy|locked|permitted/i.test(msg)
          ) {
            result.skipped.push({
              id: c.id,
              path: c.path,
              reason: '使用中或无权访问，已跳过',
            })
          } else {
            result.errors.push(`${c.path}: ${msg}`)
          }
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONC, purgeList.length) }, () => worker()),
    )
  }

  // 回收站：批量传参给 windows-trash.exe（主路径一次进程处理一批；
  // 批量失败再逐条降级，保证进度/审计精确，不误报已成功项）。
  // 逐块回报进度：每成功一批即推入进度缓冲并刷新，使「已删除 N 条」随动。
  if (recycleList.length) {
    try {
      const pathToItem = new Map(recycleList.map((c) => [c.path, c]))
      const succeededPaths = new Set<string>()
      const { succeeded, failed } = await moveManyToRecycleBin(
        recycleList.map((c) => c.path),
        (batch) => {
          for (const p of batch) {
            const c = pathToItem.get(p)
            if (c && !succeededPaths.has(p)) {
              succeededPaths.add(p)
              result.deleted_count += 1
              result.deleted_size += c.size
              deleted.push(c)
              progressBuf.push(c)
              flushProgress()
            }
          }
        },
      )
      // 兜底：成功集合里尚未经 onBatch 计入的（极端时序）在此补齐
      for (const p of succeeded) {
        const c = pathToItem.get(p)
        if (c && !succeededPaths.has(p)) {
          succeededPaths.add(p)
          result.deleted_count += 1
          result.deleted_size += c.size
          deleted.push(c)
          progressBuf.push(c)
        }
      }
      // 回收站移动失败（逐条降级后仍失败）：开启了 fallbackToPurge 则兜底直接永久删除
      // （兑现删除意图）；否则原样计入 errors（文件保留，列表不变）。
      for (const f of failed) {
        if (opts?.fallbackToPurge) {
          try {
            await fs.promises.rm(f.path, {
              force: true,
              maxRetries: 3,
              retryDelay: 100,
            })
            const c = pathToItem.get(f.path)
            if (c) {
              result.deleted_count += 1
              result.deleted_size += c.size
              deleted.push(c)
              flushProgress()
            }
            result.notes?.push(`回收站不可用，${f.path} 已直接删除`)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            result.errors.push(`${f.path}: ${msg}`)
          }
        } else {
          result.errors.push(`${f.path}: ${f.error ?? '移入回收站失败'}`)
        }
      }
    } catch (e) {
      // 回收站机制「整体」失败（如 windows-trash.exe 缺失 / COM 受限 / PowerShell 也抛错）：
      // 此时 moveManyToRecycleBin 直接抛错、不会返回 failed 列表，原 fallback 逻辑收不到。
      // 开启 fallbackToPurge 时，把整批回收站项兜底为直接永久删除（force:true 对「已入回收站」的
      // 文件是安全空操作），确保「确认删除」的意图一定兑现；否则把真实错误计入 errors。
      const msg = e instanceof Error ? e.message : String(e)
      if (opts?.fallbackToPurge) {
        for (const c of recycleList) {
          try {
            try {
              await fs.promises.chmod(c.path, 0o666)
            } catch {
              /* 只读属性可能不可改，交 rm 重试兜底 */
            }
            await fs.promises.rm(c.path, {
              force: true,
              maxRetries: 3,
              retryDelay: 100,
            })
            result.deleted_count += 1
            result.deleted_size += c.size
            deleted.push(c)
            flushProgress()
          } catch (rmErr) {
            const rmMsg = rmErr instanceof Error ? rmErr.message : String(rmErr)
            result.errors.push(`${c.path}: ${rmMsg}`)
          }
        }
        result.notes?.push(`回收站不可用（${msg}），已改为直接删除`)
      } else {
        result.errors.push(`回收站删除失败：${msg}`)
      }
    }
  }

  // 收尾刷新剩余进度（永久删除 + 回收站成功项一次性回传）
  flushProgress(true)

  if (deleted.length) logDeletion(deleted, purge)
  return result
}
