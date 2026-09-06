/**
 * dsh-web-open-access — replacement host half of `@deepseek-ai/dsh-client-connection`.
 *
 * Provides the same `connection` service surface as the shipped package, minus
 * every authentication and trust gate:
 *   - `requestRejection`  → always `undefined` (no 403 Host/Origin fence, no 401 cookie)
 *   - `authorizeIndex`    → always `true` (index served without token/cookie exchange)
 *   - `authenticatedUrl`  → returns the URL with no `?token=`
 *   - the `/api` prefix route is (re)registered with the same bridge semantics
 *   - a `webserver/index-inject` `global` row sets
 *     `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }` in the served index,
 *     so the shipped browser half (kept byte-identical to the installation)
 *     reports `isLoopback: true` on every origin — the privileged surface
 *     behaves exactly like localhost for remote browsers.
 *
 * Self-contained on purpose: this package SHADOWS the installed
 * `@deepseek-ai/dsh-client-connection` (same declared name), so it cannot
 * import the original by name without self-resolving. The RPC envelope
 * schema, the node:http↔fetch bridge, and the shared `/api` fetch handler are
 * faithful ports of the original implementation (MIT).
 */
import { Readable } from 'node:stream'

export const name = '@deepseek-ai/dsh-client-connection'
export const inject = ['webServer']

/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
export const API_PATH = '/api'

/** Default carrier cap for all HTTP RPC bodies (matches the shipped package). */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024
/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

/** Tag a correlation id (runtime identity of the shipped `RpcId`). */
export function RpcId(id) {
  return id
}

