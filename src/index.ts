/**
 * dsh-pause 主机半身：暂停控制器与判定。
 *
 * 核心语义：在 agent 每轮 step 进入前的 agent/pre-step 事件里判断这次请求是否为工具交互后的续跑。
 * 若是续跑且开关开启，则挂起一个暂停点，等人类经 release 原语放行后才把这一次请求发出去。
 * 放行时可带补充文字，作为一条 user 消息并入本 step 的 messages，让模型在紧接着的请求里看到它。
 *
 * 暂停点只卡在请求真正发出之前，因此不打断任何在途 API 调用。
 * 暂停点还没挂上时按回车发出的插话一律立即交给 agent.steer()，由 dsh 在最近一步认领；空闲时 steer 自己开新 turn。
 * 插件不缓存插话，也不做补发；只有该步被 reject 时把已并入的消息重新 steer 一次，失败写日志。
 * driver 组装好的上下文原样放行，不插入、不删除、不改写任何模型可见的痕迹，模型无感知暂停。
 *
 * @module dsh-pause
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_ENABLED, PauseRegistry, textToMessage } from './controller.ts'
import { mountRpcChannel, type RpcChannelHandler, type RpcChannelResult } from './rpc-channel.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(this: never, payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
    'agent/status'(this: never, payload: AgentStatusPayload): void
    'agent/inbox/claimed'(this: never, payload: InboxEventPayload): void
    'agent/inbox/discarded'(this: never, payload: InboxEventPayload): void
  }
}

export const name = 'dsh-pause'

/** 本插件需要的主机服务。connection 是 host 与浏览器共享的 RPC 载体，agents 用来把插话 steer 进当前 turn。 */
export const inject = ['connection', 'agents']

export interface Config { defaultEnabled?: boolean }
export const Config: z<Config> = z.object({ defaultEnabled: z.boolean().default(DEFAULT_ENABLED) })

interface PreStepPayload {
  agent: AgentFace & { id: string }
  turn: number
  step: number
  signal: AbortSignal
  messages: UserMessage[]
}
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }

/** agent 的插话入口：steer 在最近一步认领，空闲时自己开新 turn。 */
interface AgentFace {
  steer(message: UserMessage): void
}

/** 活 agent 注册表的最小面。 */
interface AgentRegistryFace {
  get(sessionId: string): AgentFace | undefined
}

/** agent/status 的载荷，带的 agent 可直接 steer。 */
interface AgentStatusPayload {
  agent: AgentFace & { id: string }
  status: 'idle' | 'running'
}

/** inbox 认领与丢弃事件的载荷。 */
interface InboxEventPayload {
  agent: AgentFace & { id: string }
  message: UserMessage
}

/** 浏览器可随插话提交的图片媒体类型，与附件服务的准入集合一致。 */
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 浏览器提交的一张未准入图片，data 为规范 base64。 */
interface PromptImagePart {
  readonly type: 'image'
  readonly mediaType: ImageMediaType
  readonly data: string
  readonly name?: string
}

/** 待准入的 prompt 片段：文字与未持久化图片。 */
type PromptPart = { readonly type: 'text'; readonly text: string } | PromptImagePart

/** 附件服务准入后的片段，图片已换成持久引用。 */
type AdmittedPromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image' | 'file'; readonly attachment: unknown }

/** 本插件用到的附件服务最小面，避免为类型引入额外包。 */
interface AttachmentStoreFace {
  admitPromptContent(content: readonly PromptPart[]): Promise<readonly AdmittedPromptPart[]>
}

interface ReleaseBody { sessionId?: unknown; text?: unknown; images?: unknown }
interface EnableBody { sessionId?: unknown; enabled?: unknown }
interface StatusBody { sessionId?: unknown }

function ok(value: unknown): RpcChannelResult { return { ok: true, value } }
function rpcError(message: string): RpcChannelResult {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/** 读取活 agent 注册表，用于把插话立即 steer 进当前 turn。 */
function agentRegistry(ctx: Context): AgentRegistryFace | undefined {
  const get = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get
  if (typeof get === 'function') {
    const service = get.call(ctx, 'agents', false) as AgentRegistryFace | undefined
    if (service !== undefined) return service
  }
  return (ctx as unknown as { agents?: AgentRegistryFace }).agents
}

/** 读取附件服务。RPC 测试桩或裁剪运行环境可能没有它，此时带图插话会明确报错。 */
function attachmentStore(ctx: Context): AttachmentStoreFace | undefined {
  const get = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get
  if (typeof get !== 'function') return undefined
  return get.call(ctx, 'attachments', false) as AttachmentStoreFace | undefined
}

/** 校验并解包浏览器送来的图片列表，非法输入直接抛错，由 RPC 层转成错误信封。 */
function readImages(raw: unknown): PromptImagePart[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('release 的 images 必须是数组')
  return raw.map((entry: unknown, index: number): PromptImagePart => {
    if (entry === null || typeof entry !== 'object') throw new Error(`release 的 images[${index}] 必须是对象`)
    const { mediaType, data, name } = entry as { mediaType?: unknown; data?: unknown; name?: unknown }
    if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(mediaType)) throw new Error(`release 的 images[${index}] 媒体类型不受支持`)
    if (typeof data !== 'string' || data === '') throw new Error(`release 的 images[${index}] 缺少 base64 数据`)
    if (name !== undefined && typeof name !== 'string') throw new Error(`release 的 images[${index}] 文件名必须是字符串`)
    const part: PromptImagePart = { type: 'image', mediaType: mediaType as ImageMediaType, data }
    return name === undefined ? part : { ...part, name }
  })
}

