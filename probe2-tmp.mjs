import { chromium } from '@playwright/test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const axePath = require.resolve('axe-core/axe.min.js', { paths: ['./node_modules/.pnpm/axe-core@4.12.1/node_modules'] })
import { readFileSync } from 'node:fs'
const AXE = readFileSync(axePath, 'utf8')

const BASE = 'http://127.0.0.1:3187'
const STATES = ['none', 'lapsed', 'granted', 'active', 'cancelling', 'past_due', 'unreadable']
const browser = await chromium.launch()

async function settle(page) {
  await page.evaluate(async () => {
    const running = document.getAnimations()
      .filter((a) => (a.effect?.getComputedTiming().iterations ?? 1) !== Infinity)
      .map((a) => a.finished.then(() => undefined).catch(() => undefined))
    await Promise.race([Promise.all(running).then(() => undefined), new Promise((r) => setTimeout(r, 2000))])
  })
}

async function scan(page) {
  await settle(page)
  await page.addScriptTag({ content: AXE })
  const res = await page.evaluate(async () =>
    await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }),
  )
  return res.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target}  ${v.nodes[0]?.failureSummary?.split('\n').slice(0,2).join(' | ')}`)
}

let page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

console.log('=== axe over the FIVE states the spec never scans, both themes ===')
for (const s of STATES) {
  for (const theme of ['dark', 'light']) {
    await page.close(); page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`${BASE}/settings/plan?billing=${s}`)
    await page.waitForSelector(`[data-billing="${s}"]`)
    if (theme === 'light') {
      await page.getByRole('button', { name: 'Switch to light mode' }).click()
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    }
    const v = await scan(page)
    console.log(` ${s}/${theme}: ${v.length === 0 ? 'clean' : JSON.stringify(v, null, 1)}`)
  }
}

console.log('\n=== the preview NOTICE (role=status) after pressing a button, light ===')
await page.close(); page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(`${BASE}/settings/plan?billing=none`)
await page.waitForSelector('[data-billing="none"]')
await page.getByRole('button', { name: 'Switch to light mode' }).click()
await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
await page.getByRole('button', { name: 'Continue to Stripe' }).click()
await page.waitForSelector('text=Preview only. Nothing was sent.')
console.log(' notice visible; axe:', JSON.stringify(await scan(page)))
console.log(' notice colours:', JSON.stringify(await page.evaluate(() => {
  const p = [...document.querySelectorAll('p[role="status"]')][0]
  return p ? { text: p.textContent, color: getComputedStyle(p).color, bg: getComputedStyle(p.parentElement).backgroundColor } : null
})))

console.log('\n=== the cancel confirmation in the DARK theme (spec only scans it in light) ===')
await page.close(); page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(`${BASE}/settings/plan?billing=active`)
await page.waitForSelector('[data-billing="active"]')
await page.getByRole('button', { name: 'Cancel Pro' }).click()
await page.waitForSelector('[role="group"]')
console.log(' axe:', JSON.stringify(await scan(page)))

console.log('\n=== does the confirmation move focus? SC 2.4.3 / 2.4.11 ===')
console.log(JSON.stringify(await page.evaluate(() => {
  const a = document.activeElement
  const g = document.querySelector('[role="group"]')
  return {
    active: a ? `${a.tagName}.${a.className}`.slice(0, 60) : null,
    activeText: a?.textContent?.trim().slice(0, 30) ?? null,
    activeStillInDom: a ? document.contains(a) : null,
    groupContainsActive: g && a ? g.contains(a) : null,
    groupHasTabindex: g?.getAttribute('tabindex'),
  }
})))

console.log('\n=== invoice link: does it ever render? ===')
console.log(JSON.stringify(await page.evaluate(() => {
  const links = [...document.querySelectorAll('a')].filter((a) => a.href.includes('stripe'))
  return { count: links.length }
})))

console.log('\n=== busy/disabled cadence card: is it distinguishable? ===')
await page.goto(`${BASE}/settings/plan?billing=none`)
await page.waitForSelector('[data-billing="none"]')
console.log(JSON.stringify(await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input[name="billing-cadence"]')]
  return inputs.map((i) => ({ disabled: i.disabled, ariaDisabled: i.getAttribute('aria-disabled') }))
})))

await browser.close()
