/**
 * 离线测试：工具/接口契约、会话挑选、压缩调用。
 * 用假 ctx 注入 compaction / agents / webServer / tools，全程不联网。
 */
import { apply } from '../index.js'

const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1 }

const idleAgent = (id, title) => ({
  id, phase: { kind: 'idle' },
  session: { id, header: { title, lastSeq: 120 } },
  runMaintenance: async () => { throw new Error('不应由测试调用') },
})
const busyAgent = (id, title) => ({
  id, phase: { kind: 'running' },
  session: { id, header: { title, lastSeq: 200 } },
})

function harness(opts = {}) {
  const calls = []
  const routes = []
  let tool = null
  const compaction = {
    async compactNow(agent, signal) {
      calls.push({ id: agent.id, hasSignal: !!signal })
      if (opts.compactThrows) throw new Error(opts.compactThrows)
      return opts.compactNull ? null : { shadowedSeqs: [1, 2, 3, 4, 5] }
    },
  }
  const agents = { list: () => opts.agentList || [idleAgent('s1', '老会话一'), idleAgent('s2', '老会话二')], get: (id) => (opts.agentList || []).find((a) => a.id === id) }
  const sessionQuery = {
    async readTitle(id) {
      const a = (opts.agentList || [idleAgent('s1', '老会话一'), idleAgent('s2', '老会话二')]).find((x) => x.id === id)
      return a && a.session.header.title ? { title: a.session.header.title } : undefined
    },
    async listSessions() { return opts.persistedList || [] },
  }
  const service = { compaction, agents, sessionQuery, webServer: { register(r) { routes.push(r); return () => {} } }, tools: { register(d) { tool = d; return () => {} } } }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    inject(deps, cb) { cb(service); return () => {} },
  }
  const dispose = apply(ctx, {})
  return { calls, routes, tool, dispose, service }
}

// ---- 1. 工具与路由都注册了 ----
{
  const h = harness()
  if (!h.tool || h.tool.name !== 'compact_old_session') fail('工具未注册')
  if (!h.routes.some((r) => r.path === '/api/compact-old')) fail('API 路由未注册')
  h.dispose()
}

// ---- 2. 不带参数只列会话，不压缩 ----
{
  const h = harness()
  const value = await h.tool.execute({})
  if (h.calls.length !== 0) fail('不带参数不该压缩')
  if (!value.ok || !Array.isArray(value.live)) fail('应返回会话概览')
  if (value.live.length !== 2) fail('应列出 2 个活会话')
  if (!value.live.every((a) => a.compactable === true)) fail('idle 会话应标为可压缩')
  if (value.hasCompaction !== true) fail('应检测到压缩服务可用')
  h.dispose()
}

// ---- 3. 按 id 精确压缩，结果计数正确 ----
{
  const h = harness()
  const value = await h.tool.execute({ sessionId: 's2' })
  if (!value.ok) fail('压缩应成功: ' + JSON.stringify(value))
  if (h.calls.length !== 1 || h.calls[0].id !== 's2') fail('应只压缩 s2，实际: ' + JSON.stringify(h.calls))
  if (h.calls[0].hasSignal !== true) fail('应传 AbortSignal')
  if (!value.results[0].message.includes('5 条')) fail('应报告压缩条数: ' + value.results[0].message)
  h.dispose()
}

// ---- 4. 按标题模糊匹配 ----
{
  const h = harness()
  const value = await h.tool.execute({ title: '老会话一' })
  if (h.calls.length !== 1 || h.calls[0].id !== 's1') fail('标题匹配应命中 s1: ' + JSON.stringify(h.calls))
  h.dispose()
}

// ---- 5. busy 会话不压缩，给可执行提示 ----
{
  const h = harness({ agentList: [busyAgent('b1', '正在跑')] })
  const value = await h.tool.execute({ sessionId: 'b1' })
  if (h.calls.length !== 0) fail('busy 会话不该调用压缩')
  if (value.results[0].reason !== 'busy') fail('应报 busy，实际: ' + JSON.stringify(value.results[0]))
  if (!/空闲/.test(value.results[0].message)) fail('busy 提示应说明需要空闲状态')
  h.dispose()
}

// ---- 6. 未加载的会话如实报 unloaded ----
{
  const h = harness()
  const value = await h.tool.execute({ sessionId: 'not-here' })
  if (value.reason !== 'unloaded') fail('应报 unloaded，实际: ' + JSON.stringify(value))
  if (!/点开|resume/.test(value.message)) fail('unloaded 提示应说明如何加载')
  h.dispose()
}

// ---- 7. compactNow 返回 null（无可压历史） ----
{
  const h = harness({ compactNull: true })
  const value = await h.tool.execute({ sessionId: 's1' })
  if (!value.ok || value.results[0].compacted !== false) fail('null 应视为无可压历史')
  h.dispose()
}

// ---- 7b. 宿主判定「压不出更小摘要」时不算失败 ----
{
  const h = harness({ compactThrows: 'manual compaction could not produce a smaller summary' })
  const value = await h.tool.execute({ sessionId: 's1' })
  if (value.results[0].reason !== 'nothing-to-compact') fail('应识别为无需压缩: ' + JSON.stringify(value.results[0]))
  if (!value.ok) fail('短会话跳过不该算失败')
  h.dispose()
}

// ---- 8. 没有压缩服务时不崩，明确提示 ----
{
  const calls = []
  let tool = null
  const service = {
    compaction: null,
    agents: { list: () => [idleAgent('s1', 'x')], get: () => undefined },
    sessionQuery: { async readTitle() { return undefined }, async listSessions() { return [] } },
    webServer: { register() { return () => {} } },
    tools: { register(d) { tool = d; return () => {} } },
  }
  const ctx = { logger: { info: () => {}, warn: () => {} }, inject(deps, cb) { cb(service); return () => {} } }
  apply(ctx, {})()
  const value = await tool.execute({ sessionId: 's1' })
  if (value.reason !== 'error' && value.results[0].reason !== 'no-compaction-service') {
    fail('无压缩服务应明确提示: ' + JSON.stringify(value))
  }
  void calls
}

// ---- 9. HTTP 接口：GET /sessions 与 POST /compact ----
{
  const h = harness()
  const route = h.routes.find((r) => r.path === '/api/compact-old')
  const call = async (method, path, body) => {
    let status = 0, out = ''
    const req = { method, url: path, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } }
    await route.handler(req, { writeHead(c) { status = c }, end(t) { out = String(t) } })
    return { status, body: JSON.parse(out) }
  }
  const g = await call('GET', '/api/compact-old/sessions')
  if (g.status !== 200 || g.body.live.length !== 2) fail('GET /sessions 不对')
  const p = await call('POST', '/api/compact-old/compact', { sessionId: 's1' })
  if (p.status !== 200 || !p.body.ok) fail('POST /compact 不对: ' + JSON.stringify(p.body))
  if (h.calls.length !== 1) fail('POST 应触发一次压缩')
  const missing = await call('POST', '/api/compact-old/compact', { sessionId: 'nope' })
  if (missing.body.reason !== 'unloaded') fail('POST 未加载应报 unloaded')
  h.dispose()
}

console.log(JSON.stringify({ ok: !process.exitCode }, null, 2))
