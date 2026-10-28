import { Worker } from 'node:worker_threads'
import os from 'node:os'

/**
 * 并发哈希线程池（SHA-256）。
 *
 * 重复文件判定的两个 CPU/IO 密集阶段都走这里：
 *   - 'full'   全量哈希：读整个文件计算 SHA-256（最终重复判定依据）
 *   - 'header' 头部哈希：只读文件头 4KB + 尾 4KB 做预筛（快速排除大小相同但内容不同的文件）
 *
 * 用 worker_threads 把计算分散到多核：
 *   - eval worker（代码内联，不依赖额外文件），避免 electron-builder 打包 asar 时对独立
 *     worker 文件做 asarUnpack 的额外配置，工程上最稳妥。
 *   - 任务队列式分发：每个 worker 完成一个文件后立即认领下一个，天然负载均衡。
 *   - 支持取消（isCancelled）：取消后不再分发新任务并关闭空闲 worker。
 *   - 若 worker 创建失败（极端环境），调用方应回退到主进程同步实现。
 *
 * 并发度：'full' 受 CPU 核数约束（CPU 密集）；'header' 偏 IO，给更高的并发数（随机小读重叠）。
 */

// eval worker 源码（CommonJS 语义，使用 require；不读取任何外部文件）。
const HASH_WORKER_SRC = `
const { parentPort } = require('worker_threads')
const crypto = require('crypto')
const fs = require('fs')
const HEADER = 4096
const TAIL = 4096

function full(path) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(path, 'r')
  const buf = Buffer.alloc(65536)
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null)
    if (n <= 0) break
    h.update(buf.subarray(0, n))
  }
  fs.closeSync(fd)
  return h.digest('hex')
}

function header(path) {
  let fd
  try {
    fd = fs.openSync(path, 'r')
  } catch (e) {
    return null
  }
  try {
    const total = fs.fstatSync(fd).size
    let buf = Buffer.alloc(0)
    const headLen = Math.min(HEADER, total)
    if (headLen > 0) {
      const head = Buffer.alloc(headLen)
      fs.readSync(fd, head, 0, headLen, 0)
      buf = Buffer.concat([buf, head])
    }
    if (total > HEADER + TAIL) {
      const tail = Buffer.alloc(TAIL)
      fs.readSync(fd, tail, 0, TAIL, total - TAIL)
      buf = Buffer.concat([buf, tail])
    }
    return crypto.createHash('sha256').update(buf).digest('hex')
  } finally {
    try {
      fs.closeSync(fd)
    } catch (e) {
      /* 关闭失败忽略 */
    }
  }
}

parentPort.on('message', (msg) => {
  if (!msg || msg.type === 'stop') {
    try {
      parentPort.close()
    } catch (e) {}
    return
  }
  let hash = null
  try {
    // 注意：主进程分发用 type: op（'header' 或 'full'），此处必须读 msg.type，
    // 之前误读 msg.op（恒为 undefined）导致全部走 full——预筛名存实亡。
    hash = msg.type === 'header' ? header(msg.path) : full(msg.path)
  } catch (e) {
    hash = null
  }
  parentPort.postMessage({ path: msg.path, hash })
})
`

export interface HashTask {
  path: string
}

export interface HashResult {
  path: string
  hash: string | null
}

type HashOp = 'full' | 'header'

/**
 * 并发计算多个文件的哈希（通用执行器）。
 * @param tasks   待哈希的文件路径列表
 * @param op      'full'=全量哈希；'header'=头尾预筛哈希
 * @param opts.isCancelled 取消回调；返回 true 时停止分发新任务
 * @param maxWorkers 并发 worker 上限
 * @returns 与输入顺序无关的结果列表（按完成顺序），取消时返回已完成的局部结果
 */
function runPool(
  tasks: HashTask[],
  op: HashOp,
  opts: { isCancelled?: () => boolean } = {},
  maxWorkers = 8,
): Promise<HashResult[]> {
  return new Promise((resolve, reject) => {
    if (!tasks.length) return resolve([])

    const numWorkers = Math.max(1, Math.min(maxWorkers, tasks.length))
    const workers: Worker[] = []
    let nextIdx = 0
    let doneCount = 0
    const results: HashResult[] = []
    let settled = false

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      for (const w of workers) {
        try {
          w.terminate()
        } catch {
          /* 忽略终止异常 */
        }
      }
      fn()
    }

    const assign = (w: Worker) => {
      if (opts.isCancelled && opts.isCancelled()) {
        w.postMessage({ type: 'stop' })
        return
      }
      if (nextIdx >= tasks.length) {
        w.postMessage({ type: 'stop' })
        return
      }
      const t = tasks[nextIdx++]
      w.postMessage({ type: op, path: t.path })
    }

    try {
      for (let i = 0; i < numWorkers; i++) {
        const w = new Worker(HASH_WORKER_SRC, { eval: true })
        workers.push(w)
        w.on('message', (msg: { path: string; hash: string | null }) => {
          results.push({ path: msg.path, hash: msg.hash })
          doneCount++
          if (opts.isCancelled && opts.isCancelled()) {
            settle(() => resolve(results))
            return
          }
          if (doneCount >= tasks.length) {
            settle(() => resolve(results))
            return
          }
          assign(w)
        })
        w.on('error', (e) => settle(() => reject(e)))
        w.on('exit', () => {
          if (settled) return
          if (opts.isCancelled && opts.isCancelled()) {
            settle(() => resolve(results))
            return
          }
          if (doneCount >= tasks.length) settle(() => resolve(results))
        })
        assign(w)
      }
    } catch (e) {
      settle(() => reject(e))
    }
  })
}

/** 全量 SHA-256（CPU 密集）：并发度受 CPU 核数约束。 */
export function hashFilesConcurrently(
  tasks: HashTask[],
  opts: { isCancelled?: () => boolean } = {},
): Promise<HashResult[]> {
  const cap = Math.min(8, os.cpus().length || 4)
  return runPool(tasks, 'full', opts, cap)
}

/** 头部预筛哈希（IO 偏重、读取小）：给更高并发度，让随机小读重叠。 */
export function headerHashFilesConcurrently(
  tasks: HashTask[],
  opts: { isCancelled?: () => boolean } = {},
): Promise<HashResult[]> {
  return runPool(tasks, 'header', opts, 16)
}
