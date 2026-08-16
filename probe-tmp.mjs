import { chromium } from '@playwright/test'

const BASE = 'http://127.0.0.1:3187'
const out = (...a) => console.log(...a)

function lum(hex) {
  const v = hex.replace('#', '')
  const ch = (o) => {
    const r = parseInt(v.slice(o, o + 2), 16) / 255
    return r <= 0.03928 ? r / 12.92 : ((r + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4)
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)]
  const [hi, lo] = x > y ? [x, y] : [y, x]
  return ((hi + 0.05) / (lo + 0.05)).toFixed(2)
}
function toHex(rgb) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(rgb)
  if (!m) return null
  return { hex: '#' + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join(''), a: m[4] === undefined ? 1 : Number(m[4]) }
}

const browser = await chromium.launch()

async function themed(page, theme) {
  if (theme === 'light') {
    await page.getByRole('button', { name: 'Switch to light mode' }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  }
}

// ---------- 1. cadence radio keyboard operability ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${BASE}/settings/plan?billing=none`)
  await page.waitForSelector('[data-billing="none"]')

  // Tab until focus lands on a radio.
  let tabs = 0
  let info = null
  while (tabs < 60) {
    await page.keyboard.press('Tab')
    tabs += 1
    info = await page.evaluate(() => {
      const el = document.activeElement
      if (!el) return null
      return { tag: el.tagName, type: el.type ?? null, value: el.value ?? null, name: el.name ?? null }
    })
    if (info && info.tag === 'INPUT' && info.type === 'radio') break
  }
  out('\n=== 1. cadence radios: keyboard ===')
  out('tabs to reach a radio:', tabs, JSON.stringify(info))

  const before = await page.evaluate(() =>
    [...document.querySelectorAll('input[name="billing-cadence"]')].map((i) => [i.value, i.checked]),
  )
  await page.keyboard.press('ArrowUp')
  const after = await page.evaluate(() =>
    [...document.querySelectorAll('input[name="billing-cadence"]')].map((i) => [i.value, i.checked]),
  )
  out('before ArrowUp:', JSON.stringify(before), ' after:', JSON.stringify(after))

  const focusRing = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('label')].filter((l) => l.querySelector('input[name="billing-cadence"]'))
    return cards.map((c) => {
      const cs = getComputedStyle(c)
      const input = c.querySelector('input')
      return {
        value: input.value,
        checked: input.checked,
        matchesFocusVisibleHas: c.matches(':has(input:focus-visible)'),
        outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`,
        border: cs.borderTopColor,
        bg: cs.backgroundColor,
        boxShadow: cs.boxShadow,
        w: Math.round(c.getBoundingClientRect().width),
        h: Math.round(c.getBoundingClientRect().height),
      }
    })
  })
  out('cards after keyboard focus:', JSON.stringify(focusRing, null, 1))

  const bandBg = await page.evaluate(() => {
    let el = document.querySelector('[data-billing]')
    while (el) {
      const bg = getComputedStyle(el).backgroundColor
      if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return { sel: el.className, bg }
      el = el.parentElement
    }
    return null
  })
  out('band effective ground:', JSON.stringify(bandBg))

  // Contrast numbers we care about, dark theme
  const checked = focusRing.find((c) => c.checked)
  out('checked card border vs its own bg:', toHex(checked.border)?.hex, toHex(checked.bg)?.hex, ratio(toHex(checked.border).hex, toHex(checked.bg).hex))
  out('checked card border vs band ground:', ratio(toHex(checked.border).hex, toHex(bandBg.bg).hex))
  const unchecked = focusRing.find((c) => !c.checked)
  out('checked bg vs unchecked bg:', toHex(checked.bg)?.hex, toHex(unchecked.bg)?.hex, ratio(toHex(checked.bg).hex, toHex(unchecked.bg).hex))
  out('focus outline colour vs band ground:', toHex(checked.outline.split(' ').slice(2).join(' '))?.hex)

  // light theme
  await themed(page, 'light')
  const lightNums = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('label')].filter((l) => l.querySelector('input[name="billing-cadence"]'))
    const band = document.querySelector('[data-billing]')
    let g = band, bg = null
    while (g) { const b = getComputedStyle(g).backgroundColor; if (b !== 'rgba(0, 0, 0, 0)') { bg = b; break } g = g.parentElement }
    const testNote = document.querySelector('[data-billing] p')
    return {
      ground: bg,
      cards: cards.map((c) => {
        const cs = getComputedStyle(c)
        return { checked: c.querySelector('input').checked, border: cs.borderTopColor, bg: cs.backgroundColor, outline: cs.outlineColor }
      }),
    }
  })
  out('\n-- light theme --')
  out(JSON.stringify(lightNums, null, 1))
  const lc = lightNums.cards.find((c) => c.checked)
  const luc = lightNums.cards.find((c) => !c.checked)
  out('light checked border vs its bg:', ratio(toHex(lc.border).hex, toHex(lc.bg).hex))
  out('light checked border vs band ground:', ratio(toHex(lc.border).hex, toHex(lightNums.ground).hex))
  out('light checked bg vs unchecked bg:', ratio(toHex(lc.bg).hex, toHex(luc.bg).hex))
  out('light focus ring colour:', toHex(lc.outline)?.hex, 'vs band ground:', ratio(toHex(lc.outline).hex, toHex(lightNums.ground).hex), 'vs card sunken:', ratio(toHex(lc.outline).hex, toHex(luc.bg).hex))
  await page.close()
}

// ---------- 2. test-note border on sunken, both themes ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  for (const theme of ['dark', 'light']) {
    await page.goto(`${BASE}/settings/plan?billing=active`)
    await page.waitForSelector('[data-billing="active"]')
    await themed(page, theme)
    const r = await page.evaluate(() => {
      const notes = [...document.querySelectorAll('[data-billing] p')].filter((p) => getComputedStyle(p).borderLeftWidth !== '0px')
      return notes.map((n) => ({ text: n.textContent.slice(0, 34), border: getComputedStyle(n).borderLeftColor, bg: getComputedStyle(n).backgroundColor }))
    })
    out(`\n=== 2. bordered notices (${theme}) ===`)
    for (const n of r) out(` ${n.text} | border ${toHex(n.border)?.hex} on ${toHex(n.bg)?.hex} = ${ratio(toHex(n.border).hex, toHex(n.bg).hex)}:1`)
  }
  await page.close()
}

// ---------- 3. forced colors ----------
{
  const ctx = await browser.newContext({ forcedColors: 'active', viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/settings/plan?billing=none`)
  await page.waitForSelector('[data-billing="none"]')
  const r = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('label')].filter((l) => l.querySelector('input[name="billing-cadence"]'))
    return cards.map((c) => {
      const cs = getComputedStyle(c)
      const i = c.querySelector('input')
      const ics = getComputedStyle(i)
      return {
        checked: i.checked,
        border: cs.borderTopColor,
        bg: cs.backgroundColor,
        shadow: cs.boxShadow,
        inputOpacity: ics.opacity,
        inputVisibility: ics.visibility,
        inputAppearance: ics.appearance,
        inputForcedAdjust: ics.forcedColorAdjust,
      }
    })
  })
  out('\n=== 3. forced-colors: is the checked state visible? ===')
  out(JSON.stringify(r, null, 1))
  await ctx.close()
}

