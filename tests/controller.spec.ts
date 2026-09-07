/**
 * dsh-pause 控制器纯逻辑单测。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENABLED,
  PauseRegistry,
  initialSessionState,
  shouldPause,
  textToMessages,
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

describe('textToMessages', () => {
  it('空/空白文字不产生消息', () => {
    expect(textToMessages('')).toHaveLength(0)
    expect(textToMessages('   ')).toHaveLength(0)
  })
  it('非空文字产生一条 user 文本消息', () => {
    const msgs = textToMessages('先别动手，我再想想')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.content).toMatchObject([{ type: 'text', text: '先别动手，我再想想' }])
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
  it('arm/release 门控：release 携带文字并复位', async () => {
    const reg = new PauseRegistry(false)
    reg.setEnabled('s', true)
    const gate = new Promise<string>((resolve) => {
      reg.armGate('s', { resolve, reject: () => {} })
    })
    expect(reg.isPaused('s')).toBe(true)
    const released = reg.release('s', '补一句')
    expect(released).toBe(true)
    await expect(gate).resolves.toBe('补一句')
    expect(reg.isPaused('s')).toBe(false)
  })
  it('无门时 release 返回 false', () => {
    const reg = new PauseRegistry(false)
    expect(reg.release('s', '')).toBe(false)
  })
  it('abort 中止门并复位', async () => {
    const reg = new PauseRegistry(false)
    const gate = new Promise<string>((_, reject) => {
      reg.armGate('s', { resolve: () => {}, reject })
    })
    reg.abortGate('s', new Error('cancelled'))
    await expect(gate).rejects.toThrow('cancelled')
    expect(reg.isPaused('s')).toBe(false)
  })
  it('stateFor 幂等返回同一会话状态对象', () => {
    const reg = new PauseRegistry(false)
    expect(reg.stateFor('x')).toBe(reg.stateFor('x'))
  })
  it('initialSessionState 默认关且未暂停', () => {
    expect(initialSessionState()).toEqual({ enabled: false, paused: false, waiting: undefined })
  })
})
