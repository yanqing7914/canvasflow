import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * What the floating navigation panel is allowed to take over, measured from the
 * stylesheet.
 *
 * The panel works by collapsing a split layout's two columns onto one cell and
 * floating the secondary slot over the map. That is only sound while the
 * secondary slot holds a single card: `withRouteMap` puts every non-map card
 * into `secondary`, and the density trim keeps multi-card states such as
 * `['navigation-summary', 'extra-1']` legal, so the rail is not guaranteed to
 * hold one. Only a card is painted as a panel, so a second card in an overlaid
 * rail would be transparent, square-cornered text sitting straight on the map.
 *
 * Every rule that participates in the takeover therefore carries the same
 * single-card guard. Dropping it from any one of them is how that regression
 * comes back — the columns would collapse while the paint no longer followed —
 * so the guard is asserted per selector here rather than once for the block.
 */
/* Resolved from this file rather than the working directory, so the test reads
   the stylesheet it is paired with wherever vitest is launched from. Built up
   from `dirname` because Vite rewrites `new URL(..., import.meta.url)` into an
   asset reference, which is no longer a path on disk. */
const stylesheet = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'),
  'utf8',
)

const OVERLAY_SCOPE = '.ui-layout--split:has(.ui-card--route-map)'
const SINGLE_CARD_GUARD = ':has(> .ui-slot--secondary > .ui-component:only-child)'

/**
 * Every declaration block in the stylesheet, as `{ selector, body }`.
 *
 * The pattern only matches blocks that contain no braces of their own, so it
 * yields leaf rules and never an `@media` or `@supports` wrapper — their bodies
 * hold braces and cannot match. Selectors are whitespace-collapsed and stripped
 * of comments, so one broken across lines reads the same as one written on a
 * single line.
 */
const rules = [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((match) => ({
    selector: match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim(),
    body: match[2],
  }))
  .filter((rule) => rule.selector.length > 0 && !rule.selector.startsWith('@'))

const overlayRules = rules.filter((rule) => rule.selector.includes(OVERLAY_SCOPE))

describe('floating navigation panel scope', () => {
  it('finds the rules it is meant to be checking', () => {
    // Without this the suite would pass vacuously if the block were renamed or
    // the scope selector rewritten, which is the one way it could go quiet and
    // still be wrong.
    expect(overlayRules.length).toBeGreaterThanOrEqual(8)
  })

  it.each(
    // One case per comma-separated selector, so a grouped rule that guards only
    // its first selector fails on the second instead of passing on the group.
    overlayRules.flatMap((rule) => rule.selector.split(',').map((one) => one.trim())).filter(Boolean),
  )('guards %s to a single-card rail', (selector) => {
    expect(selector).toContain(SINGLE_CARD_GUARD)
  })

  it('takes the pointer back at the component rather than at the card', () => {
    // The slot turns pointer events off so the map behind the rail stays
    // draggable. The renderer puts a card's buttons in a `.ui-card__actions`
    // that is the card's sibling inside `.ui-component`, so restoring them on
    // the card alone would leave every button beside it dead while looking live.
    const restoring = overlayRules.filter((rule) => /pointer-events:\s*auto/.test(rule.body))
    expect(restoring.length).toBeGreaterThan(0)
    for (const rule of restoring) {
      expect(rule.selector).toContain('> .ui-slot--secondary > .ui-component')
    }
  })

  it('reserves the caption clearance from the rail width alone', () => {
    // `--glass-rail` is the slot's `width`, and everything here is `border-box`,
    // so the rail's own padding is already inside it. Shifting the caption by
    // anything more — the width plus a gutter, say — would eat into 模拟行程进度
    // for no reason; by anything less would put it under the panel.
    expect(stylesheet).toContain('* { box-sizing: border-box; }')
    const caption = overlayRules.find((rule) => rule.selector.includes('.ui-route-map__caption'))
    expect(caption).toBeDefined()
    expect(caption?.body).toContain('right: var(--glass-rail);')
  })
})
