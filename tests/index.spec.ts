/**
 * dsh-pause host apply 的接线级测试。
 * 用桩 ctx 捕获 agent/pre-step 监听与 RPC 处理器。
 * 驱动「暂停 → RPC release 放行 → next() 放行该步」与「带文字放行并入 user 消息」两条路径。
 */
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

type PreStepListener = (payload: any, next: () => Promise<any>) => Promise<any>
type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>

/** apply 自注册的路由处理器，由最近一次 harness 捕获。 */
let routeHandler: RouteHandler | undefined

const server = http.createServer((req, res) => { void routeHandler?.(req, res) })
let port = 0

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(() => { server.close() })

/** 打一次本通道 RPC，返回信封里的 result。 */
async function rpc(method: string, payload: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}/dsh-pause/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }),
  })
  const body = await response.json() as { result: any }
  return body.result
}

/** 造一个桩 ctx：捕获 apply 注册的 pre-step 监听，并接住自注册的 prefix 路由。 */
function harness(enabledDefault = false) {
  let preStepListener: PreStepListener | undefined
  const scope = {
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route: { handler: RouteHandler }) {
        routeHandler = route.handler
        return () => {}
      },
    },
    effect(cb: () => unknown) { return cb() },
  }
  const ctx = {
    on(_name: string, listener: any) {
      if (_name === 'agent/pre-step') preStepListener = listener as PreStepListener
      return () => true
    },
    inject(_deps: string[], cb: (s: unknown) => void) { cb(scope) },
  }
  apply(ctx as any, { defaultEnabled: enabledDefault })
  return { get preStep() { return preStepListener! } }
}

describe('apply host wiring', () => {
  it('开关关时 pre-step 直接放行不拉门', async () => {
    const h = harness(false)
    let calledNext = false
    const decision = await h.preStep(
      { agent: { id: 's1' }, turn: 1, step: 3, signal: new AbortController().signal, messages: [] },
      async () => { calledNext = true; return { kind: 'enter', messages: [] } },
    )
    expect(calledNext).toBe(true)
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('首步即 step=1 即使开关开也直接放行', async () => {
    const h = harness(true)
    let calledNext = false
    await h.preStep(
      { agent: { id: 's1' }, turn: 1, step: 1, signal: new AbortController().signal, messages: [] },
      async () => { calledNext = true; return { kind: 'enter', messages: [] } },
    )
    expect(calledNext).toBe(true)
  })

  it('开启+续跑时拉门，release 空文字后原样放行', async () => {
    const h = harness(true)
    // 模拟 driver 在 await pre-step；先开 listener 后放行
    const base = { kind: 'enter' as const, messages: [] }
    let nextCalledAfter = false
    const p = h.preStep(
      { agent: { id: 's1' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => { nextCalledAfter = true; return base },
    )
    // next 尚未被调用，说明门被拉住
    await Promise.resolve()
    expect(nextCalledAfter).toBe(false)
    // RPC status 应报 paused
    const statusBefore = await rpc('status', { sessionId: 's1' })
    expect(statusBefore.value.paused).toBe(true)
    // RPC release 空文字
    const rel = await rpc('release', { sessionId: 's1', text: '' })
    expect(rel.value.released).toBe(true)
    const decision = await p
    expect(nextCalledAfter).toBe(true)
    expect(decision).toEqual(base)
  })

  it('带文字放行：并入一条 user 消息', async () => {
    const h = harness(true)
    const base = { kind: 'enter' as const, messages: [] }
    const p = h.preStep(
      { agent: { id: 's2' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => base,
    )
    await Promise.resolve()
    await rpc('release', { sessionId: 's2', text: ' 先别跑，我再想想  ' })
    const decision = await p
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(1)
    expect(decision.messages[0].content).toMatchObject([{ type: 'text', text: '先别跑，我再想想' }])
  })

  it('无门时 release 返回 released:false', async () => {
    harness(true)
    const rel = await rpc('release', { sessionId: 'nobody', text: '' })
    expect(rel.value.released).toBe(false)
  })

  it('RPC 参数校验返回 error', async () => {
    harness(true)
    const bad = await rpc('release', { text: 'x' })
    expect(bad.ok).toBe(false)
  })

  it('暂停中把开关关闭会放行正挂着的门，不卡死', async () => {
    const h = harness(true)
    const base = { kind: 'enter' as const, messages: [] }
    const p = h.preStep(
      { agent: { id: 's3' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => base,
    )
    await Promise.resolve()
    const before = await rpc('status', { sessionId: 's3' })
    expect(before.value.paused).toBe(true)
    // 关闭开关：应放行门并让 pre-step 走完
    const off = await rpc('setEnabled', { sessionId: 's3', enabled: false })
    expect(off.value.paused).toBe(false)
    const decision = await p
    expect(decision).toEqual(base)
  })

  it('空端点返回 404', async () => {
    harness(true)
    const response = await fetch(`http://127.0.0.1:${port}/dsh-pause/`)
    expect(response.status).toBe(404)
  })
})
