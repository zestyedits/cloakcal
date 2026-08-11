/**
 * Merging SPF records.
 *
 * Its own module so it can be tested without importing the setup script, which runs on
 * import. That matters more than usual here: getting this wrong does not throw, it produces
 * a syntactically valid record that silently fails authentication, and the only symptom is
 * mail landing in spam somewhere you are not looking.
 */

/**
 * Combine two SPF records into one.
 *
 * Union of the mechanisms in first-seen order, with a single trailing `all`.
 *
 * THE EXISTING RECORD'S `all` QUALIFIER WINS. If the domain owner chose `-all` (hard fail),
 * relaxing it to `~all` because an incoming record said so would quietly weaken a
 * deliberate policy — and it would look like a successful merge.
 *
 * Not handled, on purpose: RFC 7208 §4.6.4's limit of 10 DNS-querying mechanisms. Two or
 * three includes is nowhere near it, and a merger that silently dropped mechanisms to stay
 * under a limit would be worse than one that produces a record you can read and check.
 */
export function mergeSpf(existing: string, incoming: string): string {
  const tokensOf = (record: string): string[] =>
    record
      .trim()
      .split(/\s+/u)
      .filter((token) => token.length > 0 && !/^v=spf1$/iu.test(token))

  const isAll = (token: string): boolean => /^[-~?+]?all$/iu.test(token)

  const existingTokens = tokensOf(existing)
  const incomingTokens = tokensOf(incoming)

  // Existing first, so its qualifier is the one found.
  const allToken = [...existingTokens, ...incomingTokens].find(isAll)

  const mechanisms: string[] = []
  for (const token of [...existingTokens, ...incomingTokens]) {
    if (isAll(token)) continue
    if (!mechanisms.some((m) => m.toLowerCase() === token.toLowerCase())) mechanisms.push(token)
  }

  return ['v=spf1', ...mechanisms, allToken ?? '~all'].join(' ')
}

/** True when a TXT record's content is an SPF record rather than any other TXT use. */
export const isSpfRecord = (content: string): boolean => /^v=spf1\b/iu.test(content.trim())
