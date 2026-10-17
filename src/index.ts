import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_ENABLED, PauseRegistry, textToMessage } from './controller.ts'
import { mountRpcChannel, type RpcChannelHandler, type RpcChannelResult } from './rpc-channel.ts'

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

  const handler: RpcChannelHandler = async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'setEnabled': {
          const { sessionId, enabled } = payload as EnableBody
          if (typeof sessionId !== 'string' || typeof enabled !== 'boolean') return rpcError('setEnabled requires sessionId:string, enabled:boolean')
          registry.setEnabled(sessionId, enabled)
          // 关闭开关时应放行任何正挂着的门，避免 driver 卡在暂停态无法前进。
          if (!enabled && registry.isPaused(sessionId)) registry.release(sessionId, undefined)
          return ok({ paused: registry.isPaused(sessionId) })
        }
        case 'release': {
          const { sessionId, text, images } = payload as ReleaseBody
          if (typeof sessionId !== 'string') return rpcError('release requires sessionId:string')
          // 没有门时直接返回，避免白存图片留下无主附件。
          if (!registry.isPaused(sessionId)) return ok({ released: false })
          const message = await buildReleaseMessage(ctx, text, images)
          return ok({ released: registry.release(sessionId, message) })
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
  // connection.rpc.handle 自 0.1.2-rc.1 起即不可用，登记路由时解析 webServer 会抛 without inject，故改为插件自注册通道。
  mountRpcChannel(ctx, '/dsh-pause', handler)

  ctx.on('agent/pre-step', async (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => {
    const sessionId = payload.agent.id
    const state = registry.stateFor(sessionId)
    if (payload.step <= 1 || !state.enabled) return next()

    let resolveGate: (message: UserMessage | undefined) => void = () => {}
    let rejectGate: (reason: unknown) => void = () => {}
    const gate = new Promise<UserMessage | undefined>((resolve, reject) => { resolveGate = resolve; rejectGate = reject })
    registry.armGate(sessionId, { resolve: resolveGate, reject: rejectGate })

    const onAbort = (): void => { registry.abortGate(sessionId, payload.signal.reason) }
    if (payload.signal.aborted) onAbort()
    else payload.signal.addEventListener('abort', onAbort, { once: true })

    let carried: UserMessage | undefined
    try { carried = await gate } catch { /* aborted */ } finally { payload.signal.removeEventListener('abort', onAbort) }

    const decision = await next()
    if (decision.kind === 'reject') return decision
    return carried === undefined ? decision : { ...decision, messages: [...decision.messages, carried] }
  })
}

export { PauseRegistry } from './controller.ts'
export { shouldPause, textToMessage, initialSessionState, DEFAULT_ENABLED } from './controller.ts'
export type { PauseSessionState, ReleaseRequest } from './controller.ts'
