import { describe, expect, it, vi } from 'vitest'
import {
  LarkCalendarAdapter,
  LarkCalendarConfigurationError,
  larkCalendarAdapterFromEnvironment,
} from './lark-calendar-adapter'

/** 2026-07-22T20:00:00+08:00 — inside the fixture day, evening. */
const NOW_MS = Date.parse('2026-07-22T20:00:00+08:00')

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  })
}

function tokenPayload(token = 'tenant-token-1', expire = 7200) {
  return { code: 0, msg: 'ok', tenant_access_token: token, expire }
}

function eventsPayload(items: unknown[]) {
  return { code: 0, msg: 'ok', data: { items, has_more: false } }
}

function eventsPage(items: unknown[], pageToken?: string) {
  return {
    code: 0,
    msg: 'ok',
    data: { items, has_more: pageToken !== undefined, ...(pageToken ? { page_token: pageToken } : {}) },
  }
}

function larkEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'lark-event-1',
    summary: '产品评审',
    status: 'confirmed',
    start_time: { timestamp: String(Math.floor(Date.parse('2026-07-22T21:00:00+08:00') / 1000)) },
    end_time: { timestamp: String(Math.floor(Date.parse('2026-07-22T22:00:00+08:00') / 1000)) },
    location: { name: '会议室 A' },
    ...overrides,
  }
}

function adapterWith(fetch: typeof globalThis.fetch, now: () => number = () => NOW_MS) {
  return new LarkCalendarAdapter({
    allowedHosts: ['open.feishu.cn'],
    appId: 'cli_app',
    appSecret: 'secret-value',
    calendarId: 'primary-calendar',
    fetch,
    now,
  })
}

