/**
 * dsh-pause 暂停控件：挂在 composer 工具行右侧 conversation.input.right。
 *
 * 目标交互：
 * - 开关按钮，本会话总开关。
 * - 暂停时在 host 报 paused 的状态下于 composer 主输入框按裸 Enter 即继续。草稿为空则无感放行，草稿有字则作为插话放行并清空草稿。
 * - 未暂停时不拦截任何按键，完全透明。
 *
 * dsh 的 composer Enter 由 InputBar 私有 keymap 处理，第三方没有正式 hook 点，故本组件在暂停态对所属 composer 挂 document 级 capture-phase keydown，抢在 Lexical 之前拦截裸 Enter。
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
    return undefined
  }
}

/** 一次放行的结果；error 存在表示主机拒绝，门未放行。 */
interface ReleaseOutcome {
  readonly released: boolean
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
    if (!result.ok) return { released: false, error: result.error?.message ?? '放行失败' }
    const value = result.value as { released?: boolean } | undefined
    return { released: value?.released === true }
  } catch (error) {
    return { released: false, error: error instanceof Error ? error.message : String(error) }
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
 * 放行一扇门：draft 与图片一起作为插话，空则无感继续。
 * 附件必须先序列化并随放行请求上传；主机拒绝时保持门与草稿原样，避免出现只发文字、图片残留的状态。
 */
async function releaseAndClear(
  rpc: PauseBarInjected['rpc'],
  sessionId: string,
  draft: string,
  attachmentIds: readonly DraftAttachmentId[],
  serializeAttachments: PauseBarInjected['serializeAttachments'],
  inputActions: InputActions | undefined,
  onDone: () => void,
  onError: (message: string) => void,
): Promise<void> {
  let attachments: readonly SubmitAttachment[] = []
  if (attachmentIds.length > 0) {
    if (serializeAttachments === undefined) {
      onError('当前环境不支持附件插话，请先发送或移除附件')
      return
    }
    try {
      attachments = await serializeAttachments(attachmentIds)
    } catch (error) {
      onError('附件无法随插话发送：' + (error instanceof Error ? error.message : String(error)))
      return
    }
  }
  if (attachments.some((part) => part.type !== 'image')) {
    onError('暂停中只支持图片插话，请先移除文件附件')
    return
  }
  const outcome = await callRelease(rpc, sessionId, draft, attachments)
  if (outcome.error !== undefined) {
    onError(outcome.error)
    return
  }
  if (!outcome.released) {
    onDone()
    return
  }
  if (draft !== '' && inputActions !== undefined) inputActions.setDraft('')
  if (inputActions !== undefined) {
    for (const id of attachmentIds) inputActions.removeAttachment(id)
  }
  onDone()
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
 * 暂停控件。暂停态挂 document capture 拦截裸 Enter，落点在本 composer 卡内时改为放行。
 */
export const PauseControl = memo(function PauseControl({
  rpc,
  sessionId,
  useInput,
  inputActions,
  serializeAttachments,
}: PauseControlProps) {
  const [enabled, setEnabled] = useState(false)
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // render 内 subscribe：草稿与附件变化会触发本组件重渲染并更新 ref。
  // 注意：不能在 capture 事件处理器里调 useInput，因为 hook 只在 render 期合法，故存 ref。
  const draft = useInput((state: InputState) => state.draft)
  const attachmentIds = useInput((state: InputState) => state.attachmentIds)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const idsRef = useRef(attachmentIds)
  idsRef.current = attachmentIds
  // capture 处理器要读最新 paused/rpc/sessionId/inputActions，也用 ref 规避闭包过期。
  const gateRef = useRef<{ paused: boolean; release: () => void }>({ paused: false, release: () => {} })
  // 放行中的重复 Enter 或连点不再发起第二次上传，避免同一批图片被提交两次。
  const releasingRef = useRef(false)
  gateRef.current = {
    paused,
    release: () => {
      if (releasingRef.current) return
      releasingRef.current = true
      setError(undefined)
      const pending = releaseAndClear(
        rpc,
        sessionId,
        draftRef.current,
        idsRef.current,
        serializeAttachments,
        inputActions,
        () => setPaused(false),
        (message) => setError(message),
      )
      void pending.finally(() => { releasingRef.current = false })
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

  // 暂停态激活 capture：document 捕获阶段抢在 Lexical 前拦裸 Enter。
  useEffect(() => {
    if (!paused) return
    const onCapture = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey) return
      if (event.isComposing || event.keyCode === 229) return
      const root = rootRef.current
      if (root === null || !root.isConnected) return
      const card = root.closest('[data-composer-card]')
      if (card === null || !card.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
      void gateRef.current.release()
    }
    document.addEventListener('keydown', onCapture, true)
    return () => document.removeEventListener('keydown', onCapture, true)
  }, [paused])

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
          onClick={() => { void gateRef.current.release() }}
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