/** Carrier-neutral failure returned by one logical RPC endpoint. */
export function transportError(error) {
  return {
    ok: false,
    error: {
      code: 'gateway/internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

/** Static filename of the browser half (module-edge compatibility). */
export function clientRequestSchema(body) {
  // Manual port of the shipped zod `clientRequestSchema` (no zod dependency).
  if (typeof body !== 'object' || body === null) return null
  const { type, rpcId, method } = body
  if (type !== 'client-request' || typeof rpcId !== 'string' || typeof method !== 'string') return null
  return { type, rpcId, method, payload: body.payload }
}

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * node:http ↔ WHATWG fetch bridge for the /api transport (faithful port of the
 * shipped package's internal `http-bridge.ts`).
 */
async function bridge(req, res, apiHandler, maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES) {
  const abort = new AbortController()
  // Client-disconnect detection MUST hang off the response, not the request.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const method = req.method ?? 'GET'
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([, value]) => typeof value === 'string'),
  )
  const bodyMode = apiHandler.requestBodyMode({ method, url })
  let request
  if (bodyMode === 'buffered') {
    const declaredLength = req.headers['content-length']
    if (declaredLength !== undefined && Number(declaredLength) > maxRequestBodyBytes) {
      res.writeHead(413, { connection: 'close' })
      res.end()
      req.destroy()
      return
    }
    const chunks = []
    let received = 0
    for await (const chunk of req) {
      const buffer = chunk
      received += buffer.byteLength
      if (received > maxRequestBodyBytes) {
        res.writeHead(413, { connection: 'close' })
        res.end()
        req.destroy()
        return
      }
      chunks.push(buffer)
    }
    request = new Request(url, {
      method,
      headers,
      ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
      signal: abort.signal,
    })
  } else {
    request = new Request(url, {
      method,
      headers,
      body: Readable.toWeb(req),
      signal: abort.signal,
      duplex: 'half',
    })
  }
  const response = await apiHandler.fetch(request)
  const requestUnread = bodyMode === 'streaming' && !req.readableEnded
  const responseHeaders = Object.fromEntries(response.headers.entries())
  res.writeHead(response.status, requestUnread ? { ...responseHeaders, connection: 'close' } : responseHeaders)
  if (response.body === null) {
    res.end()
    if (requestUnread) req.destroy()
    return
  }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise((resolve) => {
        const done = () => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
  if (requestUnread) req.destroy()
}

function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function invalidEnvelopeResponse(body, issues) {
  const rawId = body !== null && typeof body === 'object' ? body.rpcId : undefined
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'gateway/bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function errorResponse(rpcId, error) {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId, result) {
  const body = { type: 'server-response', rpcId, result }
  return Response.json(body)
}

/** Build the fetch-shaped handler for one RPC channel (port of `rpcFetchHandler`). */
function rpcFetchHandler(channel, handler) {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request) {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const parsed = clientRequestSchema(body)
      if (parsed === null) {
        return invalidEnvelopeResponse(body, [])
      }
      if (parsed.method !== endpoint) {
        return errorResponse(parsed.rpcId, {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(parsed.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }
      try {
        const result = await handler(endpoint, parsed.payload, request.signal)
        return fullResponse(parsed.rpcId, result)
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function assertChannel(channel) {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

function assertFetchRoute(route) {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  if (new Set(route.methods).size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
}

/**
 * Open-access Connection service: the same host half of the /api transport as
 * the shipped package, with authentication, the Host/Origin trust fence, and
 * the launch-token URL exchange removed.
 */
export class HostConnectionService {
  constructor(ctx, trustedHosts, _browserAuth) {
    this.ctx = ctx
    this._trustedHosts = trustedHosts ?? []
    this._browserAuth = _browserAuth
    this._ctx = ctx
    this.interceptors = new Map()
    this.fetchRoutes = new Map()
    ctx.provide('connection', this)
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc() {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) => this.registerInterceptor(owner, channel, matches, handler),
    }
  }

  /** Exact Fetch-route registry scoped to the Context reading this service. */
  get fetch() {
    const owner = this.ctx
    return {
      register: route => this.registerFetchRoute(owner, route),
    }
  }

  /** No rejection: every /api request is allowed. */
  requestRejection() {
    return undefined
  }

  /** Serve the index unconditionally. */
  authorizeIndex() {
    return true
  }

  /** The clean application URL — no launch token. */
  authenticatedUrl(baseUrl) {
    const url = new URL(baseUrl)
    url.search = ''
    url.hash = ''
    return url.href
  }

  /**
   * Compose one shared-channel Fetch handler from exact routes and its interceptor.
   * @param channel - shared channel mounted by Connection (`/api`).
   */
  createSharedFetchHandler(channel) {
    return {
      requestBodyMode: ({ method, url }) => {
        const route = this.fetchRoutes.get(url.pathname)
        return route?.methods.has(method) === true ? route.requestBody : 'buffered'
      },
      fetch: (request) => {
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) return route.fetch(request)
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return interceptor.fetchHandler.fetch(request)
      },
    }
  }

  register(owner, channel, handler) {
    assertChannel(channel)
    const fetchHandler = rpcFetchHandler(channel, handler)
    const route = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const rejection = this.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await bridge(req, res, fetchHandler)
      },
    }
    return owner.effect(
      () => owner.webServer.register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  registerInterceptor(owner, channel, matches, handler) {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor = { matches, fetchHandler: rpcFetchHandler(channel, handler) }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }

  registerFetchRoute(owner, route) {
    assertFetchRoute(route)
    const registered = {
      methods: new Set(route.methods),
      requestBody: route.requestBody,
      fetch: route.fetch,
    }
    return owner.effect(() => {
      if (this.fetchRoutes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      }
      this.fetchRoutes.set(route.path, registered)
      return () => { this.fetchRoutes.delete(route.path) }
    }, `client-connection: ${route.path} Fetch route`)
  }
}

function assertImageBodyCapacity(ctx, maxRequestBodyBytes) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(attachments.imageLimits.maxMessageImageBytes * 4 / 3)
    + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/**
 * Mount the open-access API gateway under the browser transport prefix,
 * serving every request without authentication.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (trustedHosts is accepted and ignored).
 */
export async function apply(ctx, config) {
  const trustedHosts = config?.trustedHosts ?? []
  const maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  const connection = new HostConnectionService(ctx, trustedHosts, undefined)
  const fetchHandler = connection.createSharedFetchHandler(API_PATH)
  const route = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await bridge(req, res, fetchHandler, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
  // Force the privileged-surface semantics in the browser: the shipped client
  // applies `isLoopback = transport.ownsHost === true || ...`. The browser
  // half is kept byte-identical to the installation, so the flag is injected
  // here, in the served index, through the webserver's own injection channel.
  // The client entry awaits __DSH_BOOT_READY__ (resolved at the end of the
  // document) before activating, so this head `global` row always runs before
  // Connection's client apply reads it.
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
  })
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
}
