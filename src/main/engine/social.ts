/**
 * 社交缓存专清（design.md §3.5 / §3.15）。
 *
 * C 盘的「隐形杀手」。缓存按风险分四级，**聊天记录数据库永久锁死，绝不提供删除入口**：
 *   ① 安全 · 临时缓存（Cache / Temp / Log）  —— 可重建，默认勾选
 *   ② 建议 · 图片缓存（Image / Attach）      —— 通常可释放，默认勾选
 *   ③ 谨慎 · 视频/接收文件（Video / File）   —— 可能还有用，默认不勾
 *   ④ 锁定 · 聊天记录（Msg*.db / *.db）      —— 永久不可选，仅展示体积
 *
 * 定位策略（对应设计的「默认路径自动搜寻，即使已改盘也能找到」）：
 * - 微信 4.x 应用目录 %APPDATA%\Tencent\xwechat（含 log 日志等，log 归「安全」）；
 * - 微信数据目录：3.x 在 Documents\WeChat Files；4.x 改名为 xwechat_files，可能在
 *   用户目录、或在设置里自定义的任意位置（从 Tencent\xwechat\config\*.ini 读取父目录
 *   再拼 xwechat_files）—— 这是 360 同款做法；此外还在每块固定盘的常见位置跨盘探测；
 * - 微博 / 抖音 / YY / 陌陌 / Soul / 千牛 目录命名随版本变动，扫描常见 AppData 目录 best-effort，
 *   未命中即静默跳过（不打扰用户）。
 *
 * 删除防线（比通用清理更严）：
 * 1. 仅接受本次会话内的 `id`，从会话反查真实路径，前端无法注入任意路径；
 * 2. 锁定级条目直接拒绝（不计入清理，界面也不可勾选）；
 * 3. 展开目录时再次按扩展名剔除 `*.db / *.db-wal / *.db-shm`；
 * 4. 每个文件执行期再校验 `isProtected`；
 * 5. 默认移入回收站，purge=true 才永久删除；
 * 6. 成功删除写入审计日志。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { expandEnv } from './rules'
import { isProtected } from './protected'
import { logDeletion } from './audit'
import { moveManyToRecycleBin, moveToRecycleBin } from './trash-bin'
import type { CleanCandidate, CleanResult } from './model'

/** 四级风险。 */
export type SocialLevel = 'safe' | 'advise' | 'caution' | 'locked'

/** 每一级的展示元信息（对齐 §3.15 风险分级总览的颜色与默认行为）。 */
export interface LevelMeta {
  /** 排序（界面分组顺序） */
  order: number
  /** 组标题，如「① 安全 · 临时缓存」 */
  label: string
  /** 组说明 */
  desc: string
  /** 界面色（绿/蓝/橙/红） */
  color: string
  /** 是否默认勾选 */
  recommend: boolean
  /** 是否锁定不可选 */
  locked: boolean
}

export const LEVEL_META: Record<SocialLevel, LevelMeta> = {
  safe: {
    order: 1,
    label: '① 安全 · 临时缓存',
    desc: '可自动重建，放心删（Cache / Temp）',
    color: '#3a9d3a',
    recommend: true,
    locked: false,
  },
  advise: {
    order: 2,
    label: '② 建议 · 图片缓存',
    desc: '通常可释放，软件会按需重新拉取（图片）',
    color: '#5a6acf',
    recommend: true,
    locked: false,
  },
  caution: {
    order: 3,
    label: '③ 谨慎 · 视频/接收文件',
    desc: '可能还有用（聊天视频 / 接收的文件），默认不勾',
    color: '#d98324',
    recommend: false,
    locked: false,
  },
  locked: {
    order: 4,
    label: '④ 锁定 · 聊天记录',
    desc: '永久不可选，绝不提供删除入口（Msg*.db）',
    color: '#d33333',
    recommend: false,
    locked: true,
  },
}

interface SocialApp {
  name: string
  /** 系统盘上的候选根目录（展开 %ENV% 后，不存在则跳过） */
  dirs: string[]
  /**
   * 可识别的数据文件夹名（不含路径）。用于「跨盘扫描」：社交软件的数据目录
   * 不一定在系统盘（用户常在安装时把文件存储位置改到其他盘，或迁移了用户目录），
   * 因此除系统盘外，还在每块固定盘的根目录 / Documents / Users\<用户>\Documents
   * 下按这些名字快速探测。命中即递归下钻。
   */
  reloc: string[]
}

