import {
  modelPlanningOutputSchema,
  modelPlanningRequestSchema,
  type ModelPlanningRequest,
} from '@canvasflow/schema'
import { normalizeFlightNumber } from './flight-number'
import { parsePassengers } from './passengers'
import { planAirportPickup, type Plan, type PlannerInput } from './planner'

const defaultConfidenceThreshold = 0.8
const defaultTimeoutMs = 5_000
const maximumTimeoutMs = 30_000
const maximumModelIdLength = 100
const adapterAborted = Symbol('adapter-aborted')

export type ModelPlanningAdapter = {
  modelId: string
  plan(request: ModelPlanningRequest, options: { signal: AbortSignal }): Promise<unknown>
}

export type ModelGatewayOptions = {
  adapter?: ModelPlanningAdapter
  confidenceThreshold?: number
  timeoutMs?: number
}

export type ModelGatewayPlanOptions = {
  signal?: AbortSignal
}

export type ModelGatewayResult =
  | { source: 'rules'; plan: Plan }
  | { source: 'model'; plan: Plan; modelUsed: string }
  | { source: 'fallback'; plan: Plan }

/** Rules stay authoritative; the optional model may only canonicalize unknown user input. */
export class ModelGateway {
  readonly #adapter: ModelPlanningAdapter | undefined
  readonly #confidenceThreshold: number
  readonly #timeoutMs: number
  readonly #modelId: string | undefined

  constructor(options: ModelGatewayOptions = {}) {
    this.#adapter = options.adapter
    this.#confidenceThreshold = validConfidenceThreshold(options.confidenceThreshold)
    this.#timeoutMs = validTimeout(options.timeoutMs)
    this.#modelId = sanitizeModelId(options.adapter?.modelId)
  }

