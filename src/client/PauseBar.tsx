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
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** 注册时注入读条组件、按钮所需的业务面。 */
export interface PauseBarInjected {
  /** Connection RPC 调用器，主机端提供 /dsh-pause。 */
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown }>
  }
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

async function callRelease(rpc: PauseBarInjected['rpc'], sessionId: string, text: string): Promise<boolean> {
  try {
    const result = await rpc.call('/dsh-pause', 'release', { sessionId, text })
    const value = result.ok ? (result.value as { released?: boolean } | undefined) : undefined
    return value?.released === true
  } catch {
    return false
  }
}

async function callSetEnabled(rpc: PauseBarInjected['rpc'], sessionId: string, enabled: boolean): Promise<void> {
  try {
    await rpc.call('/dsh-pause', 'setEnabled', { sessionId, enabled })
  } catch {
    // 忽略：失败时本地开关不落定，下次轮询会回正
  }
}

/** 放行一扇门：draft 为空 = 无感继续；有字 = 插话并清空草稿。 */
async function releaseAndClear(
  rpc: PauseBarInjected['rpc'],
  sessionId: string,
  draft: string,
  inputActions: InputActions | undefined,
  onDone: () => void,
): Promise<void> {
  const released = await callRelease(rpc, sessionId, draft)
  if (released) {
    if (draft !== '' && inputActions !== undefined) inputActions.setDraft('')
    onDone()
  }
}

/**
 * 暂停控件。暂停态挂 document capture 拦截裸 Enter，落点在本 composer 卡内时改为放行。
 */
export const PauseControl = memo(function PauseControl({
  rpc,
  sessionId,
  useInput,
  inputActions,
}: PauseControlProps) {
  const [enabled, setEnabled] = useState(false)
  const [paused, setPaused] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // render 内 subscribe：草稿变化会触发本组件重渲染并更新 ref。
  // 注意：不能在 capture 事件处理器里调 useInput，因为 hook 只在 render 期合法，故存 ref。
  const draft = useInput((state: InputState) => state.draft)
  const draftRef = useRef(draft)
  draftRef.current = draft
  // capture 处理器要读最新 paused/rpc/sessionId/inputActions，也用 ref 规避闭包过期。
  const gateRef = useRef({ paused, release: () => releaseAndClear(rpc, sessionId, draftRef.current, inputActions, () => setPaused(false)) })
  gateRef.current = { paused, release: () => releaseAndClear(rpc, sessionId, draftRef.current, inputActions, () => setPaused(false)) }

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
        }}
      >
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
    </div>
  )
})

export type PauseBarProps = PauseControlProps