const APPS: SocialApp[] = [
  // 微信：3.x 在 Documents\WeChat Files；4.0（2025 起）把数据目录改名为
  // xwechat_files，且部分安装直接放在用户目录下（不在 Documents 内）。
  // 三处都尝试，命中即扫。
  {
    name: '微信',
    dirs: [
      '%USERPROFILE%\\Documents\\WeChat Files',
      '%USERPROFILE%\\Documents\\xwechat_files',
      '%USERPROFILE%\\xwechat_files',
      // 4.x 应用目录下的日志（Tencent\xwechat\log，归类为「安全 · 日志」）。
      // 注意：只定位到 log，不扫整个 Tencent\xwechat —— 其下的 radium 嵌入式浏览器
      // 运行时缓存（Code Cache / GPUCache 等）与 net 的 CDN 缓存属于微信 app 内部，
      // 并非用户社交缓存，360 也只清 log。
      '%APPDATA%\\Tencent\\xwechat\\log',
    ],
    reloc: ['WeChat Files', 'xwechat_files'],
  },
  { name: 'QQ', dirs: ['%USERPROFILE%\\Documents\\Tencent Files'], reloc: ['Tencent Files'] },
  { name: '钉钉', dirs: ['%USERPROFILE%\\Documents\\DingTalk'], reloc: ['DingTalk'] },
  { name: '企业微信', dirs: ['%USERPROFILE%\\Documents\\WXWork'], reloc: ['WXWork'] },
  { name: '飞书', dirs: ['%LOCALAPPDATA%\\Lark\\SDK'], reloc: ['Lark'] },
  { name: '微博桌面', dirs: ['%APPDATA%\\Weibo'], reloc: ['Weibo'] },
  { name: '抖音聊天', dirs: ['%LOCALAPPDATA%\\Douyin', '%APPDATA%\\Douyin'], reloc: ['Douyin'] },
  { name: 'YY语音', dirs: ['%APPDATA%\\YY'], reloc: ['YY'] },
  { name: '陌陌', dirs: ['%APPDATA%\\Momo'], reloc: ['Momo'] },
  { name: 'Soul', dirs: ['%APPDATA%\\Soul'], reloc: ['Soul'] },
  { name: '千牛', dirs: ['%USERPROFILE%\\Documents\\Qianniu', '%APPDATA%\\Qianniu', '%LOCALAPPDATA%\\Qianniu'], reloc: ['Qianniu'] },
]

/** 系统盘盘符（如 'C'），跨盘扫描时跳过它（系统盘路径已由 dirs 覆盖）。 */
function systemDrive(): string {
  const sd = (process.env.SystemDrive || 'C:').replace(/:$/, '')
  return sd.toUpperCase()
}

/** 当前登录用户名（用于 <盘符>:\Users\<用户>\Documents 这类迁移后的用户目录）。 */
function currentUser(): string {
  return process.env.USERNAME || ''
}

let _wxDataCache: string[] | null = null
let _wxDataPending: Promise<string[]> | null = null

/**
 * 微信 4.x 把「文件存储位置」明文写在 %APPDATA%\Tencent\xwechat\config\*.ini，
 * 每行一个父目录（如 `D:\softs\tengxun\weixindata`）。微信数据目录即 `<父>\xwechat_files`。
 * 这是定位「用户自定义到其他盘」数据的可靠入口（与 360 同款做法），无需扫整盘。
 * 结果模块级缓存；配置不存在（3.x / 未装微信）或读取失败时返回空数组。
 */
async function wechatCustomDataRoots(): Promise<string[]> {
  if (_wxDataCache) return _wxDataCache
  if (_wxDataPending) return _wxDataPending
  _wxDataPending = (async () => {
    const out: string[] = []
    const cfgDir = expandEnv('%APPDATA%\\Tencent\\xwechat\\config').replace(/\//g, '\\')
    try {
      const files = fs
        .readdirSync(cfgDir)
        .filter((f) => f.toLowerCase().endsWith('.ini'))
      for (const f of files) {
        try {
          const line = fs
            .readFileSync(path.join(cfgDir, f), 'utf8')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)[0]
          if (!line) continue
          const dataRoot = path.join(line, 'xwechat_files')
          if (!out.includes(dataRoot)) out.push(dataRoot)
        } catch {
          /* 单文件损坏，跳过 */
        }
      }
    } catch {
      /* 目录不存在（3.x 或没装微信），回退空 */
    }
    _wxDataCache = out
    return out
  })()
  return _wxDataPending
}

let _drivesCache: string[] | null = null

/**
 * 用 Node 原生方式探测可用盘符（C..Z，跳过 A/B 软驱），全部失败才回退 `['C']`。
 * `existsSync` 过滤不存在的盘，`statfsSync` 再确认是可访问的文件系统
 * （网络盘 / 空光驱会在此失败，从而被排除）。
 */
function probeDrives(): string[] {
  const out: string[] = []
  for (let code = 67; code <= 90; code++) {
    const letter = String.fromCharCode(code)
    const root = `${letter}:\\`
    try {
      if (!fs.existsSync(root)) continue
      fs.statfsSync(root)
      out.push(letter)
    } catch {
      /* 不可访问（空光驱 / 无介质 / 网络不可达），跳过 */
    }
  }
  return out.length ? out : [systemDrive()]
}

/**
 * 列出本机可用盘符（C/D/E…），结果模块级缓存。
 *
 * ⚠️ 原先走 PowerShell `Get-PSDrive -PSProvider FileSystem`，**实测本机耗时 13.7 秒且
 * 返回空数组** —— 既让扫描首屏长时间空白（PowerShell 启动就要 4~13 秒），又使跨盘探测
 * **实际从未生效**（回退成 `['C']`，数据目录改到 D/E 盘的软件会被整款漏扫）。
 * 改用 Node 原生探测后实测 **3ms**，且能正确返回 C/D/E，跨盘探测真正生效。
 *
 * 代价：无法像 `DriveType -eq 'Fixed'` 那样精确区分 U 盘 / 网络盘。但跨盘探测只是按
 * 固定目录名做 `existsSync`（命中概率极低、单次开销可忽略），即使把 U 盘算进来也无实际
 * 影响；网络盘则由 `statfsSync` 失败自然排除，不会拖慢扫描。
 */
async function getFixedDrives(): Promise<string[]> {
  if (_drivesCache) return _drivesCache
  _drivesCache = probeDrives()
  return _drivesCache
}

/**
 * 为某款软件生成「非系统盘」上的候选根目录。社交软件的数据常被改到其他盘，因此除
 * 系统盘（由 dirs 覆盖）外，还在每块固定盘的根目录 / Documents / Users\<用户>\Documents
 * 下按 reloc 名字探测，命中即递归下钻。所有路径去重。
 */
