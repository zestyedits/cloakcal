import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from '@playwright/test'
import { markSvg } from '../apps/web/src/components/cloak-mark.js'

/**
 * Rasterises every brand asset from the one SVG in `cloak-mark.ts`.
 *
 * Run with `pnpm brand:assets`. The output is COMMITTED — this is not a build step, and
 * nothing in CI or on Vercel runs it. Committing the pixels means the icons are identical
 * everywhere, reviewable in a diff, and independent of whatever Chromium version happens to
 * be installed. Re-run it only when the mark changes.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE STATIC FILES AND NOT `next/og` ROUTES
 * ---------------------------------------------------------------------------
 *
 * Next can generate them at request time from `app/opengraph-image.tsx`, and that was the
 * obvious design. It is also a trap here.
 *
 * A generated metadata route serves at a path with NO FILE EXTENSION — `/opengraph-image`,
 * `/icon` — and `middleware.ts` excludes static assets by extension. So an unauthenticated
 * request for the social card would be redirected to `/sign-in`. Slack and Googlebot are
 * never signed in, which means the card would render empty for exactly the audience it
 * exists for.
 *
 * Worse, nothing here would catch it: `pnpm dev` and the Playwright suite both run with
 * NEXT_PUBLIC_CLOAKCAL_DEV_UNLOCK=1, which takes the middleware's early-return branch. The
 * bug would be invisible in every environment we test in and present in the only one that
 * matters.
 *
 * Static files keep their extensions, so `/opengraph-image.png` and `/icon.svg` fall through
 * the exclusions that already exist. The middleware test pins that.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = join(HERE, '..', 'apps', 'web', 'src', 'app')
const PUBLIC_ICONS = join(HERE, '..', 'apps', 'web', 'public', 'icons')
const FONT = join(APP, 'fonts', 'InterVariable.woff2')

const DEEP_NAVY = '#0b0d14'

/** Rasterise an SVG string at an exact pixel size. */
async function rasterise(
  browser: Browser,
  svg: string,
  size: { width: number; height: number },
  /** Icons that will sit on an unknown background keep their alpha. Tiles are opaque. */
  transparent: boolean,
): Promise<Buffer> {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 })
  await page.setContent(
    `<!doctype html><style>
       html,body{margin:0;padding:0;width:${size.width}px;height:${size.height}px;overflow:hidden}
       svg{display:block;width:${size.width}px;height:${size.height}px}
     </style>${svg}`,
  )
  const png = await page.screenshot({ omitBackground: transparent })
  await page.close()
  return png
}

/**
 * Wraps PNGs in an ICO container.
 *
 * Still required in 2026: Safari only shipped SVG favicon support in 26.0, so `icon.svg`
 * alone leaves every older Safari with a blank tab. PNG-in-ICO (rather than BMP) is
 * understood by everything that matters and keeps the alpha channel.
 *
 * The format is a 6-byte header, then one 16-byte directory entry per image, then the image
 * data. A dimension of 256 or more is encoded as 0 — which is why the byte is `size & 0xff`
 * rather than `size`, though nothing here is that large.
 */
function ico(images: ReadonlyArray<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)

  let offset = 6 + images.length * 16
  const entries: Buffer[] = []
  for (const { size, png } of images) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size & 0xff, 0) // width
    e.writeUInt8(size & 0xff, 1) // height
    e.writeUInt8(0, 2) // palette size, 0 = no palette
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // colour planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

/**
 * The social card: 1200x630, the lockup on deep navy.
 *
 * Built as HTML rather than by scaling the mark, because it needs real type — and the font
 * is embedded from the committed woff2 as a data URI. Pointing at a URL would make the
 * output depend on the network, and a card rendered in a fallback font is worse than no
 * card, because it looks deliberate.
 */
