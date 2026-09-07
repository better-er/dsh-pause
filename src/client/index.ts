/**
 * dsh-pause 浏览器半身：暂停控件挂在 composer 工具行右侧 conversation.input.right。
 *
 * 目标：暂停时在 composer 主输入框里按 Enter 即继续。草稿为空则无感放行，草稿有字则作为插话一并放行并清空草稿。
 * 因为 dsh 的 composer Enter 由 InputBar 私有 keymap 处理，第三方没有正式 hook 点，所以本插件用 DOM capture 在暂停态拦截裸 Enter，阻止默认送信并改走 release。
 * 控件本身在 composer 卡内渲染，因此暂停条可见且可点。capture 监听只在暂停态激活，未暂停时不拦截任何按键。
 *
 * @module dsh-pause/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PauseControl } from './PauseBar.tsx'

/** 插件名即配置项 id。 */
export const name = 'dsh-pause'
/** 本插件需要的客户端服务。 */
export const inject = ['slots', 'connection']

/** 注册时注入读条组件、按钮所需的业务面。 */
export interface PauseBarInjected {
  /** Connection RPC 调用器，主机端提供 /dsh-pause。 */
  readonly rpc: ClientConnectionRpc
}

/**
 * 把暂停控件注册进 composer 工具行右侧。
 * @param ctx 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const connection = (ctx as unknown as { connection: ConnectionHandle }).connection
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'dsh-pause',
        order: 30,
        inject: (): PauseBarInjected => ({ rpc: connection.rpc }),
      },
      PauseControl,
    ),
  )
}

export { PauseControl } from './PauseBar.tsx'
export type { PauseControlProps } from './PauseBar.tsx'