function crossDriveRoots(
  app: SocialApp,
  drives: string[],
  sys: string,
  user: string,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of drives) {
    if (d === sys) continue
    for (const r of app.reloc) {
      const cands = [
        `${d}:\\${r}`,
        `${d}:\\Documents\\${r}`,
        user ? `${d}:\\Users\\${user}\\Documents\\${r}` : '',
      ]
      for (const c of cands) {
        if (c && !seen.has(c)) {
          seen.add(c)
          out.push(c)
        }
      }
    }
  }
  return out
}

/** ① 安全：临时缓存类目录名（小写比对）。 */
const SAFE_DIRS = new Set([
  'cache',
  'caches',
  'cacheData',
  'cachedata',
  'temp',
  'tmp',
  'gpucache',
  'code cache',
  'blob_storage',
  'session storage',
  'shadercache',
  'crashpad',
  'logs',
  'log',
])

/** ② 建议：图片类缓存目录名（默认勾选）。 */
const ADVISE_DIRS = new Set([
  'image',
  'images',
  'pic',
  'pics',
  'thumb',
  'thumbs',
  'thumbnail',
  'thumbnails',
  'media',
  'attach', // 微信 4.x：msg/attach 下的加密图片（.dat），属图片缓存
])

/** ③ 谨慎：视频 / 接收文件 / 表情类目录名（默认不勾）。
 * 微信 4.x 的 msg/video（聊天视频）、msg/file（接收的文件）归此类，需用户自行决定是否清理。 */
const CAUTION_DIRS = new Set([
  'filerecv',
  'file',
  'files',
  'video', // 微信 4.x：msg/video（聊天视频）—— 可能想保留，默认不勾
  'videos',
  'download',
  'downloads',
  'customemotions',
  'customemotion',
  'emoji',
  'emotion',
  'sticker',
  'favorite',
  'favorites',
])

/** ④ 锁定：聊天记录目录名（整体锁死，不展开、不统计为可清理）。
 * 注意：历史上把 'msg' 整目录当作锁定（仅 3.x 如此，里面只放聊天库）。
 * 微信 4.x 把聊天库(.db)与接收的 文件/图片/视频 都放进 msg/ 下，因此不再整体锁
 * msg，改为靠 LOCKED_EXT(.db/.sqlite…) 逐文件锁死聊天库，同时让 msg/file、
 * msg/attach、msg/video 这些缓存子目录可被扫描清理。 */
const LOCKED_DIRS = new Set([
  'msgdb',
  'msgstorage',
  'databases',
  'database',
  'db',
  'dbstorage',
  'message',
  'messages',
])

/** 聊天记录数据库扩展名 —— 任何情况下都不删除。
 * 注意：不含 .dat。微信 4.x / QQ 的缓存图片以加密 .dat 形式存放，属于「图片
 * 缓存」应可被清理；真正的聊天记录在 .db 里，由本集合锁死。 */
const LOCKED_EXT = /\.(db|db-wal|db-shm|sqlite|sqlite3)$/i

/** 不展开、不统计的目录（既不是用户缓存，也不是聊天库，扫了只会误伤/虚高）。
 * - backup：微信聊天记录「备份」文件夹，误清会丢失备份；
 * - all_users：多用户共享数据；
 * - migrate：版本迁移临时目录。 */
const SKIP_DIRS = new Set(['backup', 'all_users', 'migrate'])

export interface SocialItem {
  id: string
  /** 应用名，如「微信」 */
  app: string
  level: SocialLevel
  /** 条目名（目录名或锁定组名） */
  name: string
  path: string
  size: number
  fileCount: number
  /** 锁定级：界面不可勾选，后端也拒绝删除 */
  locked: boolean
  /** 是否默认勾选 */
  recommend: boolean
}

function hashId(p: string): string {
  return 'soc:' + crypto.createHash('md5').update(p).digest('hex').slice(0, 16)
}

interface DirStats {
  size: number
  files: number
}

/** 目录遍历的并发数（多个子目录并行 readdir）。 */
const WALK_CONC = 8

/**
 * 单目录内 stat 的批量并发数。
 * ⚠️ 实测（QQ 的 Tencent Files，9399 文件）：逐个 `await stat` 耗时 21911ms，
 * 改成**批量并发 32** 后 17219ms —— 逐个 await 时每个文件都要走一次事件循环往返，
 * 是社交扫描慢的直接原因之一。
 */
const STAT_CONC = 32

/**
 * 同时统计体积的目录数（条目级并发）。
 * ⚠️ 实测（QQ 的 Tencent Files，9399 文件 / 30 个目标目录）：
 * 条目串行 21911ms → **并发 10 只要 6940ms（快约 3.2 倍）**；并发再高反而略慢
 * （并发 16 为 7530ms）。与「数据迁移」模块结论一致：磁盘 IO 下并发度是关键，
 * 串行等待纯属浪费。
 */
const DIR_CONC = 10

/**
 * 递归统计目录体积，并按需剔除聊天记录库。
 *
 * 两层并发（实测叠加收益最大）：
 * - 目录层：限并发 8 并行 `readdir`；
 * - 文件层：每个目录的文件**批量并发 stat（32）**，不再逐个 await。
 *
 * 带文件数上限，避免超大目录拖垮扫描。
 */
