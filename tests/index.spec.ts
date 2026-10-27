/**
 * dsh-pause host apply 的接线级测试。
 * 用桩 ctx 捕获 agent/pre-step 监听与 RPC 处理器。
 * 驱动「暂停 → RPC release 放行 → next() 放行该步」与「带文字放行并入 user 消息」两条路径。
 */
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

type PreStepListener = (payload: any, next: () => Promise<any>) => Promise<any>
type StatusListener = (payload: { agent: { id: string }; status: 'idle' | 'running' }) => void
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
function harness(enabledDefault = false) {
  let preStepListener: PreStepListener | undefined
  let statusListener: StatusListener | undefined
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
  const ctx = {
    on(_name: string, listener: any) {
      if (_name === 'agent/pre-step') preStepListener = listener as PreStepListener
      if (_name === 'agent/status') statusListener = listener as StatusListener
      return () => true
    },
    inject(_deps: string[], cb: (s: unknown) => void) { cb(scope) },
    get(name: string) { return name === 'attachments' ? attachments.store : undefined },
  }
  const followed: { sessionId: string; message: any }[] = []
  apply(ctx as any, { defaultEnabled: enabledDefault })
  return {
    get preStep() { return preStepListener! },
    status(sessionId: string, status: 'idle' | 'running', followupThrows = false) {
      statusListener!({
        agent: {
          id: sessionId,
          followup(message: any) {
            if (followupThrows) throw new Error('followup failed')
            followed.push({ sessionId, message })
          },
        },
        status,
      })
    },
    followed,
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

  it('没有暂停点且空闲时 release 返回 released:false 与 busy:false', async () => {
    harness(true)
    const rel = await rpc('release', { sessionId: 'nobody', text: '' })
    expect(rel.value).toMatchObject({ released: false, busy: false, queued: false })
  })

  it('没有暂停点但在跑时把插话排进队列，下一个暂停点自动并入', async () => {
    const h = harness(true)
    h.status('s6', 'running')
    const queued = await rpc('release', { sessionId: 's6', text: ' 赶在暂停点前面 ' })
    expect(queued.value).toMatchObject({ released: false, busy: true, queued: true })
    expect((await rpc('status', { sessionId: 's6' })).value.pendingMessageCount).toBe(1)

    // 暂停点还没挂上时不必再按回车：这一步会直接带走队列里的消息。
    const p = h.preStep(
      { agent: { id: 's6' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const decision = await p
    expect(decision.messages).toHaveLength(1)
    expect(decision.messages[0].content).toMatchObject([{ type: 'text', text: '赶在暂停点前面' }])
    expect((await rpc('status', { sessionId: 's6' })).value.pendingMessageCount).toBe(0)
  })

  it('没有暂停点且在跑时空回车不排队', async () => {
    const h = harness(true)
    h.status('s7', 'running')
    const rel = await rpc('release', { sessionId: 's7', text: '' })
    expect(rel.value).toMatchObject({ released: false, busy: true, queued: false })
    expect((await rpc('status', { sessionId: 's7' })).value.pendingMessageCount).toBe(0)
  })

  it('turn 结束时排队的插话由 followup 当场发出', async () => {
    const h = harness(true)
    h.status('s8', 'running')
    await rpc('release', { sessionId: 's8', text: '没赶上' })
    expect(h.followed).toHaveLength(0)
    h.status('s8', 'idle')
    await Promise.resolve()
    expect(h.followed).toHaveLength(1)
    expect(h.followed[0]!.sessionId).toBe('s8')
    expect(h.followed[0]!.message.content).toMatchObject([{ type: 'text', text: '没赶上' }])
    expect((await rpc('status', { sessionId: 's8' })).value.pendingMessageCount).toBe(0)
  })

  it('插话已被下一个暂停点带走时 idle 不再重复 followup', async () => {
    const h = harness(true)
    h.status('s9', 'running')
    await rpc('release', { sessionId: 's9', text: '插一句' })
    await h.preStep(
      { agent: { id: 's9' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => ({ kind: 'enter', messages: [] }),
    )
    h.status('s9', 'idle')
    await Promise.resolve()
    expect(h.followed).toHaveLength(0)
  })

  it('没有暂停点、空闲且尚无 agent 引用时返回未送达，不入队', async () => {
    const h = harness(true)
    const rel = await rpc('release', { sessionId: 's10', text: '先别丢' })
    expect(rel.value).toMatchObject({ released: false, busy: false, queued: false })
    expect((await rpc('status', { sessionId: 's10' })).value.pendingMessageCount).toBe(0)
  })

  it('没有暂停点、空闲且已有 agent 引用时 release 直接 followup', async () => {
    const h = harness(true)
    h.status('s12', 'idle')
    const rel = await rpc('release', { sessionId: 's12', text: '直接发' })
    expect(rel.value).toMatchObject({ released: false, busy: false, queued: true })
    expect(h.followed).toHaveLength(1)
    expect(h.followed[0]!.message.content).toMatchObject([{ type: 'text', text: '直接发' }])
  })

  it('暂停点放行后该步 reject，插话放回队列并在 idle 补发', async () => {
    const h = harness(true)
    const p = h.preStep(
      { agent: { id: 's13' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => ({ kind: 'reject' as const }),
    )
    await Promise.resolve()
    await rpc('release', { sessionId: 's13', text: '别丢' })
    await expect(p).resolves.toEqual({ kind: 'reject' })
    expect((await rpc('status', { sessionId: 's13' })).value.pendingMessageCount).toBe(1)
    h.status('s13', 'idle')
    await Promise.resolve()
    expect(h.followed).toHaveLength(1)
    expect(h.followed[0]!.message.content).toMatchObject([{ type: 'text', text: '别丢' }])
  })

  it('预放行时 next 抛错，队列放回', async () => {
    const h = harness(true)
    h.status('s14', 'running')
    await rpc('release', { sessionId: 's14', text: '放回' })
    await expect(h.preStep(
      { agent: { id: 's14' }, turn: 1, step: 2, signal: new AbortController().signal, messages: [] },
      async () => { throw new Error('driver failed') },
    )).rejects.toThrow('driver failed')
    expect((await rpc('status', { sessionId: 's14' })).value.pendingMessageCount).toBe(1)
  })

  it('idle 补发失败时插话放回队列，下一次派发再试', async () => {
    const h = harness(true)
    h.status('s15', 'running')
    await rpc('release', { sessionId: 's15', text: '重试' })
    h.status('s15', 'idle', true)
    await Promise.resolve()
    expect((await rpc('status', { sessionId: 's15' })).value.pendingMessageCount).toBe(1)
    h.status('s15', 'idle')
    await Promise.resolve()
    expect(h.followed).toHaveLength(1)
    expect(h.followed[0]!.message.content).toMatchObject([{ type: 'text', text: '重试' }])
  })

  it('空闲状态重复推送时待发队列只补发一次', async () => {
    const h = harness(true)
    h.status('s11', 'running')
    await rpc('release', { sessionId: 's11', text: '只发一次' })
    h.status('s11', 'idle')
    await Promise.resolve()
    h.status('s11', 'idle')
    await Promise.resolve()
    expect(h.followed).toHaveLength(1)
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
