import { useState, type CSSProperties } from 'react'

/**
 * How much backdrop blur this machine can afford.
 *
 * A `backdrop-filter` is not a paint the compositor does once: it re-samples
 * everything behind the panel every frame the map moves, and the map moves
 * whenever the car does. On a workstation that is free. On a thin client driving
 * a 4K panel it is the difference between a map that pans and a map that stutters
 * — and a stuttering map is worse than a plainer panel, because the effect that
 * cost the frames is the one nobody notices while the thing behind it judders.
 *
 * So the effect is tiered rather than switched off, and it is tiered on what the
 * device reports about itself rather than on which browser is running. Feature
 * detection would answer the wrong question here: every current engine implements
 * `backdrop-filter`, so `@supports` tells us the effect is available and nothing
 * at all about whether it is affordable. Sniffing the engine is worse — it would
 * hand a Mac Studio in Safari the same treatment as a phone in Safari.
 *
 * Nothing here touches contrast. Blur contributes no contrast at all (see
 * `glass-contrast.test.ts`), so every tier reads the same, and the tier that
 * removes the effect entirely repays it in opacity rather than leaving small type
 * over a legible map.
 */
export type GlassTier = 'full' | 'reduced' | 'none'

/**
 * What the tier resolves to, as the two values the stylesheet reads.
 *
 * Intersected with `CSSProperties` so the record goes straight onto a `style`
 * prop — React's own type has no room for custom properties — while each token
 * stays readable by name, which is what lets a test compare the tiers to each
 * other rather than just assert they exist.
 */
export type GlassTierTokens = CSSProperties & {
  '--glass-blur': string
  '--glass-saturate': string
}

/**
 * The blur radius and saturation each tier paints at.
 *
 * `reduced` is a real effect and not a token gesture: 12px still separates the
 * panel from the road beneath it, at roughly a fifth of the sample cost, and the
 * gentler saturation stops the smaller radius from reading as a colour cast.
 * `none` drops both, and the stylesheet pairs it with the opaque fill.
 */
export const GLASS_TIERS: Record<GlassTier, GlassTierTokens> = {
  full: { '--glass-blur': '28px', '--glass-saturate': '1.6' },
  reduced: { '--glass-blur': '12px', '--glass-saturate': '1.25' },
  none: { '--glass-blur': '0px', '--glass-saturate': '1' },
}

/**
 * What a device says about itself, as far as this decision is concerned.
 *
 * Every field is optional because every one of them is optional in some browser,
 * and an absent signal has to mean "no evidence" rather than "bad news" — see
 * `decideGlassTier` for why that direction matters.
 */
export type GlassSignals = {
  /** Logical cores. Reported by every current engine. */
  hardwareConcurrency?: number
  /** GiB of RAM, rounded down to a power of two. Chromium only. */
  deviceMemory?: number
  /** Device pixels per CSS pixel. */
  devicePixelRatio?: number
  /** The viewport's area in CSS pixels. */
  viewportArea?: number
}

/**
 * The signals a real browser can offer, read off one window.
 *
 * Taking the window as an argument rather than reaching for the global is what
 * lets the decision be tested against machines nobody has: a two-core tablet, a
 * 4K display, a browser that reports neither.
 */
export function readGlassSignals(view: Window): GlassSignals {
  const navigatorSignals = view.navigator as Navigator & { deviceMemory?: number }
  return {
    hardwareConcurrency: navigatorSignals.hardwareConcurrency,
    deviceMemory: navigatorSignals.deviceMemory,
    devicePixelRatio: view.devicePixelRatio,
    viewportArea: view.innerWidth * view.innerHeight,
  }
}

/**
 * The device pixels behind the panel, in millions, per frame.
 *
 * The viewport stands in for the panel here. The panel is a bounded fraction of
 * it — the rail caps at 510px and the card is a little over half the height — so
 * the viewport tracks the real figure closely enough to tier on, and unlike a
 * measured panel box it cannot go stale between a resize and a re-render.
 *
 * Squaring the ratio is the point of the measurement: a Retina display is four
 * times the samples of the same layout at 1x, which is how a laptop that handles
 * the effect indoors drops frames the moment it is mirrored to a 4K screen.
 */
function backdropMegapixels(signals: GlassSignals): number {
  const ratio = Math.min(Math.max(signals.devicePixelRatio ?? 1, 1), 4)
  return ((signals.viewportArea ?? 0) * ratio * ratio) / 1e6
}

/**
 * Which tier a device gets.
 *
 * Cores lead because `hardwareConcurrency` is the one signal every engine
 * reports; memory only ever pulls the tier down, never up. That asymmetry is
 * deliberate. `deviceMemory` is Chromium-only, so treating its absence as a bad
 * sign would strip the effect from every Safari and Firefox user on any machine —
 * degrading by browser rather than by capability, which is exactly the failure
 * this replaces.
 *
 * The pixel count is a tiebreaker rather than a gate: a mid-range machine driving
 * an ordinary display keeps the full effect, and the same machine driving four
 * times the pixels steps down. It cannot rescue a device the core count already
 * ruled out, because a two-core machine on a small screen is still a two-core
 * machine.
 */
export function decideGlassTier(signals: GlassSignals): GlassTier {
  // Unknown means capable. A device that reports nothing is far more likely to be
  // a browser withholding the field than a machine too small to say.
  const cores = signals.hardwareConcurrency ?? 8
  const memory = signals.deviceMemory ?? 8

  if (cores <= 2 || memory <= 1) return 'none'
  if (cores <= 4 || memory <= 4) return 'reduced'
  // Roughly a 4K panel: 8.3 megapixels of backdrop to re-sample every frame.
  if (cores < 8 && backdropMegapixels(signals) > 8) return 'reduced'
  return 'full'
}

/**
 * The tier this session runs at, decided once.
 *
 * Once, and not on every resize: a panel whose blur changes as a window is
 * dragged is a panel the driver watches instead of the road, and the tier would
 * be re-deciding on the one signal — viewport area — that is the least
 * consequential of the four. A device that has genuinely changed what it can do
 * has reloaded.
 */
export function useGlassTier(): GlassTier {
  const [tier] = useState<GlassTier>(() =>
    typeof window === 'undefined' ? 'full' : decideGlassTier(readGlassSignals(window)),
  )
  return tier
}
