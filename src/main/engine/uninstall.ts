import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { type UninstallEntry, type UninstallResult } from './model'
import { runPs, runPsStream, psQuote, parseJsonArray, parseJsonLines } from './ps'

interface UninstallRow {
  root: string
  view: string
  key: string
  name: string
  version: string
  publisher: string
  install_location: string
  install_date: string
  display_icon: string
  size_kb: number
  uninstall_string: string
  quiet_uninstall_string: string
  no_remove: number
}

/**
 * 扫描已安装程序（与「控制面板 → 程序和功能」同源）。
 * 覆盖 HKCU、HKLM 64 位与 HKLM 32 位（WOW6432Node）视图；
 * 过滤无显示名称、系统组件、父组件子项及安全更新/补丁类条目，减少噪音。
 *
 * ⚠️ 关键：脚本**每枚举一个键就输出一行 JSON 并立刻 Flush**，让主进程能边收边显示。
 * 实测本机 PowerShell 启动约 4.5 秒（固定成本），因此绝不能拆成多次调用（3 次 ≈ 13 秒）；
 * 且不 Flush 时输出会被管道缓冲，首行要多等约 1.7 秒。
 *
 * ⚠️ 读注册表一律走 **.NET `[Microsoft.Win32.Registry]`**，不要用 `Get-ChildItem`/
 * `Get-ItemProperty`：实测打开键 7ms vs 655ms、读首个值 8ms vs 48ms（差约 80 倍）。
 * 389 个子键下总枚举耗时从约 10 秒降到 1 秒内。
 */
const SCAN_SCRIPT = `
$roots = @(
  @{ r='HKCU'; v='64'; h='CU'; p='Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  @{ r='HKLM'; v='64'; h='LM'; p='Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  @{ r='HKLM'; v='32'; h='LM'; p='Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' }
)
foreach ($t in $roots) {
  if ($t.h -eq 'CU') { $base = [Microsoft.Win32.Registry]::CurrentUser } else { $base = [Microsoft.Win32.Registry]::LocalMachine }
  $root = $base.OpenSubKey($t.p)
  if (-not $root) { continue }
  foreach ($name in $root.GetSubKeyNames()) {
    $k = $root.OpenSubKey($name)
    if (-not $k) { continue }
    $dn = [string]$k.GetValue('DisplayName')
    if ($dn.Trim() -eq '') { $k.Close(); continue }
    if ([int]$k.GetValue('SystemComponent') -eq 1) { $k.Close(); continue }
    if ([string]$k.GetValue('ParentDisplayName') -ne '') { $k.Close(); continue }
    $rt = ([string]$k.GetValue('ReleaseType')).ToLower()
    if ($rt -eq 'security update' -or $rt -eq 'update' -or $rt -eq 'hotfix') { $k.Close(); continue }
    ConvertTo-Json -InputObject ([PSCustomObject]@{
      root=$t.r; view=$t.v; key=$name; name=$dn
      version=[string]$k.GetValue('DisplayVersion')
      publisher=[string]$k.GetValue('Publisher')
      install_location=[string]$k.GetValue('InstallLocation')
      install_date=[string]$k.GetValue('InstallDate')
      display_icon=[string]$k.GetValue('DisplayIcon')
      size_kb=[int64]$k.GetValue('EstimatedSize')
      uninstall_string=[string]$k.GetValue('UninstallString')
      quiet_uninstall_string=[string]$k.GetValue('QuietUninstallString')
      no_remove=[int]$k.GetValue('NoRemove')
    }) -Depth 4 -Compress
    [Console]::Out.Flush()
    $k.Close()
  }
  $root.Close()
}
`

/** 一次性收集（供卸载残留做名称 / 厂商 / 目录匹配，不需要图标）。 */
async function collectRows(): Promise<UninstallRow[]> {
  return parseJsonLines(await runPs(SCAN_SCRIPT)) as UninstallRow[]
}

/** 流式收集：枚举到一个键就回调一次，实现「边扫描边显示」。 */
function collectRowsStream(onRow: (r: UninstallRow) => void): Promise<void> {
  return runPsStream(SCAN_SCRIPT, (line) => {
    for (const r of parseJsonLines(line)) onRow(r as UninstallRow)
  })
}

/**
 * 去掉路径首尾成对的双引号。
 * 部分安装程序会把 InstallLocation 写成 `"D:\softs\Foo"`（带引号），
 * 有的则不带——统一剥掉，避免界面上显示不一致。
 */
function stripQuotes(s: string): string {
  const t = (s ?? '').trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).trim()
  }
  return t
}

/**
 * 归一化安装日期。注册表 InstallDate 绝大多数写成 `YYYYMMDD`，
 * 少数已带分隔符；异常值（0、超出合理年份区间）一律视为取不到。
 */