async function dirStats(
  p: string,
  skipLockedExt: boolean,
  maxFiles = 20000,
  skipDirs?: Set<string>,
  onEntry?: () => void,
  collect?: ExpandedFile[],
  /** 目录内「不可删」文件的计数（聊天记录库等）。用于判断能否整目录清理。 */
  blockedRef?: { n: number },
): Promise<DirStats> {
  let size = 0
  let files = 0
  const stack: string[] = [p]
  let idx = 0
  /** 正在处理（已取出、尚未读完）目录的 worker 数 —— 用于判断「还会不会产生新目录」。 */
  let active = 0
  const worker = async () => {
    for (;;) {
      if (files >= maxFiles) return
      if (idx >= stack.length) {
        // 本轮无待处理目录：若也没有正在处理的 worker，就不会再产生新目录，可结束。
        // ⚠️ 不能简单地 `idx >= stack.length` 就退出 —— 其它 worker 可能还在读目录并
        // 往栈里追加子目录，直接退出会让并发退化成串行（初始栈只有 1 个目录）。
        if (active === 0) return
        await new Promise((r) => setImmediate(r))
        continue
      }
      active++
      const cur = stack[idx++]
      let ents: fs.Dirent[] = []
      try {
        ents = await fs.promises.readdir(cur, { withFileTypes: true })
      } catch {
        active--
        continue
      }
      // 先分好类：目录入栈待遍历，文件攒成一批后并发 stat
      const batch: string[] = []
      for (const e of ents) {
        // 每读到一个条目（文件或目录）都计入「已扫描」，让进度条直观反映扫描量
        onEntry?.()
        if (files + batch.length >= maxFiles) break
        const fp = path.join(cur, e.name)
        try {
          if (e.isDirectory()) {
            if (skipDirs && skipDirs.has(e.name.toLowerCase())) continue
            stack.push(fp)
          } else if (e.isFile()) {
            if (skipLockedExt && LOCKED_EXT.test(e.name)) {
              // 聊天记录库：不计入可删清单，同时标记「该目录不能整目录删除」
              if (blockedRef) blockedRef.n++
              continue
            }
            batch.push(fp)
          }
        } catch {
          /* 无权限访问，跳过 */
        }
      }
      active--
      for (let i = 0; i < batch.length && files < maxFiles; i += STAT_CONC) {
        const chunk = batch.slice(i, i + STAT_CONC)
        const stats = await Promise.all(
          chunk.map((f) => fs.promises.stat(f).catch(() => null)),
        )
        for (let k = 0; k < chunk.length; k++) {
          const st = stats[k]
          if (!st) continue
          size += st.size
          files++
          // 顺手收集文件清单（清理阶段直接复用，省掉第二次全量遍历）
          if (collect) collect.push({ path: chunk[k], size: st.size })
        }
      }
    }
  }
  await Promise.all(Array.from({ length: WALK_CONC }, () => worker()))
  return { size, files }
}

/** 目录名 → 风险等级；不属于任何已知类别时返回 null（继续下钻）。 */
function levelOfDir(name: string): SocialLevel | null {
  const n = name.toLowerCase()
  if (LOCKED_DIRS.has(n)) return 'locked'
  if (SAFE_DIRS.has(n)) return 'safe'
  if (ADVISE_DIRS.has(n)) return 'advise'
  if (CAUTION_DIRS.has(n)) return 'caution'
  return null
}

/**
 * 社交缓存流式扫描：async generator，每扫完一款应用 yield 一批。
 * 与垃圾清理同构 —— 每批之间 `setImmediate` 让权，取消时及时中断。
 */