describe('LarkCalendarAdapter', () => {
  it('exchanges the tenant token once and maps events into the calendar contract', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(tokenPayload()))
      .mockResolvedValueOnce(jsonResponse(eventsPayload([larkEvent()])))
    const adapter = adapterWith(fetch as typeof globalThis.fetch)

    const result = await adapter.listToday()

    expect(result.events).toEqual([{
      eventId: 'lark-event-1',
      title: '产品评审',
      startAt: '2026-07-22T21:00:00+08:00',
      endAt: '2026-07-22T22:00:00+08:00',
      location: '会议室 A',
    }])
    const [tokenCall, eventsCall] = fetch.mock.calls
    expect(String(tokenCall![0])).toContain('/open-apis/auth/v3/tenant_access_token/internal')
    const eventsUrl = new URL(String(eventsCall![0]))
    expect(eventsUrl.pathname).toBe('/open-apis/calendar/v4/calendars/primary-calendar/events')
    // The request window opens at the START of the day: Lark's start_time
    // filters on event start, so opening it at `now` would drop a meeting the
    // driver is currently in. "Remaining" is filtered locally by end time.
    expect(Number(eventsUrl.searchParams.get('start_time'))).toBe(Math.floor(Date.parse('2026-07-22T00:00:00+08:00') / 1000))
    expect((eventsCall![1]?.headers as Record<string, string>).authorization).toBe('Bearer tenant-token-1')
  })

  it('keeps an in-progress meeting on the answer and drops one already over', async () => {
    // Asked at 20:00: the 19:30-20:30 meeting is still the driver's schedule,
    // the 18:00-19:00 one is history, and an untimed 19:00 start with no end
    // has nothing left to attend.
    const inProgress = larkEvent({
      event_id: 'in-progress',
      summary: '正在进行的会',
      start_time: { timestamp: String(Math.floor(Date.parse('2026-07-22T19:30:00+08:00') / 1000)) },
      end_time: { timestamp: String(Math.floor(Date.parse('2026-07-22T20:30:00+08:00') / 1000)) },
    })
    const over = larkEvent({
      event_id: 'over',
      summary: '已结束的会',
      start_time: { timestamp: String(Math.floor(Date.parse('2026-07-22T18:00:00+08:00') / 1000)) },
      end_time: { timestamp: String(Math.floor(Date.parse('2026-07-22T19:00:00+08:00') / 1000)) },
    })
    const startedNoEnd = larkEvent({
      event_id: 'started-no-end',
      summary: '没有结束时间的提醒',
      start_time: { timestamp: String(Math.floor(Date.parse('2026-07-22T19:00:00+08:00') / 1000)) },
      end_time: undefined,
    })
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(tokenPayload()))
      .mockResolvedValueOnce(jsonResponse(eventsPayload([inProgress, over, startedNoEnd])))
    const adapter = adapterWith(fetch as typeof globalThis.fetch)

    const result = await adapter.listToday()

    expect(result.events.map((event) => event.eventId)).toEqual(['in-progress'])
  })

  it('reuses a cached tenant token until its refresh margin and then re-exchanges', async () => {
    let nowMs = NOW_MS
    let tokenExchanges = 0
    const fetch = vi.fn<typeof globalThis.fetch>((url) => {
      if (String(url).includes('tenant_access_token')) {
        tokenExchanges += 1
        return Promise.resolve(jsonResponse(tokenPayload(`token-${tokenExchanges}`)))
      }
      return Promise.resolve(jsonResponse(eventsPayload([])))
    })
    const adapter = adapterWith(fetch as typeof globalThis.fetch, () => nowMs)

    await adapter.listToday()
    await adapter.listToday()
    expect(tokenExchanges).toBe(1)

    // Past the 2h expiry minus the 5-minute margin the token must re-exchange.
    nowMs += (7200 - 200) * 1000
    await adapter.listToday()
    expect(tokenExchanges).toBe(2)
  })

  it('follows pagination and merges every page into one ordered reading', async () => {
    const later = larkEvent({
      event_id: 'lark-event-2',
      summary: '晚间复盘',
      start_time: { timestamp: String(Math.floor(Date.parse('2026-07-22T22:30:00+08:00') / 1000)) },
      end_time: { timestamp: String(Math.floor(Date.parse('2026-07-22T23:00:00+08:00') / 1000)) },
      location: undefined,
    })
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(tokenPayload()))
      // Later event arrives on the FIRST page, earlier on the second: the merge
      // must re-sort across pages, not just concatenate.
      .mockResolvedValueOnce(jsonResponse(eventsPage([later], 'page-2')))
      .mockResolvedValueOnce(jsonResponse(eventsPage([larkEvent()])))
    const adapter = adapterWith(fetch as typeof globalThis.fetch)

    const result = await adapter.listToday()

    expect(result.events.map((event) => event.eventId)).toEqual(['lark-event-1', 'lark-event-2'])
    const pagedCall = fetch.mock.calls[2]!
    expect(new URL(String(pagedCall[0])).searchParams.get('page_token')).toBe('page-2')
  })

  it('treats a has_more page without a page token as an invalid reading', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(tokenPayload()))
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: { items: [larkEvent()], has_more: true } }))
    const adapter = adapterWith(fetch as typeof globalThis.fetch)

    // Presenting part of the day as the whole day is worse than the fixture
    // fallback, so an unfollowable pagination chain must throw.
    await expect(adapter.listToday()).rejects.toMatchObject({ code: 'CALENDAR_RESPONSE_INVALID' })
  })

  it('refuses a pagination chain longer than the page cap instead of truncating it', async () => {
    let pages = 0
    const fetch = vi.fn<typeof globalThis.fetch>((url) => {
      if (String(url).includes('tenant_access_token')) return Promise.resolve(jsonResponse(tokenPayload()))
      pages += 1
      return Promise.resolve(jsonResponse(eventsPage([larkEvent()], `page-${pages}`)))
    })
    const adapter = adapterWith(fetch as typeof globalThis.fetch)

    await expect(adapter.listToday()).rejects.toMatchObject({ code: 'CALENDAR_RESPONSE_INVALID' })
  })

  it('drops cancelled and unmappable events instead of failing the reading', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(tokenPayload()))
      .mockResolvedValueOnce(jsonResponse(eventsPayload([
        larkEvent(),
        larkEvent({ event_id: 'cancelled-1', status: 'cancelled' }),
        larkEvent({ event_id: 'no-title', summary: '   ' }),
        larkEvent({ event_id: 'no-start', start_time: {} }),
      ])))
    const adapter = adapterWith(fetch as typeof globalThis.fetch)

    const result = await adapter.listToday()

    expect(result.events.map((event) => event.eventId)).toEqual(['lark-event-1'])
  })

  it.each([
    ['token http error', () => [jsonResponse(tokenPayload(), { status: 500 })], 'CALENDAR_REQUEST_FAILED'],
    ['token refusal payload', () => [jsonResponse({ code: 99991663, msg: 'app not found' })], 'CALENDAR_RESPONSE_INVALID'],
    ['events http error', () => [jsonResponse(tokenPayload()), jsonResponse({}, { status: 403 })], 'CALENDAR_REQUEST_FAILED'],
    ['events refusal payload', () => [jsonResponse(tokenPayload()), jsonResponse({ code: 190003, msg: 'forbidden' })], 'CALENDAR_RESPONSE_INVALID'],
    ['non-json body', () => [jsonResponse(tokenPayload()), new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })], 'CALENDAR_RESPONSE_INVALID'],
  ])('normalizes %s into a fixed adapter error', async (_label, responses, code) => {
    const queue = responses()
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(queue.shift()!))
    const adapter = adapterWith(fetch as typeof globalThis.fetch)

    await expect(adapter.listToday()).rejects.toMatchObject({ name: 'LarkCalendarError', code })
  })

  it('normalizes a network failure into a fixed adapter error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new TypeError('fetch failed')))
    const adapter = adapterWith(fetch as typeof globalThis.fetch)

    await expect(adapter.listToday()).rejects.toMatchObject({ code: 'CALENDAR_REQUEST_FAILED' })
  })
})

