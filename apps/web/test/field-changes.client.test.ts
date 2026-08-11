import { describe, expect, it } from 'vitest'
import { isNoop, planFieldChanges, type EditableField } from '../src/lib/field-changes.js'

/**
 * The part of editing that can destroy data without anyone noticing.
 *
 * Every other failure in the edit path is recoverable: a rejected save leaves the calendar
 * alone, a version conflict tells you to reload. Overwriting a field that merely FAILED TO
 * DECRYPT with an empty string is not — the ciphertext is gone, and it looks exactly like
 * the user cleared it themselves.
 */

const field = (over: Partial<EditableField> & { name: string }): EditableField => ({
  snapshot: { status: 'missing' },
  value: '',
  touched: false,
  ...over,
})

describe('what gets sent', () => {
  it('sends only what changed', () => {
    const changes = planFieldChanges([
      field({ name: 'title', snapshot: { status: 'ready', value: 'Lunch' }, value: 'Dinner', touched: true }),
      field({ name: 'notes', snapshot: { status: 'ready', value: 'bring deck' }, value: 'bring deck' }),
    ])
    expect(changes.seal).toEqual([['title', 'Dinner']])
    expect(changes.clear).toEqual([])
  })

  it('ignores whitespace-only edits', () => {
    const changes = planFieldChanges([
      field({ name: 'title', snapshot: { status: 'ready', value: 'Lunch' }, value: '  Lunch  ', touched: true }),
    ])
    expect(changes.seal).toEqual([])
  })

  it('adds a field that had no row', () => {
    const changes = planFieldChanges([field({ name: 'location', value: 'Pier 5', touched: true })])
    expect(changes.seal).toEqual([['location', 'Pier 5']])
  })

  it('removes a field the user emptied, rather than sealing an empty string', () => {
    const changes = planFieldChanges([
      field({ name: 'notes', snapshot: { status: 'ready', value: 'bring deck' }, value: '', touched: true }),
    ])
    expect(changes.clear).toEqual(['notes'])
    expect(changes.seal).toEqual([])
  })

  it('does not try to remove a field that never existed', () => {
    const changes = planFieldChanges([field({ name: 'notes', value: '', touched: true })])
    expect(changes.clear).toEqual([])
    expect(changes.seal).toEqual([])
  })
})

describe('a field that will not decrypt', () => {
  it('is left completely alone when the user did not touch it', () => {
    // THE DATA-LOSS TEST. The form shows this field empty because there is nothing to show.
    // Treating that as "the user cleared it" would delete real content permanently.
    const changes = planFieldChanges([
      field({ name: 'notes', snapshot: { status: 'error', reason: 'bad key' }, value: '' }),
    ])
    expect(changes.seal).toEqual([])
    expect(changes.clear).toEqual([])
    expect(changes.skippedUnreadable).toEqual(['notes'])
  })

  it('is written when the user actually types a replacement', () => {
    const changes = planFieldChanges([
      field({
        name: 'notes',
        snapshot: { status: 'error', reason: 'bad key' },
        value: 'rewritten',
        touched: true,
      }),
    ])
    expect(changes.seal).toEqual([['notes', 'rewritten']])
    expect(changes.skippedUnreadable).toEqual([])
  })

  it('is removed when the user deliberately empties it', () => {
    // Touched and empty is an intent, unlike untouched and empty. The user is looking at a
    // field labelled unreadable and has chosen to clear it.
    const changes = planFieldChanges([
      field({ name: 'notes', snapshot: { status: 'error', reason: 'bad key' }, value: '', touched: true }),
    ])
    expect(changes.clear).toEqual(['notes'])
  })

  it('does not drag other fields down with it', () => {
    const changes = planFieldChanges([
      field({ name: 'title', snapshot: { status: 'ready', value: 'Lunch' }, value: 'Dinner', touched: true }),
      field({ name: 'notes', snapshot: { status: 'error', reason: 'bad key' }, value: '' }),
    ])
    expect(changes.seal).toEqual([['title', 'Dinner']])
    expect(changes.clear).toEqual([])
  })
})

describe('saving a no-op', () => {
  it('is recognised, so Save can stay disabled', () => {
    // Not cosmetic: an empty save still bumps the row version, which would invalidate every
    // other open tab's optimistic guard for no reason at all.
    const unchanged = planFieldChanges([
      field({ name: 'title', snapshot: { status: 'ready', value: 'Lunch' }, value: 'Lunch' }),
    ])
    expect(isNoop(unchanged, false)).toBe(true)
  })

  it('is not a no-op when only the timing moved', () => {
    const unchanged = planFieldChanges([
      field({ name: 'title', snapshot: { status: 'ready', value: 'Lunch' }, value: 'Lunch' }),
    ])
    expect(isNoop(unchanged, true)).toBe(false)
  })

  it('is not a no-op when an unreadable field was skipped but something else changed', () => {
    const changes = planFieldChanges([
      field({ name: 'title', snapshot: { status: 'ready', value: 'Lunch' }, value: 'Dinner', touched: true }),
      field({ name: 'notes', snapshot: { status: 'error', reason: 'bad key' }, value: '' }),
    ])
    expect(isNoop(changes, false)).toBe(false)
  })
})