export async function* scanSocialStream(
  isCancelled: () => boolean,
  onProgress?: (scanned: number) => void,
): AsyncGenerator<SocialItem[], void, unknown> {
  // 新一次扫描：清空上一轮的文件清单缓存（条目与清单必须同源）
  fileListCache.clear()
  dirBlocked.clear()

  // 累计「已扫描的文件/目录条目数」—— 反映真实扫描工作量，而非最终命中条数；
  // 每累计 16 条回吐一次（与大文件扫描同粒度），使界面数字平滑跳动、直观看到进度。
  let scanned = 0
  const bump = () => {
    scanned++
    if (scanned % 16 === 0) onProgress?.(scanned)
  }

  const drives = await getFixedDrives()
  const sys = systemDrive()
  const user = currentUser()
  for (const app of APPS) {
    if (isCancelled()) return
    const lockedAgg = { size: 0, files: 0 }
    /** 待统计体积的目录：收集阶段只下钻不统计，统计阶段再并发进行。 */
    const targets: Array<{ dir: string; level: SocialLevel }> = []
    /** 目录之外单独命中的聊天记录库文件（如散落的 Msg*.db），收集后批量 stat。 */
    const lockedFiles: string[] = []

    // 系统盘路径（dirs） + 其它固定盘的跨盘探测路径，合并去重后逐根扫描
    const sysRoots = app.dirs
      .map((d) => expandEnv(d).replace(/\//g, '\\'))
      .filter(Boolean)
    const roots = Array.from(
      new Set([
        ...sysRoots,
        ...crossDriveRoots(app, drives, sys, user),
        // 微信：用户在设置里自定义的任意数据盘（从 config\*.ini 读取）
        ...(app.name === '微信' ? await wechatCustomDataRoots() : []),
      ]),
    )

    for (const root of roots) {
      try {
        if (!fs.existsSync(root)) continue
      } catch {
        continue
      }

      // 若根目录本身就是一个已知分类目录（如 Tencent\xwechat\log），整目录作为
      // 一条目（含其下的零散文件，例如 .xlog 日志），不再向内下钻，避免漏项/重复。
      const rootLevel = levelOfDir(path.basename(root))
      if (rootLevel && rootLevel !== 'locked') {
        targets.push({ dir: root, level: rootLevel })
        continue
      }

      // 深度优先下钻：命中已知类别即成条（不再向内展开），否则继续下钻
      // （例如 FileStorage 本身无类别，其下的 Image / Video / Cache 才是条目）
      // 并发遍历下钻：改用 `fs.promises.readdir` + 多 worker 并行（不再串行逐目录等待，
      // 实测 QQ 的目录收集阶段由 6.3 秒降至此方案的并发水平），且不再阻塞事件循环。
      const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
      let cursor = 0
      /** 同上：正在读取目录的 worker 数，避免并发退化成串行。 */
      let active = 0
      const walkWorker = async (): Promise<void> => {
        for (;;) {
          if (isCancelled()) return
          if (cursor >= stack.length) {
            if (active === 0) return
            await new Promise((r) => setImmediate(r))
            continue
          }
          active++
          const cur = stack[cursor++]
          if (cur.depth > 6) {
            active--
            continue
          }
          let ents: fs.Dirent[]
          try {
            ents = await fs.promises.readdir(cur.dir, { withFileTypes: true })
          } catch {
            active--
            continue
          }
          for (const e of ents) {
            if (isCancelled()) return
            bump()
            const fp = path.join(cur.dir, e.name)
            const n = e.name.toLowerCase()

            // 聊天记录库文件：只累计体积，绝不生成可清理条目（稍后批量 stat）
            if (e.isFile()) {
              if (LOCKED_EXT.test(e.name)) lockedFiles.push(fp)
              continue
            }
            if (!e.isDirectory()) continue

            // 备份 / 共享 / 迁移数据：不展开、不统计（误清会丢聊天记录备份）
            if (SKIP_DIRS.has(n)) continue

            const lv = levelOfDir(n)
            if (lv === 'locked') {
              targets.push({ dir: fp, level: 'locked' })
              continue
            }
            if (lv === null) {
              stack.push({ dir: fp, depth: cur.depth + 1 })
              continue
            }
            targets.push({ dir: fp, level: lv })
          }
          active--
        }
      }
      await Promise.all(Array.from({ length: WALK_CONC }, () => walkWorker()))
    }

    // 散落的聊天记录库文件：批量并发 stat（原先逐个 statSync 会阻塞且较慢）
    for (let i = 0; i < lockedFiles.length; i += STAT_CONC) {
      if (isCancelled()) return
      const chunk = lockedFiles.slice(i, i + STAT_CONC)
      const stats = await Promise.all(
        chunk.map((f) => fs.promises.stat(f).catch(() => null)),
      )
      for (const st of stats) {
        if (!st) continue
        lockedAgg.size += st.size
        lockedAgg.files += 1
      }
    }

    // ② 并发统计体积（实测：条目串行 21911ms → 并发 10 只要 6940ms，快约 3.2 倍），
    // **统计完一个目录就立刻产出一条**，界面边扫边显示，不必等整款软件扫完。
    const ready: SocialItem[] = []
    let cursor = 0
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
        if (i >= targets.length) return
        const t = targets[i]
        // 锁定目录统计全部文件（含 .db）；可清理条目统计时剔除聊天记录库
        // 可清理条目顺手收集文件清单与「不可删文件数」，供清理阶段直接复用
        const list: ExpandedFile[] = []
        const blocked = { n: 0 }
        const st = await dirStats(
          t.dir,
          t.level !== 'locked',
          20000,
          undefined,
          bump,
          t.level === 'locked' ? undefined : list,
          t.level === 'locked' ? undefined : blocked,
        )
        if (isCancelled()) return
        if (t.level === 'locked') {
          lockedAgg.size += st.size
          lockedAgg.files += st.files
        } else if (st.files > 0) {
          // 仅在清单完整（未撞上 20000 上限）时缓存，否则清理阶段仍重新展开
          if (st.files < 20000) {
            fileListCache.set(t.dir, list)
            dirBlocked.set(t.dir, blocked.n)
          }
          ready.push({
            id: hashId(t.dir),
            app: app.name,
            level: t.level,
            name: path.basename(t.dir),
            path: t.dir,
            size: st.size,
            fileCount: st.files,
            locked: false,
            recommend: LEVEL_META[t.level].recommend,
          })
        }
        notify()
      }
    }

    const workers = Array.from(
      { length: Math.min(DIR_CONC, targets.length) },
      () => worker(),
    )
    void Promise.all(workers).then(() => {
      finished = true
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
      const item = ready.shift() as SocialItem
      yield [item]
      // 让出事件循环，使渲染进程有机会绘制本条
      await new Promise((r) => setImmediate(r))
    }

    // 锁定组：每款应用汇总为一条，仅展示体积
    if (lockedAgg.files > 0) {
      yield [
        {
          id: hashId(`${app.name}::locked`),
          app: app.name,
          level: 'locked',
          name: '聊天记录数据库',
          path: `${app.name}（Msg*.db 等，永久锁死）`,
          size: lockedAgg.size,
          fileCount: lockedAgg.files,
          locked: true,
          recommend: false,
        },
      ]
    }
    await new Promise((r) => setImmediate(r))
  }
  // 扫描收尾：回吐最终累计的「已扫描」总数（精确值）
  if (scanned > 0) onProgress?.(scanned)
}

/** 会话内条目 → 可清理文件清单（展开目录，剔除聊天记录库）。 */
interface ExpandedFile {
  path: string
  size: number
}

/**
 * 扫描阶段顺手缓存的「条目目录 → 可清理文件清单」。
 *
 * ⚠️ **这是清理提速的关键**：原先清理时要对勾选项再跑一遍 `expandFilesAsync`
 * （递归 readdir + 全量 stat），等于把扫描阶段最耗时的工作**又做了一遍** —— 勾选
 * 条目动辄上万文件（微信 FileStorage 27984 个），第二次遍历是清理慢的主因。
 * 扫描时反正已经逐个 stat 过，把清单存下来（仅多占几 MB 内存）即可直接复用。
 *
 * 只在清单**完整**（未被 `maxFiles` 上限截断）时缓存，避免清理时漏删。
 * 每次扫描开始清空，保证与本次会话条目一致。
 */
const fileListCache = new Map<string, ExpandedFile[]>()

/**
 * 条目目录 → 目录内「不可删」文件数（聊天记录库 .db 等）。
 * 为 0 时才能整目录清理（见 deleteSocialItems 的整目录快路径），否则必须逐文件删。
 */
const dirBlocked = new Map<string, number>()

/**
 * 并发展开目录为文件清单（同时收集体积，省去原先同步逐文件 `statSync` 的二次遍历）。
 * 原 `expandFiles` 用 `readdirSync` 单线程递归 + 之后又逐文件 `statSync`，在微信
 * FileStorage 这种十万级文件目录上极慢，且会阻塞主进程事件循环；这里改为限并发 8 的
 * 异步遍历，边遍历边 stat，单趟完成，收集阶段耗时大幅下降。
 */
async function expandFilesAsync(
  dir: string,
  cap = 20000,
): Promise<{ files: ExpandedFile[]; blocked: number }> {
  const out: ExpandedFile[] = []
  let blocked = 0
  const stack: string[] = [dir]
  let idx = 0
  let active = 0
  const worker = async () => {
    for (;;) {
      if (out.length >= cap) return
      if (idx >= stack.length) {
        // 同 dirStats：不能用「栈为空」直接退出，否则并发退化成串行
        if (active === 0) return
        await new Promise((r) => setImmediate(r))
        continue
      }
      active++
      const cur = stack[idx++]
      let ents: fs.Dirent[] = []
      try {
        ents = await fs.promises.readdir(cur, { withFileTypes: true })
      } catch {
        active--
        continue
      }
      const batch: string[] = []
      for (const e of ents) {
        if (out.length + batch.length >= cap) break
        const fp = path.join(cur, e.name)
        try {
          if (e.isDirectory()) stack.push(fp)
          else if (e.isFile()) {
            if (LOCKED_EXT.test(e.name)) blocked++
            else batch.push(fp)
          }
        } catch {
          /* ignore */
        }
      }
      active--
      // 批量并发 stat（与 dirStats 同款优化，避免逐个 await）
      for (let i = 0; i < batch.length && out.length < cap; i += STAT_CONC) {
        const chunk = batch.slice(i, i + STAT_CONC)
        const stats = await Promise.all(
          chunk.map((f) => fs.promises.stat(f).catch(() => null)),
        )
        for (let k = 0; k < chunk.length; k++) {
          out.push({ path: chunk[k], size: stats[k]?.size ?? 0 })
        }
      }
    }
  }
  await Promise.all(Array.from({ length: WALK_CONC }, () => worker()))
  return { files: out, blocked }
}

/**
 * 同时删除的目录数（整目录清理路径）。条目数量通常只有几十个，并发 6 足够把
 * 回收站操作从「串行排队」变成并行；再高对回收站 COM 反而容易互相阻塞。
 */
const DIR_DELETE_CONC = 6

/** 限制并发的 map（用于并发展开多个待删目录，避免一次性拉起过多文件句柄）。 */
async function mapWithConcurrency<T, R>(
  inputs: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(inputs.length)
  let i = 0
  const worker = async () => {
    while (i < inputs.length) {
      const idx = i++
      results[idx] = await fn(inputs[idx])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, inputs.length) }, () => worker()),
  )
  return results
}

