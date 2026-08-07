import {
  listUpcomingEventsOutputSchema,
  type ListUpcomingEventsOutput,
} from '@canvasflow/schema'

const DEFAULT_ENDPOINT = 'https://open.feishu.cn'
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 1024 * 1024
/** Refresh the tenant token this long before Lark says it expires. */
const TOKEN_REFRESH_MARGIN_SECONDS = 300
/** Pages the events read will follow before calling the day incomplete. */
const MAX_EVENT_PAGES = 10
/** Every calendar value the demo renders is expressed in this offset. */
const CALENDAR_UTC_OFFSET = '+08:00'
const CALENDAR_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

export class LarkCalendarConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LarkCalendarConfigurationError'
  }
}

export type LarkCalendarErrorCode =
  | 'CALENDAR_REQUEST_ABORTED'
  | 'CALENDAR_REQUEST_FAILED'
  | 'CALENDAR_RESPONSE_INVALID'

export class LarkCalendarError extends Error {
  constructor(readonly code: LarkCalendarErrorCode) {
    super(code === 'CALENDAR_REQUEST_ABORTED'
      ? 'Lark calendar request was aborted'
      : code === 'CALENDAR_REQUEST_FAILED'
        ? 'Lark calendar request failed'
        : 'Lark calendar response was invalid')
    this.name = 'LarkCalendarError'
  }
}

export type LarkCalendarAdapterOptions = {
  endpoint?: string
  allowedHosts: string[]
  appId: string
  appSecret: string
  calendarId: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  /** Test seam; production uses the real clock. */
  now?: () => number
}

/** The seam the runtime prefetches through; kept narrow so tests can stub it. */
export type ScheduleAdapter = {
  listToday(): Promise<ListUpcomingEventsOutput>
}

/**
 * Reads today's remaining events from a Lark (飞书) calendar with a tenant
 * access token. Deliberately transport-only: the runtime prefetches OUTSIDE
 * the SQLite transaction and hands the resolved result in, so nothing here is
 * ever awaited inside the synchronous gateway. Every failure throws one of
 * the fixed error classes and the caller falls back to the fixture calendar.
 */
export class LarkCalendarAdapter implements ScheduleAdapter {
  readonly #endpoint: string
  readonly #appId: string
  readonly #appSecret: string
  readonly #calendarId: string
  readonly #timeoutMs: number
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number
  #token: { value: string; expiresAtMs: number } | undefined

  constructor(options: LarkCalendarAdapterOptions) {
    this.#endpoint = validatedEndpoint(options.endpoint ?? DEFAULT_ENDPOINT, options.allowedHosts)
    this.#appId = validatedSecret(options.appId, 'appId')
    this.#appSecret = validatedSecret(options.appSecret, 'appSecret')
    this.#calendarId = validatedSecret(options.calendarId, 'calendarId')
    this.#timeoutMs = validatedTimeoutNumber(options.timeoutMs)
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#now = options.now ?? Date.now
  }