function normalizeInstallDate(v: string): string {
  const s = (v ?? '').trim()
  if (!s) return ''
  let y = ''
  let m = ''
  let d = ''
  if (/^\d{8}$/.test(s)) {
    y = s.slice(0, 4)
    m = s.slice(4, 6)
    d = s.slice(6, 8)
  } else if (/^(\d{4})-(\d{2})-(\d{2})/.test(s)) {
    const mm = /^(\d{4})-(\d{2})-(\d{2})/.exec(s) as RegExpExecArray
    y = mm[1]
    m = mm[2]
    d = mm[3]
  } else {
    return ''
  }
  const yi = Number(y)
  const maxYear = new Date().getFullYear() + 1
  if (yi < 1990 || yi > maxYear) return ''
  return `${y}-${m}-${d}`
}

/** 展开 `%ProgramFiles%` 之类的环境变量（少量安装程序会这么写）。 */
function expandEnv(s: string): string {
  return s.replace(/%([^%]+)%/g, (m, name: string) => process.env[name] ?? m)
}

/**
 * 通用宿主进程：它们的图标不代表被卸载的软件，取到就显示错图标，故排除。
 */
const GENERIC_HOSTS = new Set([
  'msiexec.exe',
  'rundll32.exe',
  'cmd.exe',
  'powershell.exe',
  'wscript.exe',
  'cscript.exe',
  'regsvr32.exe',
])

/**
 * 挑出可用于取图标的文件（exe / dll / ico 均可，系统统一按文件提取图标）。
 * 优先 DisplayIcon，其次卸载命令里的可执行文件。
 */
function pickIconFile(r: UninstallRow): string {
  const candidates: string[] = []
  const raw = (r.display_icon ?? '').trim()
  if (raw) {
    // DisplayIcon 形如 `C:\a\b.exe,0` / `"C:\a\b.exe",-1`，先去掉图标索引
    candidates.push(raw.replace(/,\s*-?\d+\s*$/, ''))
  }
  const { exe } = parseCommand(r.uninstall_string ?? '')
  if (exe) candidates.push(exe)

  for (const c of candidates) {
    let p = stripQuotes(c)
    if (!p) continue
    p = expandEnv(p)
    if (!p) continue
    if (!path.isAbsolute(p)) {
      const resolved = resolveExe(p)
      if (!resolved) continue
      p = resolved
    }
    const base = path.basename(p).toLowerCase()
    if (GENERIC_HOSTS.has(base)) continue
    try {
      if (fs.existsSync(p)) return path.resolve(p)
    } catch {
      /* 非法路径，跳过 */
    }
  }
  return ''
}

/** 图标缓存：同一可执行文件只向系统取一次（失败也缓存，避免重复开销）。 */
const iconCache = new Map<string, string>()

/** 取文件图标并转成 data URL；失败 / 超时返回空串（前端显示占位图标）。 */
async function iconDataUrl(file: string): Promise<string> {
  const cached = iconCache.get(file)
  if (cached !== undefined) return cached
  let out = ''
  try {
    const img = await Promise.race([
      app.getFileIcon(file, { size: 'large' }),
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ])
    if (img) out = img.toDataURL()
  } catch {
    out = ''
  }
  iconCache.set(file, out)
  return out
}

/**
 * 简易并发限流器：图标任务提交后不阻塞扫描，最后统一 drain 等待收尾。
 * （直接并发几百个 getFileIcon 会拖慢主进程，故限制并发。）
 */
function createIconLimiter(limit: number) {
  let active = 0
  const waiters: (() => void)[] = []
  const all: Promise<void>[] = []
  return {
    run(fn: () => Promise<void>): void {
      const p = (async () => {
        if (active >= limit) {
          await new Promise<void>((r) => waiters.push(r))
        }
        active++
        try {
          await fn()
        } finally {
          active--
          const w = waiters.shift()
          if (w) w()
        }
      })()
      all.push(p)
    },
    async drain(): Promise<void> {
      for (;;) {
        const snapshot = all.slice()
        await Promise.all(snapshot)
        if (all.length === snapshot.length) return
      }
    },
  }
}

/** 条目与其图标来源文件的配对（图标在 yield 前才附加，故需要中间结构）。 */
interface IconPair {
  entry: UninstallEntry
  iconFile: string
}

