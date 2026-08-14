import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const uiDirectory = dirname(fileURLToPath(import.meta.url))
const stylesheet = readFileSync(resolve(uiDirectory, '..', 'style.css'), 'utf8')
const renderer = readFileSync(resolve(uiDirectory, 'UISpecRenderer.tsx'), 'utf8')

type Theme = 'light' | 'dark'

const expectedTokens: Record<Theme, Record<string, string>> = {
  light: {
    cabin: '#f1ebe3',
    surface: '#fffaf2',
    ink: '#2c2824',
    muted: '#746b61',
    rule: '#ded4c9',
    'quiet-rule': '#eee6dc',
    accent: '#a34f36',
    'accent-deep': '#843a2a',
    'accent-pale': '#f5e3d9',
    control: '#fffdf9',
    composer: '#fffaf2',
  },
  dark: {
    cabin: '#211711',
    surface: '#30251f',
    ink: '#f4ece2',
    muted: '#b9ab9d',
    rule: '#4c3a2f',
    'quiet-rule': '#352a23',
    accent: '#d9874f',
    'accent-deep': '#efad78',
    'accent-pale': '#5b3a29',
    control: '#3a2d24',
    composer: '#2b211b',
  },
}

function declarationBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...stylesheet.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
  if (matches.length === 0) throw new Error(`No declaration block for ${selector}`)
  return matches.map((match) => match[1]).join('\n')
}

function atRuleBlock(query: string): string {
  const blocks: string[] = []
  let searchFrom = 0
  while (true) {
    const start = stylesheet.indexOf(query, searchFrom)
    if (start < 0) break
    const open = stylesheet.indexOf('{', start)
    let depth = 0
    for (let index = open; index < stylesheet.length; index += 1) {
      if (stylesheet[index] === '{') depth += 1
      if (stylesheet[index] === '}') depth -= 1
      if (depth === 0) {
        blocks.push(stylesheet.slice(open + 1, index))
        searchFrom = index + 1
        break
      }
    }
  }
  if (blocks.length === 0) throw new Error(`No at-rule for ${query}`)
  return blocks.join('\n')
}