/**
 * 删除社交缓存条目（提速版）。
 *
 * 与通用 `deleteCandidates` 同构：条目是「目录」而非单文件，先按目录展开成文件清单；
 * 锁定级条目与聊天记录库在展开阶段即被剔除，从机制上保证不可删。
 *
 * 提速：回收站走 `moveManyToRecycleBin` 批量传参（一次进程处理一批，进程数从 N 降到
 * ⌈N/200⌉），永久删除用限并发 8 的异步 rm —— 解决原先逐条串行 `fs.unlinkSync` /
 * 逐条 `moveToRecycleBin` 导致清理缓慢的根因（与垃圾清理完全一致）。
 */
export async function deleteSocialItems(
  items: Map<string, SocialItem>,
  ids: string[],
  purge: boolean,
  onDeleted?: (ids: string[]) => void,
): Promise<CleanResult> {
  const result: CleanResult = {
    deleted_count: 0,
    deleted_size: 0,
    skipped: [],
    errors: [],
  }
  const auditItems: CleanCandidate[] = []
  // 流式进度缓冲：累计成功删除的文件路径，达到阈值（或超过 120ms）才回吐给 UI。
  // ⚠️ 不能「删一个推一次」——上万文件就是上万次 IPC 往返，UI 数字刷新不过来，
  // 反而拖慢清理本身（界面只看累计条数，批量更新完全够用）。
  const progressBuf: string[] = []
  let lastFlush = 0
  const flushProgress = (force = false) => {
    const now = Date.now()
    if (!progressBuf.length || !onDeleted) return
    if (!force && progressBuf.length < 100 && now - lastFlush < 120) return
    lastFlush = now
    onDeleted(progressBuf.splice(0))
  }

  // 收集待删文件：优先复用扫描阶段缓存的清单（几乎零成本），未命中才展开目录。
  const fileItem = new Map<string, string>() // path -> itemId
  const fileSize = new Map<string, number>() // path -> size
  const itemFailed = new Set<string>() // 存在删除失败文件的 item
  const itemNoFile = new Set<string>() // 参与删除但无文件的 item（整体 skip）

  /** 整目录清理的候选：目录内没有任何「不可删」文件时直接把目录移入回收站。 */
  const wholePlans: Array<{ id: string; dir: string; files: ExpandedFile[] }> = []

  const expanded = await mapWithConcurrency(ids, 12, async (id) => {
    const it = items.get(id)
    if (!it)
      return { id, status: 'missing' as const, files: [] as ExpandedFile[], blocked: 0 }
    if (it.locked || it.level === 'locked')
      return { id, status: 'locked' as const, files: [] as ExpandedFile[], blocked: 0 }
    // 扫描时已统计过该目录：直接复用清单，省掉第二次递归 readdir + 全量 stat
    const cached = fileListCache.get(it.path)
    const got = cached
      ? { files: cached, blocked: dirBlocked.get(it.path) ?? 0 }
      : await expandFilesAsync(it.path)
    return {
      id,
      status: (got.files.length ? 'ok' : 'nofile') as 'ok' | 'nofile',
      files: got.files,
      blocked: got.blocked,
    }
  })
  for (const e of expanded) {
    if (e.status === 'missing') {
      result.skipped.push({ id: e.id, path: '', reason: '条目不在本次扫描会话内' })
      continue
    }
    if (e.status === 'locked') {
      const it = items.get(e.id)
      result.skipped.push({
        id: e.id,
        path: it?.path ?? '',
        reason: '聊天记录已锁定，禁止清理',
      })
      continue
    }
    if (e.status === 'nofile') {
      result.skipped.push({
        id: e.id,
        path: items.get(e.id)?.path ?? '',
        reason: '无可删除文件',
      })
      itemNoFile.add(e.id)
      continue
    }
    const dir = items.get(e.id)?.path ?? ''
    // 整目录快路径的前提：目录内没有聊天记录库等不可删文件，且目录本身不在保护名单内。
    // 命中则只需一次回收站操作（见下方 wholePlans 执行），否则退回逐文件。
    if (e.blocked === 0 && dir && !isProtected(dir)) {
      let ok = true
      for (const f of e.files) {
        // 防线 2 / 3：受保护路径与聊天记录库扩展名（双保险）
        if (isProtected(f.path) || LOCKED_EXT.test(f.path)) {
          ok = false
          itemFailed.add(e.id)
        }
      }
      if (ok) {
        wholePlans.push({ id: e.id, dir, files: e.files })
        continue
      }
      continue
    }
    for (const f of e.files) {
      // 防线 2：受保护路径（双保险）
      if (isProtected(f.path)) {
        itemFailed.add(e.id)
        continue
      }
      // 防线 3：聊天记录库扩展名（双保险）
      if (LOCKED_EXT.test(f.path)) {
        itemFailed.add(e.id)
        continue
      }
      fileItem.set(f.path, e.id)
      fileSize.set(f.path, f.size)
    }
  }

  // —— 整目录清理：一次操作移走整棵目录树（含子目录），计一条目的全部文件 ——
  // ⚠️ 实测（C 盘，600 文件目录）：逐文件移入回收站（并发 4）需 9.6s，
  // **整目录一次操作只要 3.26s**，且成本几乎不随文件数增长（元数据操作）。
  // 勾选条目动辄上万文件（微信 attach 20182 个），整目录能把清理从数分钟压到十几秒。
  // 失败（文件被占用等）不报错，静默降级为逐文件删除。
  if (wholePlans.length) {
    await mapWithConcurrency(wholePlans, DIR_DELETE_CONC, async (p) => {
      try {
        if (purge) {
          await fs.promises.rm(p.dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
        } else {
          await moveToRecycleBin(p.dir)
        }
      } catch {
        /* 交给下面的存在性判定处理 */
      }
      let gone = false
      try {
        gone = !fs.existsSync(p.dir)
      } catch {
        gone = true
      }
      if (!gone) {
        // 整目录没删掉（多半是软件占用）→ 退回逐文件，保证尽力清理
        for (const f of p.files) {
          if (isProtected(f.path) || LOCKED_EXT.test(f.path)) {
            itemFailed.add(p.id)
            continue
          }
          fileItem.set(f.path, p.id)
          fileSize.set(f.path, f.size)
        }
        return
      }
      for (const f of p.files) {
        result.deleted_count += 1
        result.deleted_size += f.size
        auditItems.push({
          id: p.id,
          path: f.path,
          size: f.size,
          category: `社交软件缓存·${items.get(p.id)?.app ?? ''}`,
          rule_id: `social:${items.get(p.id)?.level ?? 'safe'}`,
        })
        progressBuf.push(f.path)
      }
      flushProgress()
    })
  }

  /** 把「参与删除但存在失败文件」的 item 整条保留（计入 skipped，不移除）。 */
  const finalizeSkipped = () => {
    for (const id of ids) {
      if (itemNoFile.has(id)) continue
      const it = items.get(id)
      if (!it || it.locked || it.level === 'locked') continue
      if (itemFailed.has(id)) {
        result.skipped.push({
          id,
          path: it.path,
          reason: '部分文件未删除（可能被占用或受保护）',
        })
      }
    }
  }

  const allFiles = [...fileItem.keys()]
  if (allFiles.length === 0) {
    finalizeSkipped()
    if (auditItems.length) logDeletion(auditItems, purge)
    return result
  }

  if (purge) {
    // 并发永久删除（限并发 12），远快于逐条同步 unlink
    let pidx = 0
    const CONC = 12
    const worker = async () => {
      while (pidx < allFiles.length) {
        const fp = allFiles[pidx++]
        const itemId = fileItem.get(fp)!
        try {
          try {
            await fs.promises.chmod(fp, 0o666)
          } catch {
            /* 只读属性可能不可改，交 rm 重试兜底 */
          }
          await fs.promises.rm(fp, { force: true, maxRetries: 3, retryDelay: 100 })
          const sz = fileSize.get(fp) ?? 0
          result.deleted_count += 1
          result.deleted_size += sz
          auditItems.push({
            id: itemId,
            path: fp,
            size: sz,
            category: `社交软件缓存·${items.get(itemId)?.app ?? ''}`,
            rule_id: `social:${items.get(itemId)?.level ?? 'safe'}`,
          })
          progressBuf.push(fp)
          flushProgress()
        } catch (e) {
          itemFailed.add(itemId)
          const code = (e as NodeJS.ErrnoException)?.code
          const msg = e instanceof Error ? e.message : String(e)
          if (
            code === 'EBUSY' ||
            code === 'EPERM' ||
            code === 'EACCES' ||
            code === 'ETXTBSY' ||
            /busy|locked|permitted/i.test(msg)
          ) {
            result.errors.push(`${fp}: 使用中或无权访问，已跳过`)
          } else {
            result.errors.push(`${fp}: ${msg}`)
          }
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONC, allFiles.length) }, () => worker()),
    )
  } else {
    // 回收站：批量传参给 windows-trash.exe（一次进程处理一批，进程数从 N 降到 ⌈N/200⌉）
    try {
      const succeededPaths = new Set<string>()
      const { succeeded, failed } = await moveManyToRecycleBin(allFiles, (batch) => {
        for (const p of batch) {
          if (succeededPaths.has(p)) continue
          succeededPaths.add(p)
          const itemId = fileItem.get(p)!
          const sz = fileSize.get(p) ?? 0
          result.deleted_count += 1
          result.deleted_size += sz
          auditItems.push({
            id: itemId,
            path: p,
            size: sz,
            category: `社交软件缓存·${items.get(itemId)?.app ?? ''}`,
            rule_id: `social:${items.get(itemId)?.level ?? 'safe'}`,
          })
          progressBuf.push(p)
        }
        flushProgress()
      })
      // 兜底补齐（极端时序）
      for (const p of succeeded) {
        if (succeededPaths.has(p)) continue
        succeededPaths.add(p)
        const itemId = fileItem.get(p)!
        const sz = fileSize.get(p) ?? 0
        result.deleted_count += 1
        result.deleted_size += sz
        auditItems.push({
          id: itemId,
          path: p,
          size: sz,
          category: `社交软件缓存·${items.get(itemId)?.app ?? ''}`,
          rule_id: `social:${items.get(itemId)?.level ?? 'safe'}`,
        })
        progressBuf.push(p)
      }
      // 移入回收站失败：社交默认不兜底直删（保持安全 —— 回收站不可用就报错，不动文件）
      for (const f of failed) {
        const itemId = fileItem.get(f.path)!
        itemFailed.add(itemId)
        result.errors.push(`${f.path}: ${f.error ?? '移入回收站失败'}`)
      }
    } catch (e) {
      // 回收站机制整体失败（windows-trash.exe 缺失 / COM 受限 / PowerShell 也抛错）
      const msg = e instanceof Error ? e.message : String(e)
      result.errors.push(`回收站删除失败：${msg}`)
      for (const fp of allFiles) itemFailed.add(fileItem.get(fp)!)
    }
  }

  flushProgress(true)
  finalizeSkipped()
  if (auditItems.length) logDeletion(auditItems, purge)
  return result
}

