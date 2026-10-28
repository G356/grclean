import fs from 'node:fs'
import { runPs, parseJsonArray, psQuote } from './ps'
import { createHash } from 'crypto'

/** 一条回收站内文件的元数据（真实路径由主进程持有，前端只传 id 反查）。 */
export interface RecycleEntry {
  /** 主进程生成的稳定 id（基于 $R 真实路径哈希） */
  id: string
  /** 真实 $R 数据项路径（文件或目录），删除用 */
  rPath: string
  /** 对应的 $I 信息文件路径（可能不存在），删除时一并清理 */
  iPath: string
  /** 原始文件名（如 report.docx） */
  name: string
  /** 原始所在目录（去掉文件名） */
  originalDir: string
  /** 原始完整路径 */
  originalPath: string
  /** 占用体积（字节）：文件取真实大小，目录递归求和 */
  size: number
  /** 删除时间（本地 yyyy-MM-dd HH:mm），解析失败为空串 */
  deletedAt: string
}

export interface RecycleDeleteResult {
  rPath: string
  ok: boolean
  error: string
}

// 复用的 PowerShell 辅助：判断是否为「文件不存在」类错误（坏项/孤儿条目，视为已清理）
const IS_NOT_FOUND_FN = `
function IsNotFound($ex) {
  $h = [int]$ex.Exception.HResult
  if ($h -eq 0x80070002) { return $true }
  $m = [string]$ex.Exception.Message
  if ($m -match 'cannot find the file specified' -or $m -match '系统找不到指定的文件') { return $true }
  return $false
}
`

function hashId(rPath: string): string {
  return 'rec:' + createHash('sha1').update(rPath).digest('hex').slice(0, 16)
}

/**
 * 枚举本机所有本地盘上、当前用户自己的回收站目录，逐条返回回收站内的文件/目录。
 *
 * 为什么按「当前用户 SID」聚合、而非整个 `$Recycle.Bin`：
 * - Windows 回收站按用户隔离，每个用户在 `$Recycle.Bin` 下有一个以自己 SID 命名的子目录；
 * - 只处理当前登录用户自己的回收站，既不越权碰别人数据，也不需要管理员权限。
 *
 * 每条解析 `$I` 信息文件得到：原始文件名、原始位置、删除时间；体积：文件取真实大小，
 * 目录递归求和（与资源管理器展示一致）。孤儿条目（$I 缺失或信息读不出）兜底用 `$R` 名。
 */
