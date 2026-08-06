import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The floating navigation panel's readability, measured from the stylesheet.
 *
 * The panel is translucent over a live basemap, so nothing in the app can know
 * what colour sits behind any given pixel of it — a tunnel, a park, a dark
 * satellite tile. What the stylesheet can guarantee is the worst case, and the
 * worst case is a different colour in each theme:
 *
 * - Light glass is white. Over a black backdrop it composites to the grey
 *   `alpha x 255`, and every lighter backdrop only pushes it lighter.
 * - Dark glass inverts the argument. Its near white text is at risk when the
 *   panel composites *bright*, which happens over a white backdrop, so that is
 *   the case measured here.
 *
 * Either way the alpha alone sets the floor and the blur contributes nothing to
 * it. The floor is WCAG AAA 7:1 rather than the AA 4.5:1 minimum: a driver reads
 * this at a glance, at arm's length, over a basemap that is moving, and 4.5:1 is
 * a pass mark rather than a comfortable one.
 *
 * The point is that lowering a `--glass-fill` for a prettier effect, or
 * reverting an in-panel label to `--muted`, fails here instead of shipping a
 * panel whose small type disappears into the map.
 */
/* Resolved from this file rather than the working directory, so the test reads
   the stylesheet it is paired with wherever vitest is launched from. Built up
   from `dirname` because Vite rewrites `new URL(..., import.meta.url)` into an
   asset reference, which is no longer a path on disk. */
const stylesheet = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'),
  'utf8',
)

const AAA = 7
const AA = 4.5
/** The alpha the fold control repaints the panel's own base at. */
const FOLD_FILL = 0.5

