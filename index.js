/**
 * dsh-compact-old —— 压缩已经堆积的老会话。
 *
 * 宿主自带 compaction-basic 提供 ctx.compaction.compactNow(agent, signal)，
 * 它能在**低于自动阈值**时也显式压一次，并把 compaction/summary 写回原会话日志。
 * 但 /compact 只作用于「当前会话」，且需要命令适配器。这个插件补上：
 *   · 列出所有已加载的活会话 + 已持久化的会话（只读，供挑选目标）
 *   · 对指定的活会话调用 compactNow，原地压缩
 *   · 一个 Agent 工具，问「压缩某个老会话」就能直接用
 *
 * 硬限制：compactNow 需要一个活着的、处于 idle 的 Agent。
 * 磁盘上没被打开/没 resume 的历史会话无法原地改写 —— 这是宿主压缩服务的
 * 契约，不是本插件能绕过的；接口会如实报 `unloaded`。
 */

import fs from 'node:fs'
import path from 'node:path'

const LOG_PREFIX = '[compact-old]'

/** 尽量从 Agent 对象上取会话 id / 标题，不依赖未公开的内部字段。 */
function describeAgent(agent) {
  let id = ''
  let title = ''
  let seq = 0
  let live = false
  try { id = String(agent.id || (agent.session && agent.session.id) || '') } catch { /* ignore */ }
  try {
    const header = agent.session && agent.session.header
    if (header) {
      title = String(header.title || '')
      seq = Number(header.lastSeq ?? header.seq ?? 0) || 0
    }
  } catch { /* ignore */ }
  try { live = String(agent.phase && agent.phase.kind || '') === 'idle' } catch { /* ignore */ }
  return { id, title, seq, idle: live, phase: safePhase(agent) }
}

function safePhase(agent) {
  try { return String((agent.phase && agent.phase.kind) || 'unknown') } catch { return 'unknown' }
}

function dshHome() {
  const env = String(process.env.DSH_HOME || '').trim()
  if (env) return env
  const base = process.env.USERPROFILE || process.env.HOME || ''
  return base ? path.join(base, '.dsh') : ''
}

/**
 * 只读列出已持久化的会话目录（JSONL 后端）。
 * 不解析内容，只报文件与大小，避免碰坏会话数据。
 */
