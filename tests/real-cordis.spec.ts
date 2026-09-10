/**
 * 真实 cordis 4.0.2 与真实 connection 服务接线冒烟：
 * 加载真实 client-connection 插件，断言它在假 webServer 上挂出 /api，并断言 dsh-pause 在 connection 就绪后挂出自注册的 /dsh-pause 路由。
 */
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import * as connection from '@deepseek-ai/dsh-client-connection'
import * as pause from '../src/index.ts'

/** 真实插件注册到 webServer 的 prefix 路由最小形态。 */
interface RegisteredRoute {
  kind: 'prefix'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

/** 最小 credentials 服务：浏览器会话密钥首次创建时授予。 */
class FakeCredentials extends Service {
  constructor(ctx: Context) { super(ctx, 'credentials') }
  async modifyRecord(_key: string, update: (current: unknown) => Promise<unknown>): Promise<unknown> {
    return update(undefined)
  }
}

/** 最小 webServer 服务：记录注册的 prefix 路由。 */
class FakeWebServer extends Service {
  readonly routes: RegisteredRoute[] = []
  constructor(ctx: Context) { super(ctx, 'webServer') }
  register(route: RegisteredRoute): () => void {
    this.routes.push(route)
    return () => {}
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

function pathsOf(ctx: Context): string[] {
  const webServer = (ctx as unknown as { webServer: FakeWebServer }).webServer
  return webServer.routes.map((route) => route.path)
}

describe('真实 cordis 接线冒烟', () => {
  it('真实 connection 服务就绪后同时挂载 /api 与 /dsh-pause', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeCredentials)
    await ctx.plugin(FakeWebServer)
    await ctx.plugin(connection)
    await settle()
    await ctx.plugin(pause)
    await settle()
    const paths = pathsOf(ctx)
    expect(paths).toContain('/api')
    expect(paths).toContain('/dsh-pause')
  })

  it('connection 服务缺席时 dsh-pause 不挂载也不报错', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeWebServer)
    void ctx.plugin(pause)
    await settle()
    expect(pathsOf(ctx)).not.toContain('/dsh-pause')
  })
})