/**
 * 把放行时携带的文字与图片组成一条待并入的用户消息。
 * 图片先经附件服务持久化，得到的持久引用随消息进入会话日志，浏览器侧的临时草稿随后释放。
 * @param ctx 插件上下文，用于取附件服务。
 * @param textRaw 浏览器送来的补充文字，非字符串按空处理。
 * @param imagesRaw 浏览器送来的图片列表，可为空。
 * @returns 待并入的用户消息；文字与图片皆空时 undefined，表示无感继续。
 */
async function buildReleaseMessage(ctx: Context, textRaw: unknown, imagesRaw: unknown): Promise<UserMessage | undefined> {
  const text = typeof textRaw === 'string' ? textRaw.trim() : ''
  const images = readImages(imagesRaw)
  if (text === '' && images.length === 0) return undefined
  if (images.length === 0) return textToMessage(text)

  const store = attachmentStore(ctx)
  if (store === undefined) throw new Error('带图放行需要附件服务，当前环境未提供')
  const parts: PromptPart[] = []
  if (text !== '') parts.push({ type: 'text', text })
  parts.push(...images)
  const admitted = await store.admitPromptContent(parts)
  const content = admitted.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: part.type, attachment: part.attachment })
  return createUserMessage({ content: content as ContentBlock[], source: { kind: 'user' } })
}

