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
    expect(initialSessionState()).toEqual({ enabled: false, pausePoint: undefined })
  })
})