function themeBlock(theme: Theme): string {
  return declarationBlock(theme === 'dark' ? ".demo-shell[data-theme='dark']" : '.demo-shell')
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`))
  if (!match) throw new Error(`--${name} is not declared in the selected block`)
  return match[1].trim()
}

function resolveToken(block: string, name: string): string {
  const value = token(block, name)
  const reference = value.match(/^var\(--([\w-]+)\)$/)
  return reference ? resolveToken(block, reference[1]) : value
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('Warm Cabin theme tokens', () => {
  it.each(['light', 'dark'] as const)('declares the complete %s cabin palette', (theme) => {
    const block = themeBlock(theme)
    for (const [name, value] of Object.entries(expectedTokens[theme])) {
      expect(token(block, name)).toBe(value)
    }
    expect(token(block, 'route')).toMatch(/^#[0-9a-f]{6}$/i)
    expect(token(block, 'route-soft')).toMatch(/^#[0-9a-f]{6}$/i)
    expect(token(block, 'route')).not.toBe(expectedTokens[theme].accent)
  })

  it('keeps the generated UISpec renderer aligned with both cabin palettes', () => {
    for (const [theme, values] of Object.entries(expectedTokens)) {
      expect(renderer).toContain(`'--surface': '${values.surface}'`)
      expect(renderer).toContain(`'--cabin': '${values.cabin}'`)
      expect(renderer).toContain(`'--ink': '${values.ink}'`)
      expect(renderer).toContain(`'--muted': '${values.muted}'`)
      expect(renderer).toContain(`'--rule': '${values.rule}'`)
      expect(renderer).toContain(`'--quiet-rule': '${values['quiet-rule']}'`)
      expect(renderer).toContain(`'--accent': '${values.accent}'`)
      expect(renderer).toContain(`'--accent-deep': '${values['accent-deep']}'`)
      expect(renderer).toContain(`'--accent-pale': '${values['accent-pale']}'`)
      expect(renderer).toContain(`'--control': '${values.control}'`)
      expect(renderer).toContain(`'--composer': '${values.composer}'`)
      expect(renderer).toContain(theme === 'dark' ? "'--route': '#7fa9d9'" : "'--route': '#285f9e'")
    }
  })
})

describe('Warm Cabin action contrast', () => {
  it.each(['light', 'dark'] as const)('keeps normal and hover actions readable in %s mode', (theme) => {
    const block = themeBlock(theme)
    const ink = resolveToken(block, 'action-primary-ink')
    expect(resolveToken(block, 'action-primary')).toBe(resolveToken(block, 'accent'))
    expect(resolveToken(block, 'action-primary-hover')).toBe(resolveToken(block, 'accent-deep'))
    expect(contrastRatio(ink, resolveToken(block, 'action-primary'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(ink, resolveToken(block, 'action-primary-hover'))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(['light', 'dark'] as const)('keeps disabled actions readable in %s mode', (theme) => {
    const block = themeBlock(theme)
    const disabled = declarationBlock('.demo-controls-panel__advance:disabled')
    expect(disabled).toContain('background: var(--control-off);')
    expect(disabled).toMatch(/color:\s*var\(--muted\)(?:\s*!important)?;/)
    expect(contrastRatio(resolveToken(block, 'muted'), resolveToken(block, 'control-off')))
      .toBeGreaterThanOrEqual(4.5)
  })
})

describe('Warm Cabin surface wiring', () => {
  it('keeps a closed cockpit tool window out of layout and hit testing', () => {
    expect(stylesheet).toMatch(/\.cockpit-tool-window\[hidden\]\s*\{[^}]*display:\s*none/)
  })

  it('docks the tool window at the shared 720px cockpit breakpoint', () => {
    const compactCockpit = atRuleBlock('@media (max-width: 720px)')
    expect(compactCockpit).toMatch(/\.cockpit-tool-window\s*\{[^}]*position:\s*fixed/)
  })

  it('keeps voice fixture playback compact on phone widths', () => {
    const phone = atRuleBlock('@media (max-width: 680px)')
    expect(phone).not.toMatch(/\.demo-controls-panel__fixtures > div[^{]*\{[^}]*grid-template-columns:\s*1fr/)
  })

  it('uses theme-owned surfaces for every cockpit layer', () => {
    for (const selector of [
      '.cockpit-status-bar',
      '.cockpit-primary-panel',
      '.navigation-hud',
      '.cockpit-window',
      '.cockpit-workspace__entry .header-actions',
      '.cockpit-tool-window',
    ]) {
      const block = declarationBlock(selector)
      expect(block).toMatch(/background(?:-color)?:[^;]*var\(--(?:surface|control|composer|glass-base|panel)/)
      expect(block).not.toMatch(/background(?:-color)?:[^;]*#(?:0c1015|141a22|ffffff)\b/i)
    }
  })

  it('keeps route graphics blue and action graphics terracotta', () => {
    expect(stylesheet).toMatch(/--route:\s*#[0-9a-f]{6};/i)
    expect(stylesheet).toMatch(/--route-soft:\s*#[0-9a-f]{6};/i)
    expect(stylesheet).toMatch(/\.persistent-map-layer__route\s*\{[^}]*stroke:\s*var\(--route\)/)
    expect(stylesheet).toMatch(/\.ui-route-sketch__line\s*\{[^}]*stroke:\s*var\(--route\)/)
    expect(stylesheet).toMatch(/\.ui-route-map__line\s*\{[^}]*stroke:\s*var\(--route\)/)
    expect(stylesheet).toMatch(/\.wake-lamp--follow-up,[\s\S]*background:\s*var\(--route-soft\)/)
    expect(stylesheet).toMatch(/\.journey-rail__stage\[data-state='current'\]\s*\{[^}]*border-top-color:\s*var\(--accent\)/)
    expect(stylesheet).not.toMatch(/\.journey-rail__stage\[data-state='current'\][^{]*\{[^}]*var\(--blue\)/)
  })
})