  async listToday(): Promise<ListUpcomingEventsOutput> {
    const token = await this.#tenantToken()
    const nowMs = this.#now()
    const startOfDayMs = startOfCalendarDayMs(nowMs)
    const endOfDayMs = startOfDayMs + 24 * 60 * 60 * 1000

    // The events endpoint is paginated: follow page_token until has_more goes
    // false. A day that still reports more pages past the cap is treated as an
    // invalid read rather than silently truncated — a card that presents part
    // of the day as the whole day is worse than the fixture fallback.
    const items: unknown[] = []
    let pageToken: string | undefined
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const url = new URL(
        `/open-apis/calendar/v4/calendars/${encodeURIComponent(this.#calendarId)}/events`,
        this.#endpoint,
      )
      url.searchParams.set('start_time', String(Math.floor(Math.max(nowMs, startOfDayMs) / 1000)))
      url.searchParams.set('end_time', String(Math.floor(endOfDayMs / 1000)))
      if (pageToken) url.searchParams.set('page_token', pageToken)

      const payload = await this.#requestJson(url.href, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      })
      if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data)) {
        throw new LarkCalendarError('CALENDAR_RESPONSE_INVALID')
      }
      if (Array.isArray(payload.data.items)) items.push(...payload.data.items)
      const hasMore = payload.data.has_more === true
      const nextToken = typeof payload.data.page_token === 'string' && payload.data.page_token
        ? payload.data.page_token
        : undefined
      if (!hasMore) break
      if (!nextToken || page === MAX_EVENT_PAGES - 1) {
        throw new LarkCalendarError('CALENDAR_RESPONSE_INVALID')
      }
      pageToken = nextToken
    }

    const events = items
      .flatMap((item) => {
        const event = mapLarkEvent(item)
        return event ? [event] : []
      })
      .sort((left, right) => left.startAt.localeCompare(right.startAt))
    return listUpcomingEventsOutputSchema.parse({ events })
  }

  async #tenantToken(): Promise<string> {
    const cached = this.#token
    if (cached && cached.expiresAtMs > this.#now()) return cached.value

    const payload = await this.#requestJson(
      new URL('/open-apis/auth/v3/tenant_access_token/internal', this.#endpoint).href,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: this.#appId, app_secret: this.#appSecret }),
      },
    )
    if (
      !isRecord(payload)
      || payload.code !== 0
      || typeof payload.tenant_access_token !== 'string'
      || !payload.tenant_access_token
      || typeof payload.expire !== 'number'
    ) {
      throw new LarkCalendarError('CALENDAR_RESPONSE_INVALID')
    }
    this.#token = {
      value: payload.tenant_access_token,
      expiresAtMs: this.#now() + Math.max(0, payload.expire - TOKEN_REFRESH_MARGIN_SECONDS) * 1000,
    }
    return this.#token.value
  }

  async #requestJson(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<unknown> {
    let response: Response
    try {
      response = await this.#fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      throw new LarkCalendarError(isAbort(error) ? 'CALENDAR_REQUEST_ABORTED' : 'CALENDAR_REQUEST_FAILED')
    }
    if (response.status !== 200) {
      cancelBody(response)
      throw new LarkCalendarError('CALENDAR_REQUEST_FAILED')
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      cancelBody(response)
      throw new LarkCalendarError('CALENDAR_RESPONSE_INVALID')
    }
    let text: string
    try {
      text = await response.text()
    } catch {
      throw new LarkCalendarError('CALENDAR_RESPONSE_INVALID')
    }
    if (text.length > MAX_RESPONSE_BYTES) throw new LarkCalendarError('CALENDAR_RESPONSE_INVALID')
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new LarkCalendarError('CALENDAR_RESPONSE_INVALID')
    }
  }
}

export type LarkCalendarEnvironmentOptions = {
  fetch?: typeof globalThis.fetch
  now?: () => number
}

/**
 * Parse the optional Lark calendar transport from the environment. The same
 * three-state switch as the model adapter: no configuration means the fixture
 * calendar answers every schedule query.
 */
export function larkCalendarAdapterFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: LarkCalendarEnvironmentOptions = {},
): ScheduleAdapter | undefined {
  const mode = environment.AGENT_CALENDAR_MODE
  const appId = environment.AGENT_CALENDAR_APP_ID
  const appSecret = environment.AGENT_CALENDAR_APP_SECRET
  const calendarId = environment.AGENT_CALENDAR_CALENDAR_ID
  const allowedHosts = environment.AGENT_CALENDAR_ALLOWED_HOSTS
  const endpoint = environment.AGENT_CALENDAR_ENDPOINT
  const timeout = environment.AGENT_CALENDAR_TIMEOUT_MS
  const supplied = [appId, appSecret, calendarId, allowedHosts, endpoint, timeout].some((value) => value !== undefined)

  if (mode === undefined) {
    if (supplied) throw new LarkCalendarConfigurationError('AGENT_CALENDAR_MODE is required when calendar settings are supplied')
    return undefined
  }
  if (mode === 'disabled') {
    if (supplied) throw new LarkCalendarConfigurationError('Calendar settings must not be supplied while AGENT_CALENDAR_MODE is disabled')
    return undefined
  }
  if (mode !== 'lark') {
    throw new LarkCalendarConfigurationError('AGENT_CALENDAR_MODE must be disabled or lark')
  }
  if (appId === undefined) throw new LarkCalendarConfigurationError('AGENT_CALENDAR_APP_ID is required')
  if (appSecret === undefined) throw new LarkCalendarConfigurationError('AGENT_CALENDAR_APP_SECRET is required')
  if (calendarId === undefined) throw new LarkCalendarConfigurationError('AGENT_CALENDAR_CALENDAR_ID is required')
  if (allowedHosts === undefined) throw new LarkCalendarConfigurationError('AGENT_CALENDAR_ALLOWED_HOSTS is required')

  return new LarkCalendarAdapter({
    ...(endpoint === undefined ? {} : { endpoint }),
    allowedHosts: allowedHosts.split(',').map((host) => host.trim()),
    appId,
    appSecret,
    calendarId,
    ...(timeout === undefined ? {} : { timeoutMs: validatedTimeoutString(timeout) }),
    fetch: options.fetch,
    ...(options.now ? { now: options.now } : {}),
  })
}

