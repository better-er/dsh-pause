/**
 * dsh-pause 暂停控件：挂在 composer 工具行右侧 conversation.input.right。
 *
 * 目标交互：
 * - 开关按钮，本会话总开关。
 * - 开关开启期间，在 composer 主输入框按裸 Enter 一律交主机裁决：有暂停点就继续并带插话，没有暂停点则立即 steer，失败内容暂存而不退回输入框。
 * - 开关关闭时不拦截任何按键，完全透明。
 *
 * dsh 的 composer Enter 由 InputBar 私有 keymap 处理，第三方没有正式 hook 点，故本组件在开关开启期间对所属 composer 挂 document 级 capture-phase keydown，抢在 Lexical 之前拦截裸 Enter。
 *
 * @module dsh-pause/client
 */
import { memo, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DraftAttachmentId, InputActions, InputState, SubmitAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** 注册时注入读条组件、按钮所需的业务面。 */
export interface PauseBarInjected {
  /** Connection RPC 调用器，主机端提供 /dsh-pause。 */
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }>
  }
  /** 把草稿附件序列化成可随插话提交的载荷。 */
  readonly serializeAttachments?: (ids: readonly DraftAttachmentId[]) => Promise<readonly SubmitAttachment[]>
  /** 释放已经送出、不再留在草稿里的附件，避免底层对象与预览 URL 泄漏。 */
  readonly releaseAttachment?: (id: DraftAttachmentId) => void
}

/** conversation.input.right 的 session 作用域组件收到的标准 props + 注入面。 */
export interface PauseControlProps extends PauseBarInjected {
  /** 框架解析出的会话 id。 */
  sessionId: string
  /** 会话输入状态选择器钩子，用于读草稿。 */
  useInput: SnapshotSelectorHook<InputState>
  /** 会话输入动作，用于清空草稿。 */
  inputActions: InputActions
}

/** 主机端返回的会话状态。 */
interface PauseStatus {
  enabled?: boolean
  paused?: boolean
}

async function fetchStatus(rpc: PauseBarInjected['rpc'], sessionId: string): Promise<PauseStatus | undefined> {
  try {
    const result = await rpc.call('/dsh-pause', 'status', { sessionId })
    if (result.ok) return result.value as PauseStatus | undefined
    return undefined
  } catch {
    // 本次轮询失败不更新状态，下一次轮询会重试。
    return undefined
  }
}

/** 一次放行的结果；error 存在表示主机拒绝，暂停点未放行。 */
interface ReleaseOutcome {
  readonly released: boolean
  /** 主机已把插话送进 dsh，草稿可以清空。 */
  readonly delivered: boolean
  readonly error?: string
}

async function callRelease(
  rpc: PauseBarInjected['rpc'],
  sessionId: string,
  text: string,
  images: readonly SubmitAttachment[],
): Promise<ReleaseOutcome> {
  try {
    const result = await rpc.call('/dsh-pause', 'release', { sessionId, text, images })
    if (!result.ok) return { released: false, delivered: false, error: result.error?.message ?? '放行失败' }
    const value = result.value as { released?: boolean; delivered?: boolean } | undefined
    return { released: value?.released === true, delivered: value?.delivered === true }
  } catch (error) {
    return { released: false, delivered: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function callSetEnabled(rpc: PauseBarInjected['rpc'], sessionId: string, enabled: boolean): Promise<void> {
  try {
    await rpc.call('/dsh-pause', 'setEnabled', { sessionId, enabled })
  } catch {
    // 忽略：失败时本地开关不落定，下次轮询会回正
  }
}

/**
 * 把一次回车交给主机裁决：有暂停点就放行，没有暂停点则由主机立即 steer。
 * 按下回车时文字与图片已经离开输入框，所以任何失败都不回填，改为暂存到下次发送时优先带出。
 */
async function releaseInterjection(
  rpc: PauseBarInjected['rpc'],
  sessionId: string,
  draft: string,
  carried: readonly SubmitAttachment[],
  attachmentsPromise: Promise<readonly SubmitAttachment[]> | undefined,
  onUnsent: (text: string, images: readonly SubmitAttachment[]) => void,
  onDone: () => void,
  onError: (message: string) => void,
): Promise<void> {
  let attachments: readonly SubmitAttachment[] = carried
  if (attachmentsPromise !== undefined) {
    try {
      attachments = [...carried, ...await attachmentsPromise]
    } catch (error) {
      onUnsent(draft, carried)
      onError('附件无法随插话发送，文字已保留：' + (error instanceof Error ? error.message : String(error)))
      return
    }
  }
  if (attachments.some((part) => part.type !== 'image')) {
    onUnsent(draft, carried)
    onError('文件附件无法随插话发送，已从输入框移除，文字已保留')
    return
  }
  const hasPayload = draft.trim() !== '' || attachments.length > 0
  const outcome = await callRelease(rpc, sessionId, draft, attachments)
  if (outcome.error !== undefined) {
    onUnsent(draft, attachments)
    onError(outcome.error + '，已保留，下次发送时一并送出')
    return
  }
  if (outcome.released || outcome.delivered) {
    onDone()
    return
  }
  // 空草稿的回车本来就没有动作，重放只会触发一次空提交。
  if (!hasPayload) {
    onDone()
    return
  }
  // 主机没接住这条插话：不重放、不回填，暂存到下次发送时优先带出。
  onUnsent(draft, attachments)
  onError('这条插话暂时没能送达主机，已保留，下次发送时一并送出')
}

/**
 * 暂停图标：两条竖线，单色 currentColor 跟随主题。
 */
function PauseIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} fill="currentColor" aria-hidden="true" style={{ flex: 'none' }}>
      <rect x={3.6} y={2.4} width={3.4} height={11.2} rx={1.2} />
      <rect x={9} y={2.4} width={3.4} height={11.2} rx={1.2} />
    </svg>
  )
}

