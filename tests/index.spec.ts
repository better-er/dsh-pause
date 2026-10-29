/**
 * dsh-pause host apply 的接线级测试。
 * 用桩 ctx 捕获 agent/pre-step 监听与 RPC 处理器。
 * 驱动「暂停 → RPC release 放行 → next() 放行该步」「带文字放行并入 user 消息」与「无暂停点时立即 steer」三条路径。
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

/** 附件服务桩：记录准入输入，把图片换成固定的持久引用。 */
function fakeAttachments() {
  const state: { input: unknown[] } = { input: [] }
  return {
    state,
    store: {
      async admitPromptContent(parts: any[]) {
        state.input = parts
        return parts.map((part) => part.type === 'text'
          ? part
          : { type: 'image', attachment: { attachmentId: 'sha256:test', mediaType: part.mediaType, bytes: 3, width: 1, height: 1 } })
      },
    },
  }
}

/** 造一个桩 ctx：捕获 apply 注册的 pre-step 监听，并接住自注册的 prefix 路由。 */
function harness(enabledDefault = false, withAgents = true, withAgentPayload = true) {
  let preStepListener: PreStepListener | undefined
  let statusListener: ((payload: any) => void) | undefined
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
  const attachments = fakeAttachments()
  const steered: { sessionId: string; message: any }[] = []
  let steerThrows = false
  const inboxes = new Map<string, { nextStep: any[]; nextTurn: any[] }>()
  const inboxOf = (id: string) => {
    let inbox = inboxes.get(id)
    if (inbox === undefined) {
      inbox = { nextStep: [], nextTurn: [] }
      inboxes.set(id, inbox)
    }
    return inbox
  }
  const takeFromInbox = (id: string, message: any) => {
    const inbox = inboxOf(id)
    const index = inbox.nextStep.findIndex((item) => item.id === message.id)
    if (index >= 0) inbox.nextStep.splice(index, 1)
  }
  const agentOf = (id: string) => ({
    id,
    inbox: inboxOf(id),
    steer(message: any) {
      if (steerThrows) throw new Error('steer failed')
      steered.push({ sessionId: id, message })
      inboxOf(id).nextStep.push(message)
    },
  })
  const agents = { get: (sessionId: string) => agentOf(sessionId) }
  const ctx = {
    on(_name: string, listener: any) {
      if (_name === 'agent/pre-step') preStepListener = listener as PreStepListener
      if (_name === 'agent/status') statusListener = listener as (payload: any) => void
      return () => true
    },
    inject(_deps: string[], cb: (s: unknown) => void) { cb(scope) },
    get(name: string) {
      if (name === 'attachments') return attachments.store
      return name === 'agents' && withAgents ? agents : undefined
    },
    agents: withAgents ? agents : undefined,
  }
  apply(ctx as any, { defaultEnabled: enabledDefault })
  return {
    preStep(payload: any, next: () => Promise<any>) {
      const agent = withAgentPayload ? agentOf(payload.agent.id) : payload.agent
      return preStepListener!({ ...payload, agent }, next)
    },
    status(payload: any) { statusListener!(payload) },
    claim(sessionId: string, message: any) { takeFromInbox(sessionId, message) },
    discard(sessionId: string, message: any) { takeFromInbox(sessionId, message) },
    enqueueTurn(sessionId: string, message: any) { inboxOf(sessionId).nextTurn.push(message) },
    steered,
    setSteerThrows(value: boolean) { steerThrows = value },
    attachments,
  }
}