export interface SocialCacheSize {
  totalBytes: number
  byApp: Record<string, number>
}

/** 只读体积统计（健康评分的「社交缓存体积」因素使用，不产出条目）。 */
export async function scanSocialCacheSize(): Promise<SocialCacheSize> {
  const byApp: Record<string, number> = {}
  for (const app of APPS) byApp[app.name] = 0
  let total = 0
  const drives = await getFixedDrives()
  const sys = systemDrive()
  const user = currentUser()

  // 先收集「存在的根目录」，再并发统计体积（串行等待磁盘 IO 是这里的主要开销）
  const jobs: Array<{ app: string; dir: string }> = []
  for (const app of APPS) {
    const sysRoots = app.dirs
      .map((d) => expandEnv(d).replace(/\//g, '\\'))
      .filter(Boolean)
    const roots = Array.from(
      new Set([
        ...sysRoots,
        ...crossDriveRoots(app, drives, sys, user),
        ...(app.name === '微信' ? await wechatCustomDataRoots() : []),
      ]),
    )
    for (const ep of roots) {
      try {
        if (!fs.existsSync(ep)) continue
      } catch {
        continue
      }
      jobs.push({ app: app.name, dir: ep })
    }
  }

  // 排除 Backup / all_users / migrate，它们不是用户缓存（备份不该计入社交缓存体积）
  const sizes = await mapWithConcurrency(jobs, DIR_CONC, async (j) => {
    const st = await dirStats(j.dir, false, 20000, SKIP_DIRS)
    return st.size
  })
  for (let i = 0; i < jobs.length; i++) {
    byApp[jobs[i].app] += sizes[i]
    total += sizes[i]
  }
  return { totalBytes: total, byApp }
}