export async function recycleBinList(): Promise<RecycleEntry[]> {
  const script = `
${IS_NOT_FOUND_FN}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$out = @()
$drives = @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -match '^[A-Z]:\\\\$' } | Select-Object -ExpandProperty Name)
foreach ($d in $drives) {
  $rb = Join-Path -Path ($d + ':') -ChildPath '$Recycle.Bin' | ForEach-Object { Join-Path $_ $sid }
  if (-not (Test-Path -LiteralPath $rb -ErrorAction SilentlyContinue)) { continue }
  $rs = @(Get-ChildItem -LiteralPath $rb -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '$R*' })
  foreach ($r in $rs) {
    $iname = '$I' + $r.Name.Substring(2)
    $ip = Join-Path -Path $rb -ChildPath $iname
    $size = 0
    if ($r.PSIsContainer) {
      $sum = (Get-ChildItem -LiteralPath $r.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
      $size = [int64]($sum)
      if (-not $size) { $size = 0 }
    } else { $size = [int64]$r.Length }
    $originalPath = $r.FullName
    $deletedAt = ''
    if (Test-Path -LiteralPath $ip -ErrorAction SilentlyContinue) {
      try {
        $bytes = [System.IO.File]::ReadAllBytes($ip)
        if ($bytes.Length -ge 28) {
          $sizeFromI = [BitConverter]::ToInt64($bytes, 8)
          if ($sizeFromI -gt 0 -and -not $r.PSIsContainer) { $size = [int64]$sizeFromI }
          $ft = [BitConverter]::ToInt64($bytes, 16)
          if ($ft -gt 0) { $deletedAt = ([datetime]::FromFileTime($ft)).ToString('yyyy-MM-dd HH:mm') }
          # version 2（Win10/11）：$I 偏移 24-27 为路径长度(DWORD)，真实路径从 28 开始；
          # 旧版(version 0/1)无长度字段，路径从 24 开始
          $ver = [BitConverter]::ToInt32($bytes, 0)
          $pstart = 28
          if ($ver -ne 2) { $pstart = 24 }
          $plen = $bytes.Length - $pstart
          while ($plen -gt 2 -and [BitConverter]::ToUInt16($bytes, $pstart + $plen - 2) -eq 0) { $plen -= 2 }
          if ($plen -gt 0) { $originalPath = [System.Text.Encoding]::Unicode.GetString($bytes, $pstart, $plen) }
        }
      } catch { }
    }
    $fileName = ''
    $dir = ''
    try {
      $fileName = Split-Path -Leaf -Path $originalPath
      $dir = Split-Path -Parent -Path $originalPath
    } catch { }
    if (-not $fileName) { $fileName = $r.Name }
    $out += [PSCustomObject]@{
      rPath = $r.FullName
      iPath = $ip
      name = $fileName
      originalDir = $dir
      originalPath = $originalPath
      size = $size
      deletedAt = $deletedAt
    }
  }
}
ConvertTo-Json -InputObject $out -Compress
`.trim()

  try {
    const parsed = parseJsonArray(await runPs(script))
    return parsed
      .map((e: any) => ({
        id: hashId(String(e.rPath ?? '')),
        rPath: String(e.rPath ?? ''),
        iPath: String(e.iPath ?? ''),
        name: String(e.name ?? ''),
        originalDir: String(e.originalDir ?? ''),
        originalPath: String(e.originalPath ?? ''),
        size: Number(e.size ?? 0),
        deletedAt: String(e.deletedAt ?? ''),
      }))
      // 过滤快捷方式（.lnk）：回收站内已删的快捷方式清理无收益，且常因只读/占用删除失败；
      // 按用户要求扫描即隐藏，删除阶段不会再接收这些条目，自然不会提示失败。
      .filter((e) => !e.name.toLowerCase().endsWith('.lnk'))
  } catch {
    return []
  }
}

/**
 * 彻底删除指定回收站条目（传入的 $R/$I 真实路径）。因为条目已在回收站内，
 * 删除即「永久删除」，不走回收站二次中转。
 *
 * 实现要点（相比原 PowerShell 整批方案）：
 * - 不再每条/每批 spawn `powershell.exe`（进程开销大、条目多时明显变慢），改用
 *   Node 原生 `fs.promises.rm` 并发删除（限并发 RECYCLE_DELETE_CONCURRENCY），
 *   无进程开销、速度显著提升。
 * - 删前先尽力清除「只读」属性（Windows 回收站项常见，否则 DeleteFile 会 EPERM），
 *   并开启 `maxRetries` 抗「文件被 Explorer 瞬时占用」类拒绝访问，大幅减少偶发失败。
 * - 仅当本进程提权运行、且仍被 ACL 拒绝时，才对单个顽固条目做一次
 *   `takeown`+`icacls` 提权恢复后重试（范围精确到该文件，不影响其他删除、不阻塞整体）。
 * - 元数据 $I 一并清理（失败不计入主结果，避免误报）。
 * - 进度按 64 条批量回调（onBatch），与调用方「按索引对齐」的约定保持一致（out 预分配、按 i 写入）。
 */
const RECYCLE_DELETE_CONCURRENCY = 12

function errMsgFrom(e: unknown): string {
  const code = e && typeof e === 'object' ? (e as { code?: string }).code : undefined
  if (code) return `${code}: ${e instanceof Error ? e.message : String(e)}`
  return e instanceof Error ? e.message : String(e)
}

