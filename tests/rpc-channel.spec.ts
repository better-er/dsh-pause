/**
 * rpc-channel 单元测试：伪造 connection 与 webServer 作用域，覆盖鉴权、路由、信封、content-type 与限长分支。
 */
import { describe, expect, it } from 'vitest'
import { mountRpcChannel, type RpcChannelResult } from '../src/rpc-channel.ts'

/** webServer 注册的 prefix 路由最小形态。 */
interface RegisteredRoute {
  kind: 'prefix'
  path: string
  handler: (req: FakeRequest, res: FakeResponse) => void | Promise<void>
}

/** 伪造的 node 请求：headers、method、url 与可异步迭代的请求体。 */
interface FakeRequest {
  method: string
  url: string
  headers: Record<string, string>
  destroy(): void
  [Symbol.asyncIterator](): AsyncIterator<Buffer>
}

/** 伪造的 node 响应：记录状态、响应头与正文，并支持 close 监听。 */
interface FakeResponse {
  statusCode: number
  headers: Record<string, string> | undefined
  body: string
  listeners: Map<string, (() => void)[]>
  writeHead(code: number, headers?: Record<string, string>): void
  end(chunk?: string): void
  on(event: string, listener: () => void): void
  off(event: string, listener: () => void): void
}

function makeRequest(options: { method?: string; url?: string; body?: Buffer; headers?: Record<string, string> } = {}): FakeRequest {
  const chunks = options.body === undefined ? [] : [options.body]
  return {
    method: options.method ?? 'POST',
    url: options.url ?? '/dsh-pause/status',
    headers: options.headers ?? { 'content-type': 'application/json' },
    destroy(): void {},
    [Symbol.asyncIterator](): AsyncIterator<Buffer> {
      let index = 0
      return {
        next: async () => index < chunks.length
          ? { value: chunks[index++] as Buffer, done: false }
          : { value: undefined as unknown as Buffer, done: true },
      }
    },
  }
}

function makeResponse(): FakeResponse {
  return {
    statusCode: 0,
    headers: undefined,
    body: '',
    listeners: new Map<string, (() => void)[]>(),
    writeHead(code: number, headers?: Record<string, string>): void {
      this.statusCode = code
      this.headers = headers
    },
    end(chunk?: string): void {
      this.body = chunk ?? ''
    },
    on(event: string, listener: () => void): void {
      const list = this.listeners.get(event) ?? []
      list.push(listener)
      this.listeners.set(event, list)
    },
    off(event: string, listener: () => void): void {
      const list = this.listeners.get(event) ?? []
      this.listeners.set(event, list.filter((item) => item !== listener))
    },
  }
}

/** 挂载一条通道，返回 webServer 收到的路由；服务缺席时返回 undefined。 */
function mount(
  handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcChannelResult>,
  options: { rejection?: 401 | 403; connection?: boolean; webServer?: boolean } = {},
): RegisteredRoute | undefined {
  let route: RegisteredRoute | undefined
  const scope = {
    connection: { requestRejection: (): 401 | 403 | undefined => options.rejection },
    webServer: {
      register(registered: RegisteredRoute): () => void {
        route = registered
        return () => {}
      },
    },
    effect(callback: () => (() => void) | undefined): unknown {
      return callback()
    },
  }
  const ctx = {
    inject(deps: string[], callback: (raw: unknown) => void): unknown {
      if (options.connection === false && deps.includes('connection')) return undefined
      if (options.webServer === false && deps.includes('webServer')) return undefined
      callback(scope)
      return undefined
    },
  }
  mountRpcChannel(ctx, '/dsh-pause', handler)
  return route
}

const okHandler = async (): Promise<RpcChannelResult> => ({ ok: true, value: { paused: true } })

/** 组装一个合法 client-request 信封。 */
function envelope(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'pause-1', method: 'status', payload: {}, ...overrides }))
}