/** Unix or millisecond epoch → the calendar's fixed +08:00 ISO rendering. */
function larkTimestampToIso(value: string): string | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const epochMs = value.length > 11 ? Number(value) : Number(value) * 1000
  if (!Number.isSafeInteger(epochMs)) return undefined
  return new Date(epochMs + CALENDAR_UTC_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/u, CALENDAR_UTC_OFFSET)
}

function startOfCalendarDayMs(nowMs: number): number {
  const offset = new Date(nowMs + CALENDAR_UTC_OFFSET_MS)
  offset.setUTCHours(0, 0, 0, 0)
  return offset.getTime() - CALENDAR_UTC_OFFSET_MS
}

function mapLarkEvent(item: unknown): ListUpcomingEventsOutput['events'][number] | undefined {
  if (!isRecord(item)) return undefined
  if (item.status === 'cancelled') return undefined
  const eventId = typeof item.event_id === 'string' && item.event_id ? item.event_id : undefined
  const title = typeof item.summary === 'string' && item.summary.trim() ? item.summary.trim() : undefined
  const start = isRecord(item.start_time) && typeof item.start_time.timestamp === 'string'
    ? larkTimestampToIso(item.start_time.timestamp)
    : undefined
  if (!eventId || !title || !start) return undefined
  const end = isRecord(item.end_time) && typeof item.end_time.timestamp === 'string'
    ? larkTimestampToIso(item.end_time.timestamp)
    : undefined
  const location = isRecord(item.location) && typeof item.location.name === 'string' && item.location.name.trim()
    ? item.location.name.trim()
    : undefined
  return {
    eventId,
    title,
    startAt: start,
    ...(end ? { endAt: end } : {}),
    ...(location ? { location } : {}),
  }
}

function validatedEndpoint(value: string, allowedHosts: string[]): string {
  if (hasControlCharacters(value)) throw new LarkCalendarConfigurationError('endpoint is invalid')
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
    throw new LarkCalendarConfigurationError('allowedHosts is invalid')
  }
  const hosts = new Set<string>()
  for (const entry of allowedHosts) {
    const host = entry.trim().toLowerCase()
    if (!host || hasControlCharacters(host) || host.includes(':') || !host.includes('.')) {
      throw new LarkCalendarConfigurationError('allowedHosts is invalid')
    }
    hosts.add(host)
  }
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new LarkCalendarConfigurationError('endpoint is invalid')
  }
  if (endpoint.protocol !== 'https:'
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || endpoint.pathname !== '/'
    || !hosts.has(endpoint.hostname.toLowerCase())) {
    throw new LarkCalendarConfigurationError('endpoint is invalid')
  }
  return endpoint.origin
}

function validatedSecret(value: string, name: string): string {
  const trimmed = value.trim()
  if (!trimmed || hasControlCharacters(trimmed)) {
    throw new LarkCalendarConfigurationError(`${name} is invalid`)
  }
  return trimmed
}

function validatedTimeoutNumber(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new LarkCalendarConfigurationError('timeoutMs is invalid')
  }
  return value
}

function validatedTimeoutString(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new LarkCalendarConfigurationError('AGENT_CALENDAR_TIMEOUT_MS is invalid')
  return validatedTimeoutNumber(Number(value))
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined)
  } catch {
    // Cleanup must never replace the fixed adapter error.
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
  })
}
