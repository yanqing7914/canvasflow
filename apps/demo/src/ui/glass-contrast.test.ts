import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The floating navigation panel's readability, measured from the stylesheet.
 *
 * The panel is translucent white over a live basemap, so nothing in the app can
 * know what colour sits behind any given pixel of it — a tunnel, a park, a dark
 * satellite tile. What the stylesheet can guarantee is the worst case: over a
 * black backdrop, white at alpha `a` composites to the grey `a x 255`, and every
 * lighter backdrop only pushes the panel lighter and the contrast higher. So the
 * alpha alone sets the floor, and these tests hold that floor at WCAG AA 4.5:1
 * by reading the same three declarations the panel renders from.
 *
 * The point is that lowering `--glass-fill` for a prettier effect, or reverting
 * the in-panel label colour to `--muted`, fails here instead of shipping a panel
 * whose small type disappears over dark map features.
 */
/* Resolved from this file rather than the working directory, so the test reads
   the stylesheet it is paired with wherever vitest is launched from. Built up
   from `dirname` because Vite rewrites `new URL(..., import.meta.url)` into an
   asset reference, which is no longer a path on disk. */
const stylesheet = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'),
  'utf8',
)

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

/** The grey the panel resolves to when the map behind it is black. */
function worstCaseBackdrop(alpha: number): number {
  return relativeLuminance(
    `#${Math.round(alpha * 255)
      .toString(16)
      .padStart(2, '0')
      .repeat(3)}`,
  )
}

function token(name: string): string {
  const match = stylesheet.match(new RegExp(`--${name}:\\s*([^;]+);`))
  if (!match) throw new Error(`--${name} is not declared in style.css`)
  return match[1].trim()
}

describe('floating navigation panel contrast', () => {
  const fill = Number.parseFloat(token('glass-fill'))
  const backdrop = worstCaseBackdrop(fill)

  it('declares a glass alpha the panel actually renders from', () => {
    expect(fill).toBeGreaterThan(0)
    expect(fill).toBeLessThanOrEqual(1)
    // A token nothing reads would let the assertions below pass while the panel
    // is painted from some other, unmeasured value.
    expect(stylesheet).toContain('background: rgb(255 255 255 / var(--glass-fill));')
  })

  it.each([
    ['--glass-ink', 'glass-ink'],
    ['--glass-label', 'glass-label'],
  ])('holds %s above AA over the darkest backdrop the map can show', (_label, name) => {
    const colour = token(name)
    expect(colour).toMatch(/^#[0-9a-f]{6}$/i)
    expect(contrastRatio(colour, backdrop)).toBeGreaterThanOrEqual(4.5)
  })

  it('never lets a fallback be more transparent than the measured panel', () => {
    // The `@supports` and reduced-transparency branches replace the background
    // outright, so they need the same floor. Anything opaque clears it trivially;
    // anything translucent must be at least as opaque as `--glass-fill`.
    const alphas = [...stylesheet.matchAll(/background: rgb\(255 255 255 \/ ([\d.]+)\);/g)].map(
      (match) => Number.parseFloat(match[1]),
    )
    expect(alphas.length).toBeGreaterThan(0)
    for (const alpha of alphas) expect(alpha).toBeGreaterThanOrEqual(fill)
  })
})