describe('larkCalendarAdapterFromEnvironment', () => {
  const complete = {
    AGENT_CALENDAR_MODE: 'lark',
    AGENT_CALENDAR_APP_ID: 'cli_app',
    AGENT_CALENDAR_APP_SECRET: 'secret-value',
    AGENT_CALENDAR_CALENDAR_ID: 'primary-calendar',
    AGENT_CALENDAR_ALLOWED_HOSTS: 'open.feishu.cn',
  }

  it('returns no adapter when the mode is unset or disabled', () => {
    expect(larkCalendarAdapterFromEnvironment({})).toBeUndefined()
    expect(larkCalendarAdapterFromEnvironment({ AGENT_CALENDAR_MODE: 'disabled' })).toBeUndefined()
  })

  it('rejects stray calendar settings without an explicit mode', () => {
    expect(() => larkCalendarAdapterFromEnvironment({ AGENT_CALENDAR_APP_ID: 'cli_app' }))
      .toThrow(LarkCalendarConfigurationError)
    expect(() => larkCalendarAdapterFromEnvironment({ AGENT_CALENDAR_MODE: 'disabled', AGENT_CALENDAR_APP_ID: 'cli_app' }))
      .toThrow(LarkCalendarConfigurationError)
    expect(() => larkCalendarAdapterFromEnvironment({ AGENT_CALENDAR_MODE: 'google' }))
      .toThrow(LarkCalendarConfigurationError)
  })

  it.each(['AGENT_CALENDAR_APP_ID', 'AGENT_CALENDAR_APP_SECRET', 'AGENT_CALENDAR_CALENDAR_ID', 'AGENT_CALENDAR_ALLOWED_HOSTS'])(
    'requires %s in lark mode',
    (missing) => {
      const environment = { ...complete } as Record<string, string>
      delete environment[missing]
      expect(() => larkCalendarAdapterFromEnvironment(environment)).toThrow(LarkCalendarConfigurationError)
    },
  )

  it('builds an adapter from a complete lark environment', () => {
    expect(larkCalendarAdapterFromEnvironment(complete)).toBeDefined()
  })

  it('rejects a custom endpoint outside the host allowlist or off https', () => {
    expect(() => larkCalendarAdapterFromEnvironment({
      ...complete,
      AGENT_CALENDAR_ENDPOINT: 'https://attacker.example',
    })).toThrow(LarkCalendarConfigurationError)
    expect(() => larkCalendarAdapterFromEnvironment({
      ...complete,
      AGENT_CALENDAR_ENDPOINT: 'http://open.feishu.cn',
    })).toThrow(LarkCalendarConfigurationError)
  })
})
