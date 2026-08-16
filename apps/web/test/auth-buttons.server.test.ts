import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The auth screens use ONE button system, and the fields are filled.
 *
 * `auth.module.css` used to declare `.submit` and `.secondary` — a second button system with
 * its own radius, its own flat accent instead of the deep gradient, its own hover, and
 * `cursor: progress` on every disabled state rather than only on an in-flight one. Sixteen
 * call sites across seven components wore them.
 *
 * That is the exact duplication CLAUDE.md blames for shipping a 2.99:1 Delete label TWICE:
 * every re-declaration of a variant is one more place the contrast rules have to be
 * remembered, and the re-declaration is always the copy that forgets. `ui/Button` sits on
 * the tokens CONTRAST_PAIRS pins; a hand-rolled `.submit` sits on nothing.
 *
 * A comment saying "use ui/Button" would not have stopped it, because a comment did not stop
 * it the first time. This is the guard.
 */

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const authCss = readFileSync(root('../src/components/auth.module.css'), 'utf8')

/** Declarations only, with comments stripped — several of them discuss the dead classes. */
const rules = authCss.replace(/\/\*[\s\S]*?\*\//gu, '')

describe('the auth surfaces', () => {
  it('declares no button variants of its own', () => {
    expect(rules).not.toMatch(/^\.submit\b/mu)
    expect(rules).not.toMatch(/^\.secondary\b/mu)
  })

  it('has no component still reaching for them', () => {
    const dir = root('../src/components')
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.tsx'))
      .filter((file) => /styles\.(submit|secondary)\b/u.test(readFileSync(`${dir}/${file}`, 'utf8')))
    expect(offenders, 'these still use the retired auth button classes').toEqual([])
  })

  it('fills its fields and holds the border that identifies them', () => {
    // Scoped to the `.input` block, not the whole stylesheet: --surface-raised is still the
    // correct ground for `.phraseGrid`, `.lockCard` and `.keyRow`, which are cards rather
    // than fields. Asserting across the file failed on exactly those three, which is the
    // test being wrong rather than the stylesheet.
    const field = /^\.input\s*\{([^}]*)\}/mu.exec(rules)?.[1]
    expect(field, 'the .input rule moved or was renamed').toBeDefined()

    // The fill is what says "type here"; the border is the WCAG 1.4.11 boundary and is
    // pinned at 3:1 in CONTRAST_PAIRS. What was there before — a --border-default hairline
    // over --surface-raised — measured 1.6:1, and in the light theme --surface-raised is
    // #ffffff, so the field was white on white with a hairline nobody could see.
    expect(field).toMatch(/background:\s*var\(--field-bg\)/u)
    expect(field).toMatch(/border:\s*1px solid var\(--field-border\)/u)
    expect(field).not.toMatch(/--surface-raised/u)
  })

  it('uses the control radius rather than the card radius', () => {
    // --radius-md is what every rectangle on the page shared before, which is why nothing
    // had a shape of its own. Cards keep --radius-lg/xl; controls step down.
    expect(rules).toMatch(/border-radius:\s*var\(--radius-control\)/u)
  })

  it('never rounds a control into a pill', () => {
    // The standing rule in tokens.css: --radius-full is for genuine circles only.
    const pills = [...rules.matchAll(/\.([\w-]+)\s*\{[^}]*--radius-full[^}]*\}/gu)].map((m) => m[1])
    expect(pills.filter((name) => name !== 'pulse')).toEqual([])
  })
})