/** WCAG 2.x relative luminance of an `#rrggbb` colour. */
function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(foreground: string, backgroundLuminance: number): number {
  const ink = relativeLuminance(foreground)
  const [lighter, darker] =
    backgroundLuminance > ink ? [backgroundLuminance, ink] : [ink, backgroundLuminance]
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * What the panel resolves to over the backdrop that hurts it most.
 *
 * `base` is the panel's own colour as the `r g b` triple the stylesheet
 * declares, `over` is the backdrop, and the composite is the ordinary
 * source-over blend: `alpha x base + (1 - alpha) x backdrop`. Passing the
 * backdrop in rather than assuming black is what makes this work for dark glass,
 * where black is the *best* case and white is the one that has to be survived.
 */
function worstCaseBackdrop(base: number[], alpha: number, over: 'black' | 'white'): number {
  const backdrop = over === 'white' ? 255 : 0
  const composite = base.map((channel) =>
    Math.round(alpha * channel + (1 - alpha) * backdrop)
      .toString(16)
      .padStart(2, '0'),
  )
  return relativeLuminance(`#${composite.join('')}`)
}

/** The declaration block of one `[data-theme]` token set. */
function themeBlock(theme: 'light' | 'dark'): string {
  const match = stylesheet.match(
    new RegExp(`\\.ui-spec-renderer\\[data-theme='${theme}'\\]\\s*\\{([^}]*)\\}`),
  )
  if (!match) throw new Error(`No token block for the ${theme} theme in style.css`)
  return match[1]
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`))
  if (!match) throw new Error(`--${name} is not declared in the theme block`)
  return match[1].trim()
}

function contrastBetween(foreground: string, background: string): number {
  return contrastRatio(foreground, relativeLuminance(background))
}

const themes = [
  { name: 'light' as const, over: 'black' as const },
  { name: 'dark' as const, over: 'white' as const },
]

describe('floating navigation panel contrast', () => {
  it('renders the panel and both of its fallbacks from the declared tokens', () => {
    // Tokens nothing reads would let every assertion below pass while the panel
    // is painted from some other, unmeasured value.
    expect(stylesheet).toContain('background: rgb(var(--glass-base) / var(--glass-fill));')
    expect(stylesheet).toContain('background: rgb(var(--glass-base) / var(--glass-fill-solid));')
    expect(stylesheet).toContain('background: rgb(var(--glass-base));')
  })

  describe.each(themes)('$name theme', ({ name, over }) => {
    const block = themeBlock(name)
    const base = token(block, 'glass-base').split(/\s+/).map(Number)
    const fill = Number.parseFloat(token(block, 'glass-fill'))
    const backdrop = worstCaseBackdrop(base, fill, over)

    it('declares a panel colour and alpha in the form the panel renders from', () => {
      expect(base).toHaveLength(3)
      for (const channel of base) expect(channel).toBeGreaterThanOrEqual(0)
      for (const channel of base) expect(channel).toBeLessThanOrEqual(255)
      expect(fill).toBeGreaterThan(0)
      expect(fill).toBeLessThanOrEqual(1)
    })

    it.each([['--glass-ink', 'glass-ink'], ['--glass-label', 'glass-label']])(
      `holds %s above AAA over a ${over} backdrop`,
      (_label, tokenName) => {
        const colour = token(block, tokenName)
        expect(colour).toMatch(/^#[0-9a-f]{6}$/i)
        expect(contrastRatio(colour, backdrop)).toBeGreaterThanOrEqual(AAA)
      },
    )

    it('never lets the opaque fallback be more transparent than the measured panel', () => {
      // The `@supports` branch replaces the background outright, so it needs the
      // same floor; the reduced-transparency branch drops the alpha entirely and
      // clears it trivially.
      expect(Number.parseFloat(token(block, 'glass-fill-solid'))).toBeGreaterThanOrEqual(fill)
    })

    it('keeps the fold control at least as readable as the panel it sits on', () => {
      // The control paints the panel's own base again at `FOLD_FILL`, so the two
      // layers stack to `FOLD_FILL + fill x (1 - FOLD_FILL)` over the same worst
      // case. That is more opaque than the panel by construction, and more opaque
      // is more contrast in both themes — for opposite reasons, per the block
      // comment above. The point of measuring it rather than asserting it is that
      // painting the control from any other colour breaks the argument, and a
      // chevron the driver cannot find is a panel they cannot reopen.
      expect(stylesheet).toContain(`background: rgb(var(--glass-base) / ${FOLD_FILL});`)
      const stacked = FOLD_FILL + fill * (1 - FOLD_FILL)
      expect(stacked).toBeGreaterThan(fill)
      const onControl = contrastRatio(token(block, 'glass-ink'), worstCaseBackdrop(base, stacked, over))
      expect(onControl).toBeGreaterThanOrEqual(contrastRatio(token(block, 'glass-ink'), backdrop))
      // A chevron is a graphic, so 3:1 is its own floor; it clears the text floor
      // here because it is drawn in the text colour.
      expect(onControl).toBeGreaterThanOrEqual(AAA)
    })
  })
})

describe('night theme control and map contrast', () => {
  const dark = themeBlock('dark')

  it('keeps primary action text readable in normal and hover states', () => {
    const ink = token(dark, 'action-primary-ink')
    expect(contrastBetween(ink, token(dark, 'action-primary'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastBetween(ink, token(dark, 'action-primary-hover'))).toBeGreaterThanOrEqual(4.5)
  })

  it('renders the route caption from theme-owned background and ink tokens', () => {
    expect(stylesheet).toContain('rgb(var(--map-caption-base) / 0.96)')
    expect(stylesheet).toContain('rgb(var(--map-caption-base) / 0.92) 58%')
    expect(stylesheet).toContain('rgb(var(--map-caption-base) / 0.92) 64%')
    expect(stylesheet).toContain('color: var(--map-caption-ink);')
    expect(token(themeBlock('light'), 'map-caption-base')).not.toBe(token(dark, 'map-caption-base'))
  })

  it.each(themes)('keeps the route caption text above AA across its text platform in the $name theme', ({ name, over }) => {
    const block = themeBlock(name)
    const base = token(block, 'map-caption-base').split(/\s+/).map(Number)
    expect(contrastRatio(token(block, 'map-caption-ink'), worstCaseBackdrop(base, 0.92, over)))
      .toBeGreaterThanOrEqual(AA)
  })

  it('wires the declared semantic surface and state tokens into components', () => {
    for (const usage of [
      'background: var(--panel);',
      'background: var(--panel-warn);',
      'background: var(--panel-danger);',
      'background: var(--panel-fallback);',
      'color: var(--state-ink);',
      'color: var(--state-ink-positive);',
      'color: var(--state-ink-caution);',
      'background: var(--control);',
      'border: 2px solid var(--step-edge);',
    ]) expect(stylesheet).toContain(usage)
  })
})

describe('focus and locked control states', () => {
  it('uses an opaque focus token instead of a low-contrast translucent ring', () => {
    const focus = token(stylesheet, 'focus-ring')
    expect(focus).toMatch(/^#[0-9a-f]{6}$/i)
    expect(contrastBetween(focus, '#ffffff')).toBeGreaterThanOrEqual(3)
    expect(stylesheet).toContain('outline: 3px solid var(--focus-ring);')
  })

  it('keeps the selected light condition visible after the controls lock', () => {
    expect(stylesheet).toContain(".lighting-button[aria-pressed='true']:disabled")
  })
})

describe('whole-cockpit night theme', () => {
  it('moves the Agent theme onto the shell that owns the cockpit surfaces', () => {
    expect(stylesheet).toContain(".demo-shell[data-theme='dark']")
    expect(stylesheet).toContain('--cabin: #0c1015;')
    expect(stylesheet).toContain('--surface: #141a22;')
    expect(stylesheet).toContain('background: var(--surface);')
  })

  it('keeps the engineering drawer on its own light control tokens', () => {
    const drawer = stylesheet.match(/\.event-console\s*\{([^}]*)\}/)?.[1]
    expect(drawer).toContain('--ink: #102033;')
    expect(drawer).toContain('--control: #ffffff;')
  })
})