describe('apply host wiring', () => {
  it('开关关时 pre-step 直接放行不挂暂停点', async () => {
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

  it('开启+续跑时挂暂停点，release 空文字后原样放行', async () => {
    const h = harness(true)
    // 模拟 driver 在 await pre-step；先开 listener 后放行
    const base = { kind: 'enter' as const, messages: [] }
    let nextCalledAfter = false
    const p = h.preStep(
      { agent: { id: 's1' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => { nextCalledAfter = true; return base },
    )
    // next 尚未被调用，说明暂停点被挂住
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

  it('带图放行：图片经附件服务准入后与文字并入同一条 user 消息', async () => {
    const h = harness(true)
    const base = { kind: 'enter' as const, messages: [] }
    const p = h.preStep(
      { agent: { id: 's4' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => base,
    )
    await Promise.resolve()
    const rel = await rpc('release', {
      sessionId: 's4',
      text: ' 看这张图 ',
      images: [{ mediaType: 'image/png', data: 'AAAA', name: 'a.png' }],
    })
    expect(rel.ok).toBe(true)
    expect(rel.value.released).toBe(true)
    expect(h.attachments.state.input).toEqual([
      { type: 'text', text: '看这张图' },
      { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'a.png' },
    ])
    const decision = await p
    expect(decision.messages).toHaveLength(1)
    expect(decision.messages[0].content).toMatchObject([
      { type: 'text', text: '看这张图' },
      { type: 'image', attachment: { mediaType: 'image/png' } },
    ])
  })

  it('图片类型非法时拒绝放行且暂停点保持', async () => {
    const h = harness(true)
    const base = { kind: 'enter' as const, messages: [] }
    const p = h.preStep(
      { agent: { id: 's5' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => base,
    )
    await Promise.resolve()
    const rel = await rpc('release', {
      sessionId: 's5',
      text: '',
      images: [{ mediaType: 'image/svg+xml', data: 'AAAA' }],
    })
    expect(rel.ok).toBe(false)
    expect((await rpc('status', { sessionId: 's5' })).value.paused).toBe(true)
    // 收尾：关闭开关放行，避免测试留下悬挂的 Promise。
    await rpc('setEnabled', { sessionId: 's5', enabled: false })
    await p
  })

  it('没有暂停点时空回车不 steer', async () => {
    const h = harness(true)
    const rel = await rpc('release', { sessionId: 's6', text: '   ' })
    expect(rel.value).toMatchObject({ released: false, delivered: false })
    expect(h.steered).toHaveLength(0)
  })

  it('没有暂停点时立即 steer，不排队', async () => {
    const h = harness(true)
    const rel = await rpc('release', { sessionId: 's7', text: ' 立刻发 ' })
    expect(rel.value).toMatchObject({ released: false, delivered: true })
    expect(h.steered).toHaveLength(1)
    expect(h.steered[0]!.sessionId).toBe('s7')
    expect(h.steered[0]!.message.content).toMatchObject([{ type: 'text', text: '立刻发' }])
  })

  it('没有暂停点且没有活 agent 时返回未送达', async () => {
    harness(true, false)
    const rel = await rpc('release', { sessionId: 's8', text: '先别丢' })
    expect(rel.value).toMatchObject({ released: false, delivered: false })
  })

  it('pre-step 记住的 agent 在没有 agents 服务时也能立即 steer', async () => {
    const h = harness(true, false)
    await h.preStep(
      { agent: { id: 's12' }, turn: 1, step: 1, signal: new AbortController().signal, messages: [] },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const rel = await rpc('release', { sessionId: 's12', text: '还能发' })
    expect(rel.value).toMatchObject({ released: false, delivered: true })
    expect(h.steered).toHaveLength(1)
    expect(h.steered[0]!.message.content).toMatchObject([{ type: 'text', text: '还能发' }])
  })

  it('插话未认领时开启暂停也不暂停', async () => {
    const h = harness(true)
    await rpc('release', { sessionId: 's20', text: '插一句' })
    const decision = await h.preStep(
      { agent: { id: 's20' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('插话刚被认领时打开暂停仍放行该步', async () => {
    const h = harness(true)
    await rpc('release', { sessionId: 's21', text: '插一句' })
    const message = h.steered[0]!.message
    h.claim('s21', message)
    const decision = await h.preStep(
      { agent: { id: 's21' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [message] },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('下一轮队列里已有消息时这一轮也不再暂停', async () => {
    const h = harness(true)
    h.enqueueTurn('s23', { id: 'm1', role: 'user', content: [] })
    const decision = await h.preStep(
      { agent: { id: 's23' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('插话被丢弃后恢复暂停', async () => {
    const h = harness(true)
    await rpc('release', { sessionId: 's22', text: '插一句' })
    h.discard('s22', h.steered[0]!.message)
    const base = { kind: 'enter' as const, messages: [] }
    const p = h.preStep(
      { agent: { id: 's22' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => base,
    )
    await Promise.resolve()
    expect((await rpc('status', { sessionId: 's22' })).value.paused).toBe(true)
    await rpc('release', { sessionId: 's22', text: '' })
    await expect(p).resolves.toEqual(base)
  })

  it('暂停点放行后该步 reject 时重新 steer', async () => {
    const h = harness(true)
    const p = h.preStep(
      { agent: { id: 's9' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => ({ kind: 'reject' as const }),
    )
    await Promise.resolve()
    await rpc('release', { sessionId: 's9', text: '别丢' })
    await expect(p).resolves.toEqual({ kind: 'reject' })
    expect(h.steered).toHaveLength(1)
    expect(h.steered[0]!.message.content).toMatchObject([{ type: 'text', text: '别丢' }])
  })

  it('该步 reject 且没有活 agent 时写错误日志', async () => {
    const h = harness(true, false, false)
    const errors: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      const p = h.preStep(
        { agent: { id: 's10' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
        async () => ({ kind: 'reject' as const }),
      )
      await Promise.resolve()
      await rpc('release', { sessionId: 's10', text: '会丢' })
      await expect(p).resolves.toEqual({ kind: 'reject' })
    } finally {
      console.error = original
    }
    expect(errors).toHaveLength(1)
  })

  it('steer 抛错时 RPC 返回错误，草稿由客户端保留', async () => {
    const h = harness(true)
    h.setSteerThrows(true)
    const rel = await rpc('release', { sessionId: 's11', text: '发不出去' })
    expect(rel.ok).toBe(false)
  })

  it('RPC 参数校验返回 error', async () => {
    harness(true)
    const bad = await rpc('release', { text: 'x' })
    expect(bad.ok).toBe(false)
  })

  it('暂停中把开关关闭会放行正挂着的暂停点，不卡死', async () => {
    const h = harness(true)
    const base = { kind: 'enter' as const, messages: [] }
    const p = h.preStep(
      { agent: { id: 's3' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => base,
    )
    await Promise.resolve()
    const before = await rpc('status', { sessionId: 's3' })
    expect(before.value.paused).toBe(true)
    // 关闭开关：应放行暂停点并让 pre-step 走完
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