function ogHtml(fontBase64: string): string {
  return `<!doctype html><meta charset="utf-8"><style>
    @font-face{font-family:Inter;src:url(data:font/woff2;base64,${fontBase64}) format('woff2');
      font-weight:100 900;font-display:block}
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:1200px;height:630px;background:${DEEP_NAVY};color:#F5F6FA;
      font-family:Inter,sans-serif;display:flex;flex-direction:column;justify-content:center;
      padding:0 96px;position:relative;overflow:hidden}
    /* One soft indigo bloom, bottom-right. The board leads with deep calm backgrounds and
       soft glows; this is the whole decoration budget. */
    .bloom{position:absolute;right:-160px;bottom:-220px;width:680px;height:680px;border-radius:50%;
      background:radial-gradient(circle,rgba(109,92,255,.30) 0%,rgba(109,92,255,0) 70%)}
    .row{display:flex;align-items:center;gap:24px;margin-bottom:44px}
    .mark{width:88px;height:88px;display:block}
    .mark svg{width:88px;height:88px;display:block}
    .word{font-size:60px;font-weight:600;letter-spacing:-.02em;line-height:1}
    .accent{color:#B8B0FF}
    h1{font-size:76px;font-weight:700;letter-spacing:-.03em;line-height:1.08;max-width:15ch}
    p{margin-top:28px;font-size:28px;font-weight:500;color:#9AA0B4;letter-spacing:.02em}
  </style>
  <div class="bloom"></div>
  <div class="row">
    <span class="mark">${markSvg('full', 'og')}</span>
    <span class="word">Cloak<span class="accent">Cal</span></span>
  </div>
  <h1>Not everything is for everyone.</h1>
  <p>Your time. Your business.</p>`
}

async function main(): Promise<void> {
  const browser = await chromium.launch()
  await mkdir(PUBLIC_ICONS, { recursive: true })

  const written: string[] = []
  const put = async (path: string, data: Buffer | string) => {
    await writeFile(path, data)
    written.push(path.replace(join(HERE, '..') + '/', ''))
  }

  // 1. The SVG favicon. Written straight out, no rasterisation — this is the source.
  await put(join(APP, 'icon.svg'), markSvg('favicon', 'f'))

  // 2. favicon.ico. 48 is included because Windows taskbar pinning uses it.
  const icoSizes = [16, 32, 48]
  const icoPngs = await Promise.all(
    icoSizes.map(async (size) => ({
      size,
      // The 16px drawing up to 32; above that the full nine-dot geometry has room to read.
      png: await rasterise(
        browser,
        markSvg(size <= 32 ? 'favicon' : 'full', `i${size}`),
        { width: size, height: size },
        true,
      ),
    })),
  )
  await put(join(APP, 'favicon.ico'), ico(icoPngs))

  // 3. Apple touch icon. Opaque and full-bleed: iOS composites onto white and applies its
  //    own corner radius, so a transparent or pre-rounded asset gets an ugly light fringe.
  await put(
    join(APP, 'apple-icon.png'),
    await rasterise(browser, markSvg('tile', 'a'), { width: 180, height: 180 }, false),
  )

  // 4. PWA / Capacitor. The `any` pair plus a separate maskable, whose mark is shrunk to
  //    survive Android cropping the tile to a circle.
  for (const size of [192, 512]) {
    await put(
      join(PUBLIC_ICONS, `icon-${size}.png`),
      await rasterise(browser, markSvg('tile', `t${size}`), { width: size, height: size }, false),
    )
  }
  await put(
    join(PUBLIC_ICONS, 'icon-512-maskable.png'),
    await rasterise(browser, markSvg('tile-maskable', 'm'), { width: 512, height: 512 }, false),
  )

  // 5. The social card.
  const { readFile } = await import('node:fs/promises')
  const fontBase64 = (await readFile(FONT)).toString('base64')
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  await page.setContent(ogHtml(fontBase64))
  await page.evaluate(() => document.fonts.ready)
  await put(join(APP, 'opengraph-image.png'), await page.screenshot())
  await page.close()

  await browser.close()
  console.log('wrote:\n  ' + written.join('\n  '))
}

await main()