  async plan(input: PlannerInput, options: ModelGatewayPlanOptions = {}): Promise<ModelGatewayResult> {
    const rulesPlan = planAirportPickup(input)
    if (rulesPlan.intent !== 'unknown') return { source: 'rules', plan: rulesPlan }
    if (!this.#adapter || !this.#modelId || options.signal?.aborted) {
      return { source: 'fallback', plan: rulesPlan }
    }

    const request = modelPlanningRequestSchema.safeParse(buildModelRequest(input))
    if (!request.success) return { source: 'fallback', plan: rulesPlan }

    const rawOutput = await callAdapterOnce(this.#adapter, request.data, this.#timeoutMs, options.signal)
    if (rawOutput === adapterAborted) return { source: 'fallback', plan: rulesPlan }

    const output = modelPlanningOutputSchema.safeParse(rawOutput)
    if (!output.success || output.data.confidence < this.#confidenceThreshold) {
      return { source: 'fallback', plan: rulesPlan }
    }

    const modelPlan = planAirportPickup({ ...input, text: output.data.canonicalInput })
    if (!isAllowedModelPlan(modelPlan, output.data.intentHint)
      || (modelPlan.intent === 'create-airport-pickup' && !hasGroundedPickupAction(input.text))
      || !modelPlanMatchesEvidence(input.text, modelPlan, output.data.evidence)) {
      return { source: 'fallback', plan: rulesPlan }
    }

    return { source: 'model', plan: modelPlan, modelUsed: this.#modelId }
  }
}

export async function planWithModelGateway(
  input: PlannerInput,
  gatewayOptions: ModelGatewayOptions = {},
  planOptions: ModelGatewayPlanOptions = {},
): Promise<ModelGatewayResult> {
  return new ModelGateway(gatewayOptions).plan(input, planOptions)
}

function buildModelRequest(input: PlannerInput): ModelPlanningRequest {
  const stateFlightNumber = normalizeFlightNumber(input.state?.flight?.flightNumber ?? '')
  return {
    text: input.text.trim(),
    context: {
      ...(input.state ? { phase: input.state.phase } : {}),
      knownSlots: {
        passengers: Boolean(input.state?.passengers.names.length),
        ...(stateFlightNumber ? { flightNumber: stateFlightNumber } : {}),
      },
    },
  }
}

function isAllowedModelPlan(plan: Plan, intentHint: string): boolean {
  return (plan.intent === 'create-airport-pickup' || plan.intent === 'provide-flight-number')
    && plan.intent === intentHint
    && plan.proposedEvents.length > 0
    && plan.proposedEvents.every((event) => event.type === 'user.input')
}

export function modelPlanMatchesEvidence(
  originalText: string,
  plan: Plan,
  evidence: { passengers?: string[]; flightNumber?: string },
): boolean {
  const passengerEvidence = evidence.passengers
  const flightEvidence = evidence.flightNumber
  if (!passengerEvidence && !flightEvidence) return false
  if (passengerEvidence?.some((quote) => !originalText.includes(quote))) return false
  if (flightEvidence && !originalText.includes(flightEvidence)) return false

  const groundedPassengers = passengerEvidence ? parsePassengers(passengerEvidence.join(' ')) : undefined
  const groundedFlightNumber = flightEvidence ? normalizeFlightNumber(flightEvidence) : undefined
  const plannedPassengers = plan.slotUpdates.passengers
  const plannedFlightNumber = plan.slotUpdates.flightNumber

  if (Boolean(plannedPassengers) !== Boolean(groundedPassengers)) return false
  if (plannedPassengers && groundedPassengers
    && (!sameStrings(plannedPassengers.memberIds, groundedPassengers.memberIds)
      || !sameStrings(plannedPassengers.names, groundedPassengers.names))) return false
  if (plannedFlightNumber !== groundedFlightNumber) return false
  return true
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function hasGroundedPickupAction(originalText: string): boolean {
  const compactText = originalText.replace(/\s+/gu, '')
  if (!parsePassengers(compactText)) return false

  const airport = '(?:机场|航站楼|航站)'
  const passengers = '(?:妈妈|爸爸|豆豆)(?:和(?:妈妈|爸爸|豆豆))*'
  const requestCue = '(?:请|麻烦(?:你)?|劳驾|帮我|帮忙|替我|需要你|能不能|能否|可以(?:帮我|替我))'
  const pickupAction = `(?:(?:把)?${passengers}(?:接回来|接回|接走|带回来|带回)|(?:接|带)${passengers}(?:回来|回|走))`
  const directRequest = new RegExp(
    `^(?:${airport}(?:那趟|那边)?[，,])?(?:${requestCue})+(?:(?:去|到)${airport}(?:那趟|那边)?[，,]?)?${pickupAction}(?:一下|吧|好吗|可以吗|行吗)?[。！!]?$`,
    'u',
  )
  return directRequest.test(compactText)
}

async function callAdapterOnce(
  adapter: ModelPlanningAdapter,
  request: ModelPlanningRequest,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<unknown | typeof adapterAborted> {
  const controller = new AbortController()
  let resolveAborted: (value: typeof adapterAborted) => void = () => undefined
  const aborted = new Promise<typeof adapterAborted>((resolve) => {
    resolveAborted = resolve
  })
  const onAbort = () => resolveAborted(adapterAborted)
  controller.signal.addEventListener('abort', onAbort, { once: true })
  const onCallerAbort = () => controller.abort(callerSignal?.reason)
  if (callerSignal) callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  if (callerSignal?.aborted) onCallerAbort()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const adapterCall = Promise.resolve().then(() => adapter.plan(request, { signal: controller.signal }))
    return await Promise.race([adapterCall, aborted])
  } catch {
    return adapterAborted
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

function validConfidenceThreshold(value: number | undefined): number {
  if (value === undefined) return defaultConfidenceThreshold
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('confidenceThreshold must be a finite number between 0 and 1')
  }
  return value
}

function validTimeout(value: number | undefined): number {
  if (value === undefined) return defaultTimeoutMs
  if (!Number.isInteger(value) || value < 1 || value > maximumTimeoutMs) {
    throw new RangeError(`timeoutMs must be an integer between 1 and ${maximumTimeoutMs}`)
  }
  return value
}

function sanitizeModelId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maximumModelIdLength || hasControlCharacters(trimmed)) {
    return undefined
  }
  return trimmed
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
  })
}
