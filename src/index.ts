import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import '@deepseek-ai/dsh-client-connection'
import { transportError } from '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcHandler, HostConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_ENABLED, PauseRegistry, textToMessages } from './controller.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(this: never, payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
  }
}

export const name = 'dsh-pause'

/** 本插件需要的主机服务。connection 是 host 与浏览器共享的 RPC 载体。 */
export const inject = ['connection']

export interface Config { defaultEnabled?: boolean }
export const Config: z<Config> = z.object({ defaultEnabled: z.boolean().default(DEFAULT_ENABLED) })

interface PreStepPayload {
  agent: { id: string }
  turn: number
  step: number
  signal: AbortSignal
  messages: UserMessage[]
}
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }

interface ReleaseBody { sessionId?: unknown; text?: unknown }
interface EnableBody { sessionId?: unknown; enabled?: unknown }
interface StatusBody { sessionId?: unknown }

function ok(value: unknown): ConnectionRpcResult<unknown> { return { ok: true, value } }
function rpcError(message: string): ConnectionRpcResult<unknown> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

export function apply(ctx: Context, config: Config = {}): void {
  const defaultEnabled = config.defaultEnabled === true
  const registry = new PauseRegistry(defaultEnabled)

  const connection = (ctx as unknown as { connection?: HostConnectionHandle }).connection
  if (connection !== undefined) {
    const handler: ConnectionRpcHandler = async (endpoint, payload) => {
      try {
        switch (endpoint) {
          case 'setEnabled': {
            const { sessionId, enabled } = payload as EnableBody
            if (typeof sessionId !== 'string' || typeof enabled !== 'boolean') return rpcError('setEnabled requires sessionId:string, enabled:boolean')
            registry.setEnabled(sessionId, enabled)
            // 关闭开关时应放行任何正挂着的门，避免 driver 卡在暂停态无法前进。
            if (!enabled && registry.isPaused(sessionId)) registry.release(sessionId, '')
            return ok({ paused: registry.isPaused(sessionId) })
          }
          case 'release': {
            const { sessionId, text } = payload as ReleaseBody
            if (typeof sessionId !== 'string') return rpcError('release requires sessionId:string')
            const carried = typeof text === 'string' ? text : ''
            const released = registry.release(sessionId, carried)
            return ok({ released })
          }
          case 'status': {
            const { sessionId } = payload as StatusBody
            if (typeof sessionId !== 'string') return rpcError('status requires sessionId:string')
            return ok({ enabled: registry.enabled(sessionId), paused: registry.isPaused(sessionId) })
          }
          default: return rpcError('unknown endpoint ' + endpoint)
        }
      } catch (error) {
        return rpcError(error instanceof Error ? error.message : String(error))
      }
    }
    ctx.effect(() => connection.rpc.handle('/dsh-pause', handler), 'dsh-pause: rpc')
  }

  ctx.on('agent/pre-step', async (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => {
    const sessionId = payload.agent.id
    const state = registry.stateFor(sessionId)
    if (payload.step <= 1 || !state.enabled) return next()

    let resolveGate: (text: string) => void = () => {}
    let rejectGate: (reason: unknown) => void = () => {}
    const gate = new Promise<string>((resolve, reject) => { resolveGate = resolve; rejectGate = reject })
    registry.armGate(sessionId, { resolve: resolveGate, reject: rejectGate })

    const onAbort = (): void => { registry.abortGate(sessionId, payload.signal.reason) }
    if (payload.signal.aborted) onAbort()
    else payload.signal.addEventListener('abort', onAbort, { once: true })

    let carried = ''
    try { carried = await gate } catch { /* aborted */ } finally { payload.signal.removeEventListener('abort', onAbort) }

    const decision = await next()
    if (decision.kind === 'reject') return decision
    const extra = textToMessages(carried)
    return extra.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...extra] }
  })
}

export { PauseRegistry } from './controller.ts'
export { shouldPause, textToMessages, initialSessionState, DEFAULT_ENABLED } from './controller.ts'
export type { PauseSessionState, ReleaseRequest } from './controller.ts'