/**
 * 暂停控件。开关开启期间挂 document capture 拦截裸 Enter，落点在本 composer 卡内时交给主机裁决。
 */
export const PauseControl = memo(function PauseControl({
  rpc,
  sessionId,
  useInput,
  inputActions,
  serializeAttachments,
  releaseAttachment,
}: PauseControlProps) {
  const [enabled, setEnabled] = useState(false)
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // composer 卡标记缺失时只报一次，避免每次按键都刷控制台。
  const missingCardWarnedRef = useRef(false)

  // render 内 subscribe：草稿与附件变化会触发本组件重渲染并更新 ref。
  // 注意：不能在 capture 事件处理器里调 useInput，因为 hook 只在 render 期合法，故存 ref。
  const draft = useInput((state: InputState) => state.draft)
  const attachmentIds = useInput((state: InputState) => state.attachmentIds)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const idsRef = useRef(attachmentIds)
  idsRef.current = attachmentIds
  // 提交阶段会拒绝移除附件，capture 处理器要读最新阶段，同样存 ref。
  const phase = useInput((state: InputState) => state.phase)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  // capture 处理器要读最新的放行入口，用 ref 规避闭包过期。
  const pausePointRef = useRef<{ release: () => void }>({ release: () => {} })
  // 放行中的重复 Enter 记到 deferred，不并发上传，但这次回车不能丢。
  const releasingRef = useRef(false)
  const deferredRef = useRef(false)
  // 已经交给在飞请求的附件，后续回车跳过同一批。
  const claimedRef = useRef<Set<DraftAttachmentId>>(new Set())
  // 没能送达主机的插话按原样暂存，下次按回车时优先带出；绝不回填输入框。
  const unsentRef = useRef<Array<{ text: string; images: readonly SubmitAttachment[] }>>([])
  pausePointRef.current = {
    release: () => {
      if (releasingRef.current) {
        deferredRef.current = true
        return
      }
      // 提交中的 composer 会拒绝移除附件，继续会把同一批图片留在草稿里重复发送。
      if (phaseRef.current === 'adjudicating' || phaseRef.current === 'submitting') {
        setError('正在提交上一条消息，稍后再按回车')
        return
      }
      setError(undefined)
      const carried = unsentRef.current
      unsentRef.current = []
      const carriedText = carried.map((item) => item.text.trim()).filter((text) => text !== '').join('\n')
      const current = draftRef.current
      const sent = carriedText === '' ? current : current === '' ? carriedText : carriedText + '\n' + current
      const carriedImages = carried.flatMap((item) => item.images)
      const ids = idsRef.current.filter((id: DraftAttachmentId) => !claimedRef.current.has(id))
      // 检查先于置位：此时请求还没发出，失败时不能留下在飞标记。
      if (ids.length > 0 && serializeAttachments === undefined) {
        unsentRef.current = carried
        setError('当前环境不支持附件插话，文字仍保留，图片请先移除')
        return
      }
      releasingRef.current = true
      for (const id of ids) claimedRef.current.add(id)
      // 序列化在调用时就同步捕获了附件对象，所以可以立刻把图片也一起带走。
      const serialization = ids.length === 0 || serializeAttachments === undefined
        ? undefined
        : serializeAttachments(ids)
      // 按了就带走：文字与图片一起立刻离开输入框，之后再输入的字属于下一条消息。
      draftRef.current = ''
      inputActions?.setDraft('')
      for (const id of ids) inputActions?.removeAttachment(id)
      const pendingRelease = releaseInterjection(
        rpc,
        sessionId,
        sent,
        carriedImages,
        serialization,
        (text, images) => { unsentRef.current.push({ text, images }) },
        () => setPaused(false),
        (message) => {
          deferredRef.current = false
          setError(message)
        },
      )
      void pendingRelease.finally(() => {
        releasingRef.current = false
        for (const id of ids) {
          claimedRef.current.delete(id)
          // 序列化已经结束，底层附件不会再被读取，这时释放才不会泄漏。
          releaseAttachment?.(id)
        }
        // 请求期间被挡下的回车补一次，用那时的草稿重走裁决。
        if (deferredRef.current) {
          deferredRef.current = false
          pausePointRef.current.release()
        }
      })
    },
  }

  // 轮询主机端状态。
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setInterval> | undefined
    const poll = async (): Promise<void> => {
      const s = await fetchStatus(rpc, sessionId)
      if (disposed || s === undefined) return
      setEnabled(s.enabled ?? false)
      setPaused(s.paused ?? false)
    }
    void poll()
    timer = setInterval(() => void poll(), 400)
    return () => {
      disposed = true
      if (timer !== undefined) clearInterval(timer)
    }
  }, [rpc, sessionId])

  // 开关开启期间常驻 capture：暂停点挂上与否由主机裁决，客户端状态滞后不影响拦截。
  useEffect(() => {
    if (!enabled) return
    const onCapture = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey) return
      if (event.isComposing || event.keyCode === 229) return
      const root = rootRef.current
      if (root === null || !root.isConnected) return
      const card = root.closest('[data-composer-card]')
      if (card === null) {
        if (!missingCardWarnedRef.current) {
          missingCardWarnedRef.current = true
          console.warn('[dsh-pause] 找不到 [data-composer-card]，回车拦截未生效；请检查 DSH 版本是否改了 composer 结构')
        }
        return
      }
      missingCardWarnedRef.current = false
      if (!card.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
      void pausePointRef.current.release()
    }
    document.addEventListener('keydown', onCapture, true)
    return () => document.removeEventListener('keydown', onCapture, true)
  }, [enabled, sessionId])

  const toggle = async (next: boolean): Promise<void> => {
    setError(undefined)
    setEnabled(next)
    await callSetEnabled(rpc, sessionId, next)
  }

  return (
    <div
      ref={rootRef}
      data-dsh-pause="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '0 4px',
        fontSize: '12px',
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary)',
      }}
    >
      <button
        type="button"
        aria-pressed={enabled}
        title={enabled ? '暂停已开启' : '开启暂停，工具续跑前会停下'}
        onClick={() => { void toggle(!enabled) }}
        style={{
          cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '6px',
          background: enabled ? 'var(--dsw-alias-state-business-primary)' : 'transparent',
          color: enabled ? 'var(--dsw-alias-label-primary-inverted)' : 'var(--dsw-alias-label-secondary)',
          padding: '1px 8px',
          fontSize: '12px',
          lineHeight: '18px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        <PauseIcon />
        {enabled ? '暂停开' : '暂停'}
      </button>
      {paused && (
        <button
          type="button"
          onClick={() => { void pausePointRef.current.release() }}
          style={{
            cursor: 'pointer',
            border: '1px solid var(--dsw-alias-state-business-primary)',
            borderRadius: '6px',
            background: 'var(--dsw-alias-state-business-primary)',
            color: 'var(--dsw-alias-label-primary-inverted)',
            padding: '1px 8px',
            fontSize: '12px',
            lineHeight: '18px',
          }}
        >
          已暂停·回车或点此继续
        </button>
      )}
      {error !== undefined && (
        <span style={{ color: 'var(--dsw-alias-label-error, #d9534f)', fontSize: '12px' }}>
          {error}
        </span>
      )}
    </div>
  )
})

export type PauseBarProps = PauseControlProps

