import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GLASS_TIERS, decideGlassTier, readGlassSignals, type GlassSignals } from './glass-capability'

/**
 * Which machines get the expensive version of the panel.
 *
 * The decision is worth pinning because both ways of getting it wrong are
 * invisible in the place you would look. Too generous and a weak device drops
 * frames while the map pans — and the effect that cost them is the one nobody
 * notices, because the thing juddering is behind it. Too cautious and a perfectly
 * capable machine quietly ships the plain version forever, which no bug report
 * ever arrives about.
 *
 * The cases below are written as devices rather than as numbers, so a threshold
 * moved for one of them has to be defended against the rest.
 */
const stylesheet = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'),
  'utf8',
)

/** A 1920x720 cockpit display at 1x: the resolution the demo is built for. */
const COCKPIT = { devicePixelRatio: 1, viewportArea: 1920 * 720 }
/** A 3840x2160 panel at 2x — 33 megapixels of backdrop per frame. */
const FOUR_K = { devicePixelRatio: 2, viewportArea: 3840 * 2160 }

describe('deciding the glass tier', () => {
  it.each([
    ['a workstation', { hardwareConcurrency: 16, deviceMemory: 32, ...COCKPIT }, 'full'],
    ['a current laptop', { hardwareConcurrency: 8, deviceMemory: 16, ...COCKPIT }, 'full'],
    ['a mid-range phone', { hardwareConcurrency: 6, deviceMemory: 4, devicePixelRatio: 3, viewportArea: 390 * 844 }, 'reduced'],
    ['an entry tablet', { hardwareConcurrency: 4, deviceMemory: 4, ...COCKPIT }, 'reduced'],
    ['a thin client', { hardwareConcurrency: 2, deviceMemory: 2, ...COCKPIT }, 'none'],
    ['a set-top box', { hardwareConcurrency: 4, deviceMemory: 1, ...COCKPIT }, 'none'],
  ] satisfies Array<[string, GlassSignals, string]>)('gives %s the %s tier', (_device, signals, tier) => {
    expect(decideGlassTier(signals)).toBe(tier)
  })

  it('treats a browser that reports nothing as a capable one', () => {
    // The alternative is degrading by engine rather than by device: `deviceMemory`
    // is Chromium-only, so a cautious default would hand every Safari and Firefox
    // user the plain panel on hardware that runs the effect without noticing.
    expect(decideGlassTier({})).toBe('full')
    expect(decideGlassTier({ hardwareConcurrency: 10, ...COCKPIT })).toBe('full')
  })

  it('lets memory pull a tier down but never push one up', () => {
    // Cores are the cross-engine signal and lead the decision; memory is the extra
    // Chromium happens to offer. A machine ruled out on cores stays ruled out
    // however much RAM it reports.
    expect(decideGlassTier({ hardwareConcurrency: 16, deviceMemory: 2, ...COCKPIT })).toBe('reduced')
    expect(decideGlassTier({ hardwareConcurrency: 2, deviceMemory: 64, ...COCKPIT })).toBe('none')
  })

  it('steps a mid-range machine down when the display quadruples the work', () => {
    // Same device, two displays. This is the case a core count alone cannot see:
    // the laptop that runs the effect on its own screen and drops frames the
    // moment it is mirrored to a wall panel.
    const midRange = { hardwareConcurrency: 6, deviceMemory: 16 }
    expect(decideGlassTier({ ...midRange, ...COCKPIT })).toBe('full')
    expect(decideGlassTier({ ...midRange, ...FOUR_K })).toBe('reduced')
  })

  it('does not let a small screen rescue a device the cores ruled out', () => {
    // A two-core machine is a two-core machine at any resolution, so the pixel
    // count is a tiebreaker between tiers and never a way back into one.
    expect(decideGlassTier({ hardwareConcurrency: 2, devicePixelRatio: 1, viewportArea: 320 * 480 })).toBe('none')
  })

  it('keeps the full effect on a workstation driving a 4K panel', () => {
    expect(decideGlassTier({ hardwareConcurrency: 16, deviceMemory: 32, ...FOUR_K })).toBe('full')
  })

  it('reads every signal it decides on off a real window', () => {
    // A field renamed here is a field that silently reads `undefined`, and
    // `undefined` means "capable" — so the mistake would ship as every device
    // getting the full tier, which looks fine on the machine that made it.
    const view = {
      navigator: { hardwareConcurrency: 4, deviceMemory: 2 },
      devicePixelRatio: 2,
      innerWidth: 1280,
      innerHeight: 720,
    } as unknown as Window
    expect(readGlassSignals(view)).toEqual({
      hardwareConcurrency: 4,
      deviceMemory: 2,
      devicePixelRatio: 2,
      viewportArea: 1280 * 720,
    })
  })
})

describe('the tier values the stylesheet paints from', () => {
  it('offers a middle tier that is a real effect rather than a token one', () => {
    const reduced = Number.parseFloat(GLASS_TIERS.reduced['--glass-blur'])
    const full = Number.parseFloat(GLASS_TIERS.full['--glass-blur'])
    // Cheap enough to be worth the tier, wide enough that the panel still reads as
    // glass rather than as a slightly soft rectangle.
    expect(reduced).toBeGreaterThanOrEqual(8)
    expect(reduced).toBeLessThan(full)
    expect(Number.parseFloat(GLASS_TIERS.reduced['--glass-saturate']))
      .toBeLessThan(Number.parseFloat(GLASS_TIERS.full['--glass-saturate']))
  })

  it('declares the full tier as the stylesheet default so an unmounted shell still paints', () => {
    expect(stylesheet).toContain(`--glass-blur: ${GLASS_TIERS.full['--glass-blur']};`)
    expect(stylesheet).toContain(`--glass-saturate: ${GLASS_TIERS.full['--glass-saturate']};`)
  })

  it('paints the panel from the tiered tokens rather than from fixed values', () => {
    // Tokens nothing reads would let the tier resolve correctly and change
    // nothing on screen.
    for (const property of ['backdrop-filter', '-webkit-backdrop-filter']) {
      expect(stylesheet).toContain(`${property}: blur(var(--glass-blur)) saturate(var(--glass-saturate));`)
    }
  })

  it('drops the filter outright at the lowest tier instead of blurring by zero', () => {
    // An identity filter is not free: it still promotes the panel to its own
    // compositing layer and still re-samples the map behind it every frame, which
    // is the cost the tier exists to avoid.
    const lowest = stylesheet.match(
      /\.demo-shell\[data-glass='none'\][\s\S]*?\.ui-card--navigation-summary\s*\{([^}]*)\}/,
    )?.[1]
    expect(lowest).toBeDefined()
    expect(lowest).toContain('backdrop-filter: none;')
    // And it repays the lost separation in opacity, exactly as the branch for
    // browsers without `backdrop-filter` does — see `glass-contrast.test.ts` for
    // why the solid fill is never more transparent than the measured panel.
    expect(lowest).toContain('background: rgb(var(--glass-base) / var(--glass-fill-solid));')
  })
})