function listPersisted() {
  const home = dshHome()
  if (!home) return []
  const candidates = [
    path.join(home, 'sessions'),
    path.join(home, 'profiles', String(process.env.DSH_PROFILE || 'desktop'), 'sessions'),
  ]
  const out = []
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.jsonl$/i.test(entry.name)) continue
        const full = path.join(dir, entry.name)
        let size = 0
        try { size = fs.statSync(full).size } catch { /* ignore */ }
        out.push({ id: entry.name.replace(/\.jsonl$/i, ''), file: full, bytes: size })
      }
    } catch { /* 目录不可读就跳过 */ }
  }
  return out
}

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const logger = ctx.logger || console
  // Cordis 规定服务只能在 inject 回调里取，直接 ctx.get 会抛
  // "cannot get property ... without inject"。这里把需要的服务缓存到闭包。
  let compaction = null
  let agents = null
  let sessionQuery = null
  /** sessionId -> 标题的短缓存，避免每次列会话都打一次查询 */
  const titleCache = new Map()

  ctx.inject(['compaction'], (scoped) => {
    compaction = (scoped && scoped.compaction) || null
  })
  ctx.inject(['agents'], (scoped) => {
    agents = (scoped && scoped.agents) || null
  })
  ctx.inject(['sessionQuery'], (scoped) => {
    sessionQuery = (scoped && scoped.sessionQuery) || null
  })

  /** 读会话标题；读不到就返回空串，不影响主流程。 */
  async function readTitle(sessionId) {
    if (!sessionId) return ''
    if (titleCache.has(sessionId)) return titleCache.get(sessionId)
    let title = ''
    try {
      if (sessionQuery && typeof sessionQuery.readTitle === 'function') {
        const snap = await sessionQuery.readTitle(sessionId)
        title = String((snap && (snap.title || (snap.value && snap.value.title))) || '')
      }
    } catch { /* 标题读不到不是错误 */ }
    if (!title) {
      try {
        const header = agents && agents.get && agents.get(sessionId)
        title = String((header && header.session && header.session.header && header.session.header.title) || '')
      } catch { /* ignore */ }
    }
    titleCache.set(sessionId, title)
    return title
  }

  /** 给描述对象补上标题（异步，概览里批量调用）。 */
  async function withTitle(info) {
    if (info.title) return info
    return { ...info, title: await readTitle(info.id) }
  }

  /** 找活 agent：按 id 精确匹配，或按标题模糊匹配，都没给就取所有 idle 会话。 */
  async function findAgents(allAgents, target) {
    const all = Array.isArray(allAgents) ? allAgents : []
    if (!target) return all.filter((a) => { try { return (a.phase && a.phase.kind) === 'idle' } catch { return false } })
    const exact = all.find((a) => describeAgent(a).id === String(target))
    if (exact) return [exact]
    const lower = String(target).toLowerCase()
    const matched = []
    for (const a of all) {
      const info = await withTitle(describeAgent(a))
      if (info.title.toLowerCase().includes(lower)) matched.push(a)
    }
    return matched
  }

  /** 压缩一个 agent；返回结构化结果，不抛到用户面前当黑盒。 */
  async function compactOne(agent, signal) {
    const info = describeAgent(agent)
    if (!info.idle) {
      return { id: info.id, ok: false, reason: 'busy', phase: info.phase, message: '该会话正在运行一轮对话，压缩需要空闲状态，请等它跑完再试。' }
    }
    if (!compaction || typeof compaction.compactNow !== 'function') {
      return { id: info.id, ok: false, reason: 'no-compaction-service', message: '宿主没有可用的压缩服务；请先启用 dsh-compaction-basic（dsh-compaction-enable 插件）。' }
    }
    const ac = new AbortController()
    const abort = signal || ac.signal
    try {
      const result = await compaction.compactNow(agent, abort)
      if (result === null) {
        return { id: info.id, ok: true, compacted: false, message: '没有可压缩的历史（可能已经压过或太短）。' }
      }
      const n = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0
      return {
        id: info.id, ok: true, compacted: true,
        shadowedSeqs: n,
        message: `已压缩 ${n} 条历史项，近期对话不受影响。`,
      }
    } catch (error) {
      const msg = String((error && error.message) || error)
      if (/already has active work|busy/i.test(msg)) {
        return { id: info.id, ok: false, reason: 'busy', message: '该会话刚进入工作状态，请稍后再试。' }
      }
      if (/could not produce a smaller summary|no smaller summary/i.test(msg)) {
        return { id: info.id, ok: true, compacted: false, reason: 'nothing-to-compact', message: '该会话历史太短，压缩后反而不会更小，宿主已跳过（无需处理）。' }
      }
      return { id: info.id, ok: false, reason: 'error', message: msg }
    }
  }

  /** 概览：活会话（带标题）+ 已持久化会话数量。 */
  async function overview() {
    const liveAgents = agents && typeof agents.list === 'function' ? agents.list() : []
    const live = []
    for (const a of liveAgents) live.push(await withTitle(describeAgent(a)))

    // sessionQuery.listSessions() 是权威来源：包含所有已持久化会话，
    // 比自己扫 JSONL 目录准；失败再退回目录扫描。
    let persisted = listPersisted()
    try {
      if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
        const records = await sessionQuery.listSessions()
        if (Array.isArray(records) && records.length) {
          persisted = records.map((r) => ({
            id: String((r.header && r.header.id) || r.id || ''),
            bytes: Number((r.bytes ?? r.size) || 0) || 0,
            live: !!r.live,
            persisted: !!r.persisted,
          })).filter((p) => p.id)
        }
      }
    } catch { /* 退回目录扫描结果 */ }

    return {
      ok: true,
      live: live.map((a) => ({ ...a, compactable: a.idle })),
      persistedCount: persisted.length,
      persisted: cfg.exposePersistedFiles === true ? persisted : persisted.map((p) => ({ id: p.id, bytes: p.bytes })),
      hasCompaction: !!(compaction && typeof compaction.compactNow === 'function'),
      note: '只有 live 且 idle 的会话可以原地压缩；磁盘上未打开的历史会话需先在界面里点开（resume）才能压。',
    }
  }

  // ---- HTTP 接口：GET 看列表，POST 压指定会话 ----
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped && scoped.webServer ? scoped.webServer : null
    if (!server || typeof server.register !== 'function') return () => {}
    return server.register({
      kind: 'prefix',
      path: '/api/compact-old',
      handler: async (req, res) => {
        const send = (code, body) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        let pathname = '/'
        try { pathname = new URL(String(req.url || '/'), 'http://localhost').pathname } catch { /* ignore */ }
        const method = String(req.method || 'GET').toUpperCase()
        try {
          if (method === 'GET' && pathname === '/api/compact-old/sessions') return send(200, await overview())
          if (method === 'POST' && pathname === '/api/compact-old/compact') {
            const chunks = []
            for await (const c of req) chunks.push(c)
            let body = {}
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* ignore */ }
            const list = agents && typeof agents.list === 'function' ? agents.list() : []
            const matched = await findAgents(list, body.sessionId || body.title)
            if (matched.length === 0) {
              return send(200, {
                ok: false, reason: 'unloaded',
                message: '没找到已加载的该会话。磁盘上未打开的历史会话无法原地压缩：请先在界面里点开它（resume），再调用本接口。',
                available: await overview(),
              })
            }
            const results = []
            for (const a of matched.slice(0, 5)) results.push(await compactOne(a))
            return send(200, { ok: results.some((r) => r.ok), results })
          }
          return send(404, { ok: false, error: 'not-found' })
        } catch (error) {
          return send(500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    })
  })

  // ---- Agent 工具：不打开界面也能「压缩老会话」 ----
  ctx.inject(['tools'], (scoped) => {
    const tools = scoped && scoped.tools ? scoped.tools : null
    if (!tools || typeof tools.register !== 'function') return () => {}
    return tools.register({
      name: 'compact_old_session',
      description: '压缩已经堆积过长的会话，把较早的历史替换成一条摘要，减少后续请求的 token。'
        + '只能压缩当前已加载且处于空闲的会话；磁盘上未打开的历史会话需先在界面里点开。'
        + '不带参数时列出可压缩的会话，不执行压缩。不修改会话日志之外的任何数据。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '要压缩的会话 id（从 list 结果里取）。不传则只列出可压缩会话。' },
          title: { type: 'string', description: '也可按会话标题模糊匹配；与 sessionId 二选一。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const lines = []
          if (value && Array.isArray(value.results)) {
            for (const r of value.results) lines.push(`${r.id}: ${r.message}`)
          } else if (value && value.live) {
            lines.push('可压缩会话（live 且 idle）：')
            for (const a of value.live.filter((x) => x.compactable)) lines.push(`  ${a.id}  ${a.title || '(无标题)'}`)
            lines.push(`已持久化会话 ${value.persistedCount} 个；压缩服务${value.hasCompaction ? '可用' : '不可用'}。`)
          }
          return [{ type: 'text', text: lines.join('\n') || JSON.stringify(value) }]
        },
      },
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {}
        const target = input.sessionId || input.title
        if (!target) return await overview()
        const list = agents && typeof agents.list === 'function' ? agents.list() : []
        const matched = await findAgents(list, target)
        if (matched.length === 0) {
          return {
            ok: false, reason: 'unloaded',
            message: '没找到已加载的该会话；请先在界面里点开它（resume）再压缩。',
            available: await overview(),
          }
        }
        const results = []
        for (const a of matched.slice(0, 5)) results.push(await compactOne(a))
        return { ok: results.some((r) => r.ok), results }
      },
    })
  })

  logger.info?.(LOG_PREFIX + ' 已挂载（/api/compact-old/* 与 compact_old_session 工具）')
  return () => {}
}
