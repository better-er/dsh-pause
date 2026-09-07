/**
 * dsh-pause 主机半身：暂停控制器与判定。
 *
 * 核心语义：在 agent 每轮 step 进入前的 agent/pre-step 事件里判断这次请求是否为工具交互后的续跑。
 * 若是续跑且开关开启，则把门拉住，等人类经 release 原语放行后才把这一次请求发出去。
 * 放行时可带补充文字，作为一条 user 消息并入本 step 的 messages，让模型在紧接着的请求里看到它。
 *
 * 门只卡在请求真正发出之前，因此不打断任何在途 API 调用。
 * driver 组装好的上下文原样放行，不插入、不删除、不改写任何模型可见的痕迹，模型无感知暂停。
 *
 * @module dsh-pause
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** 一个会话的暂停开关与门控状态。会话以 agent 的 session id 为键。 */
export interface PauseSessionState {
  /** 用户开关：该会话是否启用暂停。false 时所有请求直接放行。 */
  enabled: boolean
  /** 当前是否有一扇门被拉住。 */
  paused: boolean
  /** 正在等待放行的解析器，放行时若带文字则一并返回。 */
  waiting: ReleaseRequest | undefined
}

/** 一次放行请求：人类选择继续，可携带一段补充文字。 */
export interface ReleaseRequest {
  /** 放行时携带的补充文字，可为空串表示无感继续。 */
  text: string
  /** 解析放行等待的入口，由安装器在注册 pre-step 时提供。 */
  resolve: (text: string) => void
  reject: (reason: unknown) => void
}

/**
 * 判定一次 pre-step 是否应当触发暂停。
 *
 * 纯函数，便于单测。
 * dsh 的 driver 把一个模型请求当作一个 step。用户首条消息进入的 step 记为 turn 内的第 1 步。
 * 模型在某个 step 里请求工具后，工具结果写回，driver 会为带工具结果的下一模型请求再开一个新 step，路径为 tools → pre-step → step。
 * 因此一次工具交互后的续跑请求可用同一 turn 内 step 大于 1 来近似。此启发式无法区分工具续跑与人类中途插话造成的新 step，会把二者都视为续跑。
 * 对暂停语用而言，二者都是模型进一步作答前的一道门，行为可接受。首条纯文字请求 step 等于 1，永不触发暂停。
 *
 * @param enabled 该会话开关是否开启。
 * @param step 本次 pre-step 的 step 序号，为 turn 内序号。
 * @returns 本次 pre-step 是否应暂停。
 */
export function shouldPause(enabled: boolean, step: number): boolean {
  return enabled && step > 1
}

/**
 * 把一段补充文字转成要并进 step 的 user 消息。空文字不产生消息。
 * @param text 人类输入的补充文字。
 * @returns 待并入的 user 消息数组；空文字返回空数组。
 */
export function textToMessages(text: string): UserMessage[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  return [createUserMessage({
    content: [{ type: 'text', text: trimmed }],
    source: { kind: 'user' },
  })]
}

/** 会话状态在安装器里的默认初始值。 */
export function initialSessionState(): PauseSessionState {
  return { enabled: false, paused: false, waiting: undefined }
}

/** 默认每会话开关。 */
export const DEFAULT_ENABLED = false

/**
 * 会话状态表，以 session id 为键存放每个会话的开关与门。
 * 同一会话的 pre-step 与 release 串行访问，单线程无需加锁。
 */
export class PauseRegistry {
  private readonly states = new Map<string, PauseSessionState>()

  constructor(private readonly defaultEnabled = DEFAULT_ENABLED) {}

  stateFor(sessionId: string): PauseSessionState {
    let s = this.states.get(sessionId)
    if (s === undefined) {
      s = { ...initialSessionState(), enabled: this.defaultEnabled }
      this.states.set(sessionId, s)
    }
    return s
  }

  setEnabled(sessionId: string, enabled: boolean): void {
    this.states.set(sessionId, { ...this.stateFor(sessionId), enabled })
  }

  /** 会话开关当前值。 */
  enabled(sessionId: string): boolean {
    return this.stateFor(sessionId).enabled
  }

  /** 是否已暂停，即当前挂着一扇在等放行的门。 */
  isPaused(sessionId: string): boolean {
    return this.stateFor(sessionId).paused
  }

  /**
   * 放行一扇门。若该会话当前正挂着门，用给定文字放行并返回 true；否则返回 false。
   * 放行后状态复位为未暂停，因为这一步已经放行。
   */
  release(sessionId: string, text: string): boolean {
    const s = this.stateFor(sessionId)
    if (s.waiting === undefined) return false
    const resolve = s.waiting.resolve
    this.states.set(sessionId, { enabled: s.enabled, paused: false, waiting: undefined })
    resolve(text)
    return true
  }

  /** 使一扇门进入等待态，并把拉门信号写入状态。 */
  armGate(sessionId: string, resolvers: Pick<ReleaseRequest, 'resolve' | 'reject'>): void {
    const s = this.stateFor(sessionId)
    this.states.set(sessionId, {
      enabled: s.enabled,
      paused: true,
      waiting: { text: '', resolve: resolvers.resolve, reject: resolvers.reject },
    })
  }

  /** 中止等待中的门，例如 turn 被取消时。返回是否确有被中止的门。 */
  abortGate(sessionId: string, reason: unknown): boolean {
    const s = this.stateFor(sessionId)
    if (s.waiting === undefined) return false
    const reject = s.waiting.reject
    this.states.set(sessionId, { enabled: s.enabled, paused: false, waiting: undefined })
    reject(reason)
    return true
  }
}
