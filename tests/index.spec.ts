/**
 * dsh-pause host apply 的接线级测试。
 * 用桩 ctx 捕获 agent/pre-step 监听与 RPC 处理器。
 * 驱动「暂停 → RPC release 放行 → next() 放行该步」与「带文字放行并入 user 消息」两条路径。
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

type PreStepListener = (payload: any, next: () => Promise<any>) => Promise<any>
type RpcHandler = (endpoint: string, payload: unknown) => Promise<any>

/** 造一个桩 ctx：捕获 apply 注册的 pre-step 监听与 RPC handler。 */
function harness(enabledDefault = false) {
  let preStepListener: PreStepListener | undefined
  let rpcHandler: RpcHandler | undefined
  const effects: Array<() => unknown> = []
  const ctx = {
    on(_name: string, listener: any) {
      if (_name === 'agent/pre-step') preStepListener = listener as PreStepListener
      return () => true
    },
    effect(fn: () => unknown) { effects.push(fn) },
    connection: {
      rpc: {
        handle(_ch: string, h: any) { rpcHandler = h as RpcHandler; return () => Promise.resolve() },
      },
    },
  }
  apply(ctx as any, { defaultEnabled: enabledDefault })
  // 物化 effect 以真正调用 rpc.handle
  for (const fn of effects) void fn()
  return {
    get preStep() { return preStepListener! },
    get rpc() { return rpcHandler! },
  }
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
    const statusBefore = await h.rpc('status', { sessionId: 's1' })
    expect(statusBefore.value.paused).toBe(true)
    // RPC release 空文字
    const rel = await h.rpc('release', { sessionId: 's1', text: '' })
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
    await h.rpc('release', { sessionId: 's2', text: ' 先别跑，我再想想  ' })
    const decision = await p
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(1)
    expect(decision.messages[0].content).toMatchObject([{ type: 'text', text: '先别跑，我再想想' }])
  })

  it('无门时 release 返回 released:false', async () => {
    const h = harness(true)
    const rel = await h.rpc('release', { sessionId: 'nobody', text: '' })
    expect(rel.value.released).toBe(false)
  })

  it('RPC 参数校验返回 error', async () => {
    const h = harness(true)
    const bad = await h.rpc('release', { text: 'x' })
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
    const before = await h.rpc('status', { sessionId: 's3' })
    expect(before.value.paused).toBe(true)
    // 关闭开关：应放行门并让 pre-step 走完
    const off = await h.rpc('setEnabled', { sessionId: 's3', enabled: false })
    expect(off.value.paused).toBe(false)
    const decision = await p
    expect(decision).toEqual(base)
  })
})
