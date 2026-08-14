import { afterEach, describe, expect, it, vi } from 'vitest'
import { signupsOpen } from '../src/lib/signups'

/**
 * The gate is fail-closed, and that is the whole point of it. These assertions exist so
 * nobody "fixes" the default to open on the reasoning that a missing variable should mean
 * business as usual — for this flag, business as usual is the failure.
 */

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('signupsOpen', () => {
  it('is closed when the variable is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_CLOAKCAL_SIGNUPS_OPEN', undefined)
    expect(signupsOpen()).toBe(false)
  })

  it('is open only on exactly "1"', () => {
    vi.stubEnv('NEXT_PUBLIC_CLOAKCAL_SIGNUPS_OPEN', '1')
    expect(signupsOpen()).toBe(true)
  })

  it('treats every other truthy-looking value as closed', () => {
    for (const value of ['true', 'yes', 'open', '0', '', ' 1', '1 ']) {
      vi.stubEnv('NEXT_PUBLIC_CLOAKCAL_SIGNUPS_OPEN', value)
      expect(signupsOpen(), `"${value}" must not open sign-ups`).toBe(false)
    }
  })
})
