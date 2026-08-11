import type { MetadataRoute } from 'next'

/**
 * Disallow everything.
 *
 * Not a placeholder — a decision. Every route this app serves is behind auth, and `/` IS the
 * calendar. There is no marketing page yet, so the only thing a crawler could index is the
 * shape of the auth surface. For a product whose pitch is "not everything is for everyone",
 * letting that be the default would be a poor look as well as pointless.
 *
 * This does NOT stop the social card working. Slack, iMessage and the like fetch
 * `/opengraph-image.png` as an unfurl rather than as a crawl, and that file is a brand asset
 * with nothing private in it.
 *
 * Revisit when a public marketing page or a shared booking link exists — those want indexing,
 * and this file will need to allow them specifically rather than being deleted wholesale.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: '/' }],
  }
}
