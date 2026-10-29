/**
 * dsh-pause 浏览器半身：暂停控件挂在 composer 工具行右侧 conversation.input.right。
 *
 * 目标：开关开启期间在 composer 主输入框里按 Enter 即继续。有暂停点则放行并带上草稿，没有暂停点则立即 steer；主机发不出去时交回客户端暂存，失败内容不退回输入框。
 * 因为 dsh 的 composer Enter 由 InputBar 私有 keymap 处理，第三方没有正式 hook 点，所以本插件用 DOM capture 在开关开启期间常驻拦截裸 Enter，阻止默认送信并改走主机裁决。
 * 控件本身在 composer 卡内渲染，因此暂停条可见且可点。capture 监听只在开关开启期间激活，关闭时不拦截任何按键。
 *
 * @module dsh-pause/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ConversationController, DraftAttachmentId, SubmitAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PauseControl } from './PauseBar.tsx'

/** 插件名即配置项 id。 */
export const name = 'dsh-pause'
/** 本插件需要的客户端服务。conversation 用于把草稿附件序列化成可随插话提交的载荷。 */
export const inject = ['slots', 'connection', 'conversation']

/** 注册时注入读条组件、按钮所需的业务面。 */
export interface PauseBarInjected {
  /** Connection RPC 调用器，主机端提供 /dsh-pause。 */
  readonly rpc: ClientConnectionRpc
  /** 把草稿附件序列化成图片 base64 或文件 receipt；图片在主机侧持久化后随插话发出。 */
  readonly serializeAttachments: (ids: readonly DraftAttachmentId[]) => Promise<readonly SubmitAttachment[]>
  /** 释放已经送出、不再留在草稿里的附件，避免底层对象与预览 URL 泄漏。 */
  readonly releaseAttachment: (id: DraftAttachmentId) => void
}

/**
 * 把暂停控件注册进 composer 工具行右侧。
 * @param ctx 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const connection = (ctx as unknown as { connection: ConnectionHandle }).connection
  const conversation = (ctx as unknown as { conversation: ConversationController }).conversation
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'dsh-pause',
        order: 30,
        inject: (): PauseBarInjected => ({
          rpc: connection.rpc,
          serializeAttachments: async (ids: readonly DraftAttachmentId[]) => {
            // 文件附件走官方提交与 receipt 绑定，本插件暂不接管；这时附件已从输入框移除，只能请用户重选。
            if (conversation.resolveDraftAttachments(ids).some((draft) => draft.kind !== 'image')) {
              throw new Error('文件附件无法随插话发送，请重新选择')
            }
            return (await conversation.serializeDraftAttachments(ids)).attachments
          },
          releaseAttachment: (id: DraftAttachmentId) => {
            conversation.releaseDraftAttachment(id)
          },
        }),
      },
      PauseControl,
    ),
  )
}

export { PauseControl } from './PauseBar.tsx'
export type { PauseControlProps } from './PauseBar.tsx'

