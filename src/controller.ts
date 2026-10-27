/**
 * dsh-pause 主机半身：暂停控制器与判定。
 *
 * 核心语义：在 agent 每轮 step 进入前的 agent/pre-step 事件里判断这次请求是否为工具交互后的续跑。
 * 若是续跑且开关开启，则挂起一个暂停点，等人类经 release 原语放行后才把这一次请求发出去。
 * 放行时可带补充文字，作为一条 user 消息并入本 step 的 messages，让模型在紧接着的请求里看到它。
 *
 * 暂停点只卡在请求真正发出之前，因此不打断任何在途 API 调用。
 * 人类在暂停点挂上之前按回车时，插话先排队，下一个暂停点不再等回车而是直接带头并入本步，即预放行；
 * turn 若在暂停点出现之前结束，队列由主机作为新的 followup 发出去；followup 抛错时放回队列等下一次重试，任何失败都不静默丢弃。
 * driver 组装好的上下文原样放行，不插入、不删除、不改写任何模型可见的痕迹，模型无感知暂停。
 *
 * @module dsh-pause
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** 一个会话的暂停开关与暂停点状态。会话以 agent 的 session id 为键。 */
export interface PauseSessionState {
  /** 用户开关：该会话是否启用暂停。false 时所有请求直接放行。 */
  enabled: boolean
  /** 该会话的 agent 是否在跑。idle 时暂停点不会再来，队列要当场发出去。 */
  busy: boolean
  /** 当前挂着的暂停点，放行时若带文字则一并返回。 */
  pausePoint: PausePoint | undefined
  /** 暂停点还没挂上时人类已按回车发出的插话，等下一个暂停点并入或 turn 结束时 followup。 */
  pendingMessages: UserMessage[]
}

/** 一个暂停点：人类选择继续时用它放行，可携带一条已构造好的补充用户消息。 */
export interface PausePoint {
  /** 解析放行等待的入口，参数为待并入本步的补充消息，undefined 表示无感继续。 */
  resolve: (message: UserMessage | undefined) => void
  reject: (reason: unknown) => void
}

/**
 * 判定一次 pre-step 是否应当触发暂停。
 *
 * 纯函数，便于单测。
 * dsh 的 driver 把一个模型请求当作一个 step。用户首条消息进入的 step 记为 turn 内的第 1 步。
 * 模型在某个 step 里请求工具后，工具结果写回，driver 会为带工具结果的下一模型请求再开一个新 step，路径为 tools → pre-step → step。
 * 因此一次工具交互后的续跑请求可用同一 turn 内 step 大于 1 来近似。此启发式无法区分工具续跑与人类中途插话造成的新 step，会把二者都视为续跑。
 * 对暂停语用而言，二者都是模型进一步作答前的一个暂停点，行为可接受。每个 turn 的第一次请求 step 等于 1，永不触发暂停。
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
 * 带图插话由安装器先经附件服务持久化，再调用本函数无法表达，故只处理纯文字。
 * @param text 人类输入的补充文字。
 * @returns 待并入的 user 消息；空白文字返回 undefined。
 */
export function textToMessage(text: string): UserMessage | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return createUserMessage({
    content: [{ type: 'text', text: trimmed }],
    source: { kind: 'user' },
  })
}

/** 会话状态在安装器里的默认初始值。 */
export function initialSessionState(): PauseSessionState {
  return { enabled: false, busy: false, pausePoint: undefined, pendingMessages: [] }
}

/** 默认每会话开关。 */
export const DEFAULT_ENABLED = false

/**
 * 会话状态表，以 session id 为键存放每个会话的开关与暂停点。
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

  /** 是否已暂停，即当前挂着一个在等放行的暂停点。 */
  isPaused(sessionId: string): boolean {
    return this.stateFor(sessionId).pausePoint !== undefined
  }

  /** 该会话的 agent 是否在跑。 */
  isBusy(sessionId: string): boolean {
    return this.stateFor(sessionId).busy
  }

  /** 待插话队列长度。 */
  pendingMessageCount(sessionId: string): number {
    return this.stateFor(sessionId).pendingMessages.length
  }

  /** 更新 agent 的运行状态。转为 idle 时暂停点不会再挂上，由安装器负责把队列当场发出去。 */
  setBusy(sessionId: string, busy: boolean): void {
    const s = this.stateFor(sessionId)
    if (s.busy === busy) return
    this.states.set(sessionId, { ...s, busy })
  }

  /** 把一条还没送达的插话排进队列，等下一个暂停点并入，或等 turn 结束时 followup。 */
  queueMessage(sessionId: string, message: UserMessage): void {
    const s = this.stateFor(sessionId)
    this.states.set(sessionId, { ...s, pendingMessages: [...s.pendingMessages, message] })
  }

  /** 取走全部待插话。 */
  takePendingMessages(sessionId: string): UserMessage[] {
    const s = this.stateFor(sessionId)
    if (s.pendingMessages.length === 0) return []
    this.states.set(sessionId, { ...s, pendingMessages: [] })
    return s.pendingMessages
  }

  /** 把没能并入的待插话放回队首，用于该步被 reject 或补发失败的情形。 */
  requeueMessages(sessionId: string, messages: readonly UserMessage[]): void {
    if (messages.length === 0) return
    const s = this.stateFor(sessionId)
    this.states.set(sessionId, { ...s, pendingMessages: [...messages, ...s.pendingMessages] })
  }

  /**
   * 放行暂停点。若该会话当前正挂着暂停点，用给定补充消息放行并返回 true；否则返回 false。
   * 放行后状态复位为未暂停，因为这一步已经放行。
   */
  release(sessionId: string, message: UserMessage | undefined): boolean {
    const s = this.stateFor(sessionId)
    if (s.pausePoint === undefined) return false
    const resolve = s.pausePoint.resolve
    this.states.set(sessionId, { ...s, pausePoint: undefined })
    resolve(message)
    return true
  }

  /** 挂起一个暂停点，并把放行入口写入状态。 */
  armPausePoint(sessionId: string, resolvers: Pick<PausePoint, 'resolve' | 'reject'>): void {
    const s = this.stateFor(sessionId)
    // pre-step 一定发生在 running 内，插件热加载可能错过 idle→running 推送，这里顺手补上。
    this.states.set(sessionId, {
      ...s,
      busy: true,
      pausePoint: { resolve: resolvers.resolve, reject: resolvers.reject },
    })
  }

  /** 中止等待中的暂停点，例如 turn 被取消时。返回是否确有被中止的暂停点。 */
  abortPausePoint(sessionId: string, reason: unknown): boolean {
    const s = this.stateFor(sessionId)
    if (s.pausePoint === undefined) return false
    const reject = s.pausePoint.reject
    this.states.set(sessionId, { ...s, pausePoint: undefined })
    reject(reason)
    return true
  }
}