function isAccessDenied(e: unknown): boolean {
  const code = e && typeof e === 'object' ? (e as { code?: string }).code : undefined
  return code === 'EPERM' || code === 'EACCES'
}

/** 提权恢复单个文件的 ACL 后删除（仅提权运行时、且仅对顽固拒绝访问的条目调用一次）。 */
async function recoverAclAndDelete(rPath: string): Promise<void> {
  const script = `
takeown /f ${psQuote(rPath)} /a >$null 2>&1
icacls ${psQuote(rPath)} /grant "*S-1-5-32-544:(F)" /q >$null 2>&1
if (Test-Path -LiteralPath ${psQuote(rPath)}) { Remove-Item -LiteralPath ${psQuote(rPath)} -Recurse -Force -ErrorAction Stop }
`.trim()
  await runPs(script)
}

/**
 * 删除单个回收站条目（$R 数据项 + $I 元数据）。
 * 返回是否成功（以 $R 是否仍在原位置判定），失败原因仅来自 $R 删除。
 */
async function removeRecycleEntry(
  rPath: string,
  iPath: string,
): Promise<{ ok: boolean; error: string }> {
  let err = ''
  const rmWithClear = async (p: string, recursive: boolean) => {
    // 先清只读属性（Node chmod 在 Windows 仅映射 READONLY 位），避免 EPERM
    try {
      await fs.promises.chmod(p, 0o666)
    } catch {
      /* 属性可能不可改，交 rm 重试兜底 */
    }
    await fs.promises.rm(p, {
      recursive,
      force: true,
      maxRetries: 5,
      retryDelay: 120,
    })
  }
  try {
    await rmWithClear(rPath, true)
  } catch (e) {
    err = errMsgFrom(e)
    // 顽固拒绝访问 + 当前进程提权：对单文件提权恢复后重试一次
    if (isAccessDenied(e) && (process as any).isElevated === true) {
      try {
        await recoverAclAndDelete(rPath)
        err = ''
      } catch (e2) {
        err = errMsgFrom(e2)
      }
    }
  }
  // 元数据 $I 一并清理（失败不计入主错误）
  if (iPath) {
    try {
      await fs.promises.chmod(iPath, 0o666)
    } catch {
      /* ignore */
    }
    try {
      await fs.promises.rm(iPath, { force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      /* 元数据清理失败不影响已删数据项 */
    }
  }
  // 以 $R 是否仍在原位置判定成败
  let ok = false
  try {
    await fs.promises.access(rPath)
    ok = false // 仍在，失败
  } catch {
    ok = true // 已不在，成功
  }
  return { ok, error: ok ? '' : err }
}

export async function deleteRecycleEntries(
  entries: Array<{ rPath: string; iPath: string }>,
  onBatch?: (
    batchResults: RecycleDeleteResult[],
    batchEntries: Array<{ rPath: string; iPath: string }>,
  ) => void,
): Promise<RecycleDeleteResult[]> {
  if (!entries.length) return []
  // 预分配并按索引写入，保证返回顺序与 entries 对齐（调用方按 res[idx] 反查）
  const out: RecycleDeleteResult[] = new Array(entries.length)
  const progBuf: Array<{ res: RecycleDeleteResult; entry: { rPath: string; iPath: string } }> = []
  const flushProg = () => {
    if (!progBuf.length) return
    const batchRes = progBuf.map((p) => p.res)
    const batchEntries = progBuf.map((p) => p.entry)
    progBuf.length = 0
    onBatch?.(batchRes, batchEntries)
  }
  let idx = 0
  const n = Math.max(1, Math.min(RECYCLE_DELETE_CONCURRENCY, entries.length))
  async function worker() {
    while (idx < entries.length) {
      const i = idx++
      const e = entries[i]
      const { ok, error } = await removeRecycleEntry(e.rPath, e.iPath)
      const res: RecycleDeleteResult = { rPath: e.rPath, ok, error }
      out[i] = res
      progBuf.push({ res, entry: e })
      if (progBuf.length >= 64) flushProg()
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()))
  flushProg()
  return out
}