export function apply(ctx: Context, config: Config = {}): void {
  const defaultEnabled = config.defaultEnabled === true
  const registry = new PauseRegistry(defaultEnabled)

  // 插话要立即 steer，所以得拿到活 agent。热加载或时序原因可能读不到 agents 服务，pre-step 与 status 的载荷都带活 agent，一并记住。
  const liveAgents = new Map<string, AgentFace>()
  const agentFor = (sessionId: string): AgentFace | undefined =>
    liveAgents.get(sessionId) ?? agentRegistry(ctx)?.get(sessionId)

  // 已 steer、还没被 dsh 认领的插话 id；以及刚被认领、还没随某步走完的插话 id。
  // 两种状态都说明用户已经插过话：先让插话送达，暂停等送达后再恢复。
  const pendingSteer = new Map<string, Set<string>>()
  const claimedSteer = new Map<string, Set<string>>()
  const markSteer = (sessionId: string, message: UserMessage): void => {
    let ids = pendingSteer.get(sessionId)
    if (ids === undefined) {
      ids = new Set()
      pendingSteer.set(sessionId, ids)
    }
    ids.add(message.id)
  }

  /** 该步被 reject 时把已并入的消息重新 steer 一次，避免插件缓存或丢失。 */
  const resteer = (sessionId: string, message: UserMessage): void => {
    const agent = agentFor(sessionId)
    if (agent === undefined) {
      console.error('[dsh-pause] 该步已 reject，且没有活 agent 可重新 steer，插话丢失：', message)
      return
    }
    try {
      agent.steer(message)
      markSteer(sessionId, message)
    } catch (error) {
      console.error('[dsh-pause] 该步已 reject，重新 steer 失败，插话丢失：', error)
    }
  }

  const handler: RpcChannelHandler = async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'setEnabled': {
          const { sessionId, enabled } = payload as EnableBody
          if (typeof sessionId !== 'string' || typeof enabled !== 'boolean') return rpcError('setEnabled requires sessionId:string, enabled:boolean')
          registry.setEnabled(sessionId, enabled)
          // 关闭开关时应放行任何正挂着的暂停点，避免 driver 卡在暂停态无法前进。
          if (!enabled && registry.isPaused(sessionId)) registry.release(sessionId, undefined)
          return ok({ paused: registry.isPaused(sessionId) })
        }
        case 'release': {
          const { sessionId, text, images } = payload as ReleaseBody
          if (typeof sessionId !== 'string') return rpcError('release requires sessionId:string')
          const textLength = typeof text === 'string' ? text.trim().length : 0
          const imageCount = Array.isArray(images) ? images.length : 0
          const message = textLength === 0 && imageCount === 0
            ? undefined
            : await buildReleaseMessage(ctx, text, images)
          // 暂停点挂着时放行并把消息并入本步，请求立刻发出。
          if (registry.isPaused(sessionId)) {
            const released = registry.release(sessionId, message)
            return ok({ released, delivered: message !== undefined })
          }
          if (message === undefined) return ok({ released: false, delivered: false })
          // 没有暂停点就立即 steer，不缓存；空闲时 steer 自己开新 turn。
          const agent = agentFor(sessionId)
          if (agent === undefined) {
            console.error('[dsh-pause] 找不到活 agent，无法 steer 插话：', sessionId)
            return ok({ released: false, delivered: false })
          }
          agent.steer(message)
          markSteer(sessionId, message)
          return ok({ released: false, delivered: true })
        }
        case 'status': {
          const { sessionId } = payload as StatusBody
          if (typeof sessionId !== 'string') return rpcError('status requires sessionId:string')
          return ok({
            enabled: registry.enabled(sessionId),
            paused: registry.isPaused(sessionId),
          })
        }
        default: return rpcError('unknown endpoint ' + endpoint)
      }
    } catch (error) {
      return rpcError(error instanceof Error ? error.message : String(error))
    }
  }
  // connection.rpc.handle 自 0.1.2-rc.1 起即不可用，登记路由时解析 webServer 会抛 without inject，故改为插件自注册通道。
  mountRpcChannel(ctx, '/dsh-pause', handler)

  ctx.on('agent/status', (payload: AgentStatusPayload) => {
    liveAgents.set(payload.agent.id, payload.agent)
  })

  ctx.on('agent/inbox/claimed', (payload: InboxEventPayload) => {
    const sessionId = payload.agent.id
    if (pendingSteer.get(sessionId)?.delete(payload.message.id) !== true) return
    let ids = claimedSteer.get(sessionId)
    if (ids === undefined) {
      ids = new Set()
      claimedSteer.set(sessionId, ids)
    }
    ids.add(payload.message.id)
  })

  ctx.on('agent/inbox/discarded', (payload: InboxEventPayload) => {
    const sessionId = payload.agent.id
    pendingSteer.get(sessionId)?.delete(payload.message.id)
    claimedSteer.get(sessionId)?.delete(payload.message.id)
  })

  ctx.on('agent/pre-step', async (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => {
    const sessionId = payload.agent.id
    liveAgents.set(sessionId, payload.agent)
    const state = registry.stateFor(sessionId)
    // 认领后紧跟的这一步就是带插话的一步：先放行，开启暂停时也不拦它。
    const claimed = claimedSteer.get(sessionId)
    if (claimed !== undefined && claimed.size > 0) {
      claimed.clear()
      return next()
    }
    if (payload.step <= 1 || !state.enabled) return next()

    // 插话还在 inbox 里等认领：先让流程走到带插话的那一步，暂停暂不生效。
    const pending = pendingSteer.get(sessionId)
    if (pending !== undefined && pending.size > 0) return next()

    let resolvePausePoint: (message: UserMessage | undefined) => void = () => {}
    let rejectPausePoint: (reason: unknown) => void = () => {}
    const pausePoint = new Promise<UserMessage | undefined>((resolve, reject) => {
      resolvePausePoint = resolve
      rejectPausePoint = reject
    })
    registry.armPausePoint(sessionId, { resolve: resolvePausePoint, reject: rejectPausePoint })

    const onAbort = (): void => { registry.abortPausePoint(sessionId, payload.signal.reason) }
    if (payload.signal.aborted) onAbort()
    else payload.signal.addEventListener('abort', onAbort, { once: true })

    let carried: UserMessage | undefined
    try { carried = await pausePoint } catch { /* aborted */ } finally { payload.signal.removeEventListener('abort', onAbort) }

    let decision: PreStepDecision
    try {
      decision = await next()
    } catch (error) {
      if (carried !== undefined) resteer(sessionId, carried)
      throw error
    }
    if (decision.kind === 'reject') {
      // 这一步被 reject 时放行的插话没有送达本步，立即重新 steer，由 dsh 在下次唤醒时认领。
      if (carried !== undefined) resteer(sessionId, carried)
      return decision
    }
    return carried === undefined ? decision : { ...decision, messages: [...decision.messages, carried] }
  })
}

export { PauseRegistry } from './controller.ts'
export { shouldPause, textToMessage, initialSessionState, DEFAULT_ENABLED } from './controller.ts'
export type { PauseSessionState, PausePoint } from './controller.ts'