// ---------- 4. 44px sweep, WIDTH as well as height ----------
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const states = ['none', 'lapsed', 'granted', 'active', 'cancelling', 'past_due', 'unreadable']
  out('\n=== 4. target size, width AND height, at 390px ===')
  for (const s of states) {
    await page.goto(`${BASE}/settings/plan?billing=${s}`)
    await page.waitForSelector(`[data-billing="${s}"]`)
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('button, a[href], input, label, [role="button"]')]
        .map((el) => {
          const cs = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return { label: (el.textContent ?? '').trim().slice(0, 26) || el.tagName, w: Math.round(r.width), h: Math.round(r.height), pe: cs.pointerEvents }
        })
        .filter((m) => m.pe !== 'none' && m.h > 0 && (m.w < 44 || m.h < 44)),
    )
    out(` ${s}:`, JSON.stringify(small))
  }
  await page.close()
}

// ---------- 5. the settings rail at 390px ----------
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  out('\n=== 5. settings rail at 390px ===')
  for (const url of ['/settings', '/settings/plan', '/settings/security']) {
    await page.goto(BASE + url)
    await page.waitForSelector('nav[aria-label="Settings sections"]')
    await page.waitForTimeout(600)
    const r = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Settings sections"]')
      const links = [...nav.querySelectorAll('a')]
      const nr = nav.getBoundingClientRect()
      let overlaps = 0
      for (let i = 1; i < links.length; i += 1) {
        if (links[i].getBoundingClientRect().left < links[i - 1].getBoundingClientRect().right - 0.5) overlaps += 1
      }
      const clipped = links.filter((a) => a.scrollWidth > a.clientWidth + 1).map((a) => a.textContent.trim())
      const active = nav.querySelector('[aria-current]')
      const ar = active?.getBoundingClientRect() ?? null
      const marker = nav.querySelector('span[aria-hidden="true"]')
      return {
        navScroll: nav.scrollWidth,
        navClient: nav.clientWidth,
        navScrollLeft: nav.scrollLeft,
        overlaps,
        clipped,
        activeLabel: active?.textContent.trim() ?? null,
        activeInView: ar ? ar.left >= nr.left - 1 && ar.right <= nr.right + 1 : null,
        activeLeft: ar ? Math.round(ar.left) : null,
        navRight: Math.round(nr.right),
        markerW: marker ? Math.round(marker.getBoundingClientRect().width) : null,
        docScroll: document.documentElement.scrollWidth,
        docClient: document.documentElement.clientWidth,
      }
    })
    out(` ${url}:`, JSON.stringify(r))
  }
  await page.close()
}

// ---------- 6. desktop rail unchanged? ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${BASE}/settings/plan`)
  await page.waitForSelector('nav[aria-label="Settings sections"]')
  await page.waitForTimeout(600)
  const r = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Settings sections"]')
    const links = [...nav.querySelectorAll('a')]
    const marker = nav.querySelector('span[aria-hidden="true"]')
    const active = nav.querySelector('[aria-current]')
    return {
      navW: Math.round(nav.getBoundingClientRect().width),
      navScroll: nav.scrollWidth,
      linkWidths: links.map((a) => Math.round(a.getBoundingClientRect().width)),
      overflowingLinks: links.filter((a) => a.getBoundingClientRect().right > nav.getBoundingClientRect().right + 1).map((a) => a.textContent.trim()),
      markerRect: marker ? { w: Math.round(marker.getBoundingClientRect().width), h: Math.round(marker.getBoundingClientRect().height), x: Math.round(marker.getBoundingClientRect().x) } : null,
      activeRect: active ? { w: Math.round(active.getBoundingClientRect().width), x: Math.round(active.getBoundingClientRect().x) } : null,
    }
  })
  out('\n=== 6. desktop rail ===')
  out(JSON.stringify(r, null, 1))
  await page.close()
}

await browser.close()