function toEntry(r: UninstallRow): UninstallEntry {
  const uninstallString = r.uninstall_string ?? ''
  const noRemove = r.no_remove === 1
  return {
    // id 编码 root|view|keyname，卸载时后端据此反查注册表，杜绝命令注入
    id: `${r.root}|${r.view}|${r.key}`,
    name: r.name ?? '',
    version: r.version ?? '',
    publisher: r.publisher ?? '',
    // 安装目录统一去引号（注册表里有的带引号有的不带）
    install_location: stripQuotes(r.install_location ?? ''),
    install_date: normalizeInstallDate(r.install_date ?? ''),
    // 图标在流式扫描的每批 yield 前由 attachIcons 填充
    icon: '',
    size_kb: Number(r.size_kb) || 0,
    uninstall_string: uninstallString,
    quiet_uninstall_string: r.quiet_uninstall_string ?? '',
    can_uninstall: !noRemove && uninstallString.trim() !== '',
  }
}

/** 汇总已安装程序（按名称升序，与 Tauri 版一致）。 */
export async function collectUninstallEntries(): Promise<UninstallEntry[]> {
  const rows = await collectRows()
  return rows
    .map(toEntry)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

/** 每批推送条数（够小才能看到逐批增长，又不至于消息过多）。 */
const BATCH_SIZE = 5

/**
 * 已安装程序流式扫描：PowerShell 边枚举边输出一行，这里边收边分批 yield，
 * 前端即可「扫描到一条显示一条」，计数也随之增长。
 *
 * 图标不阻塞扫描：条目先立即推送（图标为空，前端显示占位图标），
 * 取到图标后通过 onIcon 单独回吐，实现图标逐个填充。
 * 收尾会等图标全部取完再结束，保证图标事件先于 done 到达前端。
 */
export async function* scanUninstallStream(
  isCancelled: () => boolean,
  onIcon?: (id: string, icon: string) => void,
): AsyncGenerator<UninstallEntry[], void, unknown> {
  const pending: UninstallRow[] = []
  let produced = false
  let wake: (() => void) | null = null
  let failure: unknown = null

  const producer = collectRowsStream((r) => {
    pending.push(r)
    const w = wake
    wake = null
    if (w) w()
  })
    .catch((e) => {
      failure = e
    })
    .finally(() => {
      produced = true
      const w = wake
      wake = null
      if (w) w()
    })

  const limiter = createIconLimiter(6)
  const scheduleIcon = (p: IconPair): void => {
    if (!p.iconFile) return
    limiter.run(async () => {
      const url = await iconDataUrl(p.iconFile)
      if (!url) return
      p.entry.icon = url
      if (onIcon) onIcon(p.entry.id, url)
    })
  }

  let batch: IconPair[] = []
  const flush = (): UninstallEntry[] => {
    const out = batch
    batch = []
    return out.map((x) => x.entry)
  }

  for (;;) {
    if (isCancelled()) return
    if (!pending.length) {
      if (produced) break
      await new Promise<void>((res) => {
        wake = res
      })
      continue
    }
    const r = pending.shift() as UninstallRow
    const pair: IconPair = { entry: toEntry(r), iconFile: pickIconFile(r) }
    batch.push(pair)
    scheduleIcon(pair)
    if (batch.length >= BATCH_SIZE) {
      yield flush()
      // 让出事件循环，使渲染进程有机会绘制本批（否则消息挤在一起一次性呈现）
      await new Promise((res) => setImmediate(res))
    }
  }
  if (batch.length) yield flush()

  await producer
  if (failure) throw failure
  await limiter.drain()
}

/** 从注册表重新读取某项的卸载命令（后端反查，前端无法注入）。 */
async function readUninstallCommands(
  root: string,
  view: string,
  key: string,
): Promise<{ normal: string; quiet: string }> {
  const dir =
    root === 'HKLM' && view === '32'
      ? 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
      : `${root}:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`
  const script = `
$k = Get-ItemProperty -LiteralPath (Join-Path ${psQuote(dir)} ${psQuote(
    key,
  )}) -ErrorAction Stop
ConvertTo-Json -InputObject ([PSCustomObject]@{ normal=[string]$k.UninstallString; quiet=[string]$k.QuietUninstallString }) -Compress
`
  const parsed = parseJsonArray(await runPs(script))
  const first = parsed[0] ?? {}
  return { normal: String(first.normal ?? ''), quiet: String(first.quiet ?? '') }
}

/**
 * MsiExec 的卸载字符串偶尔写成 `/I{GUID}`（修改/修复对话框），
 * 必须转为 `/X{GUID}` 才能真正卸载。
 */
function normalizeMsi(s: string): string {
  const lower = s.toLowerCase()
  if (!lower.includes('msiexec') || !lower.includes('/i')) return s
  const pos = lower.indexOf('/i')
  if (pos < 0) return s
  const chars = s.split('')
  if (chars[pos + 1]) chars[pos + 1] = 'X'
  return chars.join('')
}

/**
 * 触发某个程序的原生卸载程序。
 * 卸载命令由后端从注册表重新读取，前端仅传 id；仅启动、不等待其结束。
 */
export async function uninstallProgram(
  id: string,
  quiet: boolean,
): Promise<UninstallResult> {
  const parts = id.split('|')
  if (parts.length < 3) {
    return { launched: false, command: '', error: '无法识别的卸载项 id' }
  }
  const root = parts[0]
  const view = parts[1]
  const key = parts.slice(2).join('|')

  let cmds: { normal: string; quiet: string }
  try {
    cmds = await readUninstallCommands(root, view, key)
  } catch (e) {
    return {
      launched: false,
      command: '',
      error: `读取卸载命令失败: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const cmd =
    quiet && cmds.quiet.trim() ? cmds.quiet : cmds.normal
  if (!cmd.trim()) {
    return { launched: false, command: '', error: '该项没有可用的卸载命令' }
  }
  const finalCmd = normalizeMsi(cmd)

  // 拆成「可执行文件 + 参数」：直接启动 exe，避免 cmd /C 对引号 / 特殊字符的解析问题
  const { exe, args } = parseCommand(finalCmd)
  const resolved = resolveExe(exe)
  if (!resolved && !exe) {
    return { launched: false, command: finalCmd, error: '无法从卸载命令中解析出可执行文件' }
  }

  const r = await launchUninstall(resolved, args, finalCmd)
  if (!r.ok) {
    return {
      launched: false,
      command: finalCmd,
      error: r.message || '卸载程序启动失败',
    }
  }
  return { launched: true, command: finalCmd, error: null }
}

/**
 * 把卸载命令拆成「可执行文件 + 参数」，正确处理带引号的路径。
 * 例：`"C:\Program Files\Foo\unins000.exe" /SILENT` → exe=`C:\Program Files\Foo\unins000.exe`、args=[`/SILENT`]
 */
function parseCommand(cmd: string): { exe: string; args: string[] } {
  const s = cmd.trim()
  const args: string[] = []
  let cur = ''
  let inQuotes = false
  let exe = ''
  for (const c of s) {
    if (c === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && /\s/.test(c)) {
      if (cur !== '') {
        if (exe === '') exe = cur
        else args.push(cur)
        cur = ''
      }
      continue
    }
    cur += c
  }
  if (cur !== '') {
    if (exe === '') exe = cur
    else args.push(cur)
  }
  return { exe, args }
}

/** 解析可执行文件的真实路径（支持绝对路径，以及 PATH / System32 下的 msiexec、rundll32 等）。 */
function resolveExe(exe: string): string | null {
  if (!exe) return null
  if (path.isAbsolute(exe)) return fs.existsSync(exe) ? exe : null
  if (fs.existsSync(exe)) return path.resolve(exe)
  const dirs: string[] = []
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (d) dirs.push(d)
  }
  const sysRoot = process.env.SystemRoot || process.env.windir || ''
  if (sysRoot) {
    dirs.push(path.join(sysRoot, 'System32'))
    dirs.push(sysRoot)
  }
  for (const d of dirs) {
    try {
      const full = path.join(d, exe)
      if (fs.existsSync(full)) return full
    } catch {
      /* 忽略非法目录 */
    }
  }
  return null
}

/**
 * 启动卸载程序（自带 UI，不等待其结束）。
 * 关键点：必须监听 `error` 与早期 `exit`——否则「程序根本没起来」也会被误报为已启动。
 */
function launchUninstall(
  exe: string | null,
  args: string[],
  cmdFallback: string,
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (ok: boolean, message: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ ok, message })
    }

    // 解析不到可执行文件时才退回 cmd /C（兼容含 shell 语法的卸载命令）。
    // 实测：cmd 必须带 windowsVerbatimArguments，否则 Node 给参数加引号会让
    // 带引号的命令被 cmd 解析错（实测 `echo hi > "x"` 在默认模式下根本不执行）。
    const useCmd = !exe
    let child: ChildProcess
    try {
      child = useCmd
        ? spawn('cmd', ['/C', cmdFallback], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            windowsVerbatimArguments: true,
          })
        : spawn(exe as string, args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          })
    } catch (e) {
      done(false, `启动卸载程序失败: ${e instanceof Error ? e.message : String(e)}`)
      return
    }

    // spawn 的错误是异步事件，不监听就永远看不到（原实现因此误报 launched=true）
    child.on('error', (e) => done(false, `启动卸载程序失败: ${e.message}`))
    // 短暂观察：1.2s 内退出且非 0 视为失败（0 可能是提权后自行退出，算成功）
    timer = setTimeout(() => done(true, ''), 1200)
    child.on('exit', (code) => {
      done(code === 0, code === 0 ? '' : `卸载程序退出码 ${code}`)
    })
    child.unref()
  })
}
