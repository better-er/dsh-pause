/**
 * dsh-pause 控制器纯逻辑单测。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENABLED,
  PauseRegistry,
  initialSessionState,
  shouldPause,
  textToMessage,
} from '../src/controller.ts'

describe('shouldPause', () => {
  it('第一请求即 step 1 永不暂停', () => {
    expect(shouldPause(true, 1)).toBe(false)
  })
  it('开关关时不暂停', () => {
    expect(shouldPause(false, 2)).toBe(false)
  })
  it('开启且是续跑即 step>1 才暂停', () => {
    expect(shouldPause(true, 2)).toBe(true)
    expect(shouldPause(true, 3)).toBe(true)
  })
})

describe('textToMessage', () => {
  it('空/空白文字不产生消息', () => {
    expect(textToMessage('')).toBeUndefined()
    expect(textToMessage('   ')).toBeUndefined()
  })
  it('非空文字产生一条 user 文本消息', () => {
    const msg = textToMessage('先别动手，我再想想')
    expect(msg?.content).toMatchObject([{ type: 'text', text: '先别动手，我再想想' }])
  })
})

describe('PauseRegistry', () => {
  it('默认关', () => {
    const reg = new PauseRegistry()
    expect(reg.enabled('s')).toBe(false)
    expect(reg.isPaused('s')).toBe(false)
  })
  it('开关可切换', () => {
    const reg = new PauseRegistry(DEFAULT_ENABLED)
    reg.setEnabled('s', true)
    expect(reg.enabled('s')).toBe(true)
  })
  it('arm/release 暂停点：release 携带补充消息并复位', async () => {
    const reg = new PauseRegistry(false)
    reg.setEnabled('s', true)
    const message = textToMessage('补一句')
    const pausePoint = new Promise<unknown>((resolve) => {
      reg.armPausePoint('s', { resolve, reject: () => {} })
    })
    expect(reg.isPaused('s')).toBe(true)
    const released = reg.release('s', message)
    expect(released).toBe(true)
    await expect(pausePoint).resolves.toBe(message)
    expect(reg.isPaused('s')).toBe(false)
  })
  it('没有暂停点时 release 返回 false', () => {
    const reg = new PauseRegistry(false)
    expect(reg.release('s', undefined)).toBe(false)
  })
  it('abort 中止暂停点并复位', async () => {
    const reg = new PauseRegistry(false)
    const pausePoint = new Promise<unknown>((_, reject) => {
      reg.armPausePoint('s', { resolve: () => {}, reject })
    })
    reg.abortPausePoint('s', new Error('cancelled'))
    await expect(pausePoint).rejects.toThrow('cancelled')
    expect(reg.isPaused('s')).toBe(false)
  })
  it('没有暂停点时 release 返回 false 且不动队列', () => {
    const reg = new PauseRegistry(false)
    expect(reg.release('s', undefined)).toBe(false)
    expect(reg.pendingMessageCount('s')).toBe(0)
  })
  it('待插话队列先进先出，take 一次取走全部', () => {
    const reg = new PauseRegistry(false)
    const first = textToMessage('第一条')!
    const second = textToMessage('第二条')!
    reg.queueMessage('s', first)
    reg.queueMessage('s', second)
    expect(reg.pendingMessageCount('s')).toBe(2)
    expect(reg.takePendingMessages('s')).toEqual([first, second])
    expect(reg.pendingMessageCount('s')).toBe(0)
    expect(reg.takePendingMessages('s')).toEqual([])
  })
  it('该步被 reject 时把待插话放回队首', () => {
    const reg = new PauseRegistry(false)
    const first = textToMessage('第一条')!
    reg.queueMessage('s', first)
    const taken = reg.takePendingMessages('s')
    reg.requeueMessages('s', taken)
    expect(reg.pendingMessageCount('s')).toBe(1)
    expect(reg.takePendingMessages('s')[0]).toBe(first)
  })
  it('busy 只记录 agent 是否在跑，不动队列', () => {
    const reg = new PauseRegistry(false)
    reg.setBusy('s', true)
    reg.queueMessage('s', textToMessage('还在跑')!)
    reg.setBusy('s', false)
    expect(reg.isBusy('s')).toBe(false)
    expect(reg.pendingMessageCount('s')).toBe(1)
  })
  it('isPaused 直接由暂停点是否存在推出', () => {
    const reg = new PauseRegistry(false)
    expect(reg.isPaused('s')).toBe(false)
    reg.armPausePoint('s', { resolve: () => {}, reject: () => {} })
    expect(reg.isPaused('s')).toBe(true)
    reg.release('s', undefined)
    expect(reg.isPaused('s')).toBe(false)
  })
  it('stateFor 幂等返回同一会话状态对象', () => {
    const reg = new PauseRegistry(false)
    expect(reg.stateFor('x')).toBe(reg.stateFor('x'))
  })
  it('initialSessionState 默认关且未暂停', () => {
    expect(initialSessionState()).toEqual({
      enabled: false,
      busy: false,
      pausePoint: undefined,
      pendingMessages: [],
    })
  })
})
