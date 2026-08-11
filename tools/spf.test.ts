import { describe, expect, it } from 'vitest'
import { isSpfRecord, mergeSpf } from './spf.js'

/**
 * The failure this guards against is silent. A domain with two SPF records, or with a
 * merged record that dropped a mechanism, keeps sending mail — it just stops being
 * authenticated, and lands in spam somewhere nobody is watching. So these cases are about
 * what must NOT be lost or quietly changed, not about the happy path.
 */

describe('mergeSpf', () => {
  it('merges the real case this was written for', () => {
    // Porkbun's email forwarding adds its own SPF; Resend wants amazonses. Both must
    // survive, in one record.
    expect(mergeSpf('v=spf1 include:_spf.porkbun.com ~all', 'v=spf1 include:amazonses.com ~all')).toBe(
      'v=spf1 include:_spf.porkbun.com include:amazonses.com ~all',
    )
  })

  it('keeps the existing hard-fail policy instead of relaxing it', () => {
    // -all means "reject anything not listed". Silently downgrading that to ~all because
    // the incoming record was softer would weaken a deliberate choice and look like success.
    expect(mergeSpf('v=spf1 include:a.com -all', 'v=spf1 include:b.com ~all')).toBe(
      'v=spf1 include:a.com include:b.com -all',
    )
  })

  it('does not duplicate a mechanism present in both', () => {
    expect(mergeSpf('v=spf1 include:a.com ~all', 'v=spf1 include:a.com ~all')).toBe(
      'v=spf1 include:a.com ~all',
    )
  })

  it('treats mechanisms case-insensitively when deduplicating', () => {
    expect(mergeSpf('v=spf1 include:A.com ~all', 'v=spf1 include:a.com ~all')).toBe(
      'v=spf1 include:A.com ~all',
    )
  })

  it('preserves mechanisms that are not includes', () => {
    expect(mergeSpf('v=spf1 mx a ip4:198.51.100.0/24 -all', 'v=spf1 include:amazonses.com ~all')).toBe(
      'v=spf1 mx a ip4:198.51.100.0/24 include:amazonses.com -all',
    )
  })

  it('emits exactly one all mechanism', () => {
    const merged = mergeSpf('v=spf1 include:a.com -all', 'v=spf1 include:b.com ~all')
    expect(merged.match(/\ball\b/gu)).toHaveLength(1)
  })

  it('emits exactly one v=spf1 prefix', () => {
    const merged = mergeSpf('v=spf1 include:a.com ~all', 'v=spf1 include:b.com ~all')
    expect(merged.match(/v=spf1/gu)).toHaveLength(1)
    expect(merged.startsWith('v=spf1 ')).toBe(true)
  })

  it('supplies ~all when neither input had one', () => {
    // A record with no `all` falls through to neutral, which is close to useless. If both
    // inputs omitted it, softfail is the safe default rather than leaving it off.
    expect(mergeSpf('v=spf1 include:a.com', 'v=spf1 include:b.com')).toBe(
      'v=spf1 include:a.com include:b.com ~all',
    )
  })

  it('tolerates ragged whitespace', () => {
    expect(mergeSpf('  v=spf1   include:a.com   ~all ', 'v=spf1\tinclude:b.com ~all')).toBe(
      'v=spf1 include:a.com include:b.com ~all',
    )
  })

  it('is idempotent, so re-running the setup cannot keep growing the record', () => {
    const once = mergeSpf('v=spf1 include:_spf.porkbun.com ~all', 'v=spf1 include:amazonses.com ~all')
    expect(mergeSpf(once, 'v=spf1 include:amazonses.com ~all')).toBe(once)
  })
})

describe('isSpfRecord', () => {
  it('recognises an SPF record', () => {
    expect(isSpfRecord('v=spf1 include:a.com ~all')).toBe(true)
    expect(isSpfRecord('  V=SPF1 -all')).toBe(true)
  })

  it('does not mistake other TXT records for SPF', () => {
    // Domain-verification TXT records live at the same name and must be left alone.
    expect(isSpfRecord('google-site-verification=abc123')).toBe(false)
    expect(isSpfRecord('v=DMARC1; p=none')).toBe(false)
    expect(isSpfRecord('v=spf10-not-really')).toBe(false)
  })
})