describe('mountRpcChannel', () => {
  it('合法请求回写 server-response 信封并在结束后摘除 close 监听', async () => {
    const route = mount(okHandler)!
    const res = makeResponse()
    await route.handler(makeRequest({ body: envelope() }), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      type: 'server-response',
      rpcId: 'pause-1',
      result: { ok: true, value: { paused: true } },
    })
    expect(res.listeners.get('close') ?? []).toHaveLength(0)
  })

  it('鉴权拒绝原样透传 401', async () => {
    const route = mount(okHandler, { rejection: 401 })!
    const res = makeResponse()
    await route.handler(makeRequest({ body: envelope() }), res)
    expect(res.statusCode).toBe(401)
    expect(res.body).toBe('unauthorized')
  })

  it('鉴权拒绝原样透传 403', async () => {
    const route = mount(okHandler, { rejection: 403 })!
    const res = makeResponse()
    await route.handler(makeRequest({ body: envelope() }), res)
    expect(res.statusCode).toBe(403)
    expect(res.body).toBe('forbidden')
  })

  it('非 POST 返回 404', async () => {
    const route = mount(okHandler)!
    const res = makeResponse()
    await route.handler(makeRequest({ method: 'GET', body: envelope() }), res)
    expect(res.statusCode).toBe(404)
  })

  it('路径不匹配返回 404', async () => {
    const route = mount(okHandler)!
    const res = makeResponse()
    await route.handler(makeRequest({ url: '/other/status', body: envelope() }), res)
    expect(res.statusCode).toBe(404)
  })

  it('空端点返回 404', async () => {
    const route = mount(okHandler)!
    const res = makeResponse()
    await route.handler(makeRequest({ url: '/dsh-pause/', body: envelope() }), res)
    expect(res.statusCode).toBe(404)
  })

  it('端点段含非法字符返回 404', async () => {
    const route = mount(okHandler)!
    const res = makeResponse()
    await route.handler(makeRequest({ url: '/dsh-pause/a@b', body: envelope() }), res)
    expect(res.statusCode).toBe(404)
  })

  it('content-type 非 application/json 返回 415', async () => {
    const route = mount(okHandler)!
    const res = makeResponse()
    await route.handler(makeRequest({ body: envelope(), headers: { 'content-type': 'text/plain' } }), res)
    expect(res.statusCode).toBe(415)
  })

  it('信封不合法回 bad-request 且保留 rpcId', async () => {
    const route = mount(okHandler)!
    const res = makeResponse()
    await route.handler(makeRequest({ body: Buffer.from(JSON.stringify({ rpcId: 'pause-9', method: 'status' })) }), res)
    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.body) as { rpcId: string; result: { ok: boolean; error: { code: string } } }
    expect(parsed.rpcId).toBe('pause-9')
    expect(parsed.result.ok).toBe(false)
    expect(parsed.result.error.code).toBe('gateway/bad-request')
  })

  it('method 与端点不一致回 bad-request', async () => {
    const route = mount(okHandler)!
    const res = makeResponse()
    await route.handler(makeRequest({ body: envelope({ method: 'release' }) }), res)
    const parsed = JSON.parse(res.body) as { result: { ok: boolean; error: { message: string } } }
    expect(parsed.result.ok).toBe(false)
    expect(parsed.result.error.message).toContain('does not match endpoint')
  })

  it('请求体超限回 413、带 connection: close 并断开请求', async () => {
    const route = mount(okHandler)!
    const res = makeResponse()
    let destroyed = false
    const req = makeRequest({ body: Buffer.alloc(8 * 1024 * 1024 + 1) })
    req.destroy = (): void => { destroyed = true }
    await route.handler(req, res)
    expect(res.statusCode).toBe(413)
    expect(res.headers?.connection).toBe('close')
    expect(destroyed).toBe(true)
  })

  it('content-length 预声明超限即快速 413', async () => {
    const route = mount(okHandler)!
    const res = makeResponse()
    await route.handler(makeRequest({ headers: { 'content-type': 'application/json', 'content-length': String(8 * 1024 * 1024 + 1) } }), res)
    expect(res.statusCode).toBe(413)
  })

  it('webServer 缺席时不挂载通道', () => {
    expect(mount(okHandler, { webServer: false })).toBeUndefined()
  })

  it('connection 缺席时不挂载通道', () => {
    expect(mount(okHandler, { connection: false })).toBeUndefined()
  })
})
