/**
 * One command to stand up sending email for a project.
 *
 * Replaces the click-through that gets repeated on every build: add the domain to Resend,
 * copy its DKIM/SPF records into DNS by hand, wait, re-check, mint a send key, then paste
 * SMTP settings into the Supabase dashboard. All of it is API-driven; none of it needs a
 * browser.
 *
 * Run:
 *   pnpm email:setup            # do it
 *   pnpm email:setup --dry-run  # validate everything, write nothing
 *
 * IDEMPOTENT. Re-running is safe and is the intended way to resume after a failure.
 *
 * It writes exactly one kind of destructive change, and only under --merge-spf: collapsing
 * multiple root SPF records into one. Nothing else is ever edited or removed.
 *
 * WHAT IT WILL NOT DO, and why:
 *
 *   Email FORWARDING (support@ -> a real inbox) is not in Porkbun's API. Their v3 spec has
 *   68 endpoints and full DNS CRUD, but the only /email/ route is setPassword, for their
 *   paid mailboxes. Forwarding is a control-panel toggle. The script prints it as a manual
 *   step rather than pretending to have done it.
 *
 *   It will not leave a domain with two SPF records. Two SPF TXT records at one name is not
 *   "more SPF" — it is a permerror under RFC 7208, and every receiver then treats the domain
 *   as having no SPF at all. Mail keeps sending and quietly lands in spam. Without
 *   --merge-spf it refuses and prints the value to set; with it, it folds them into one.
 *
 * READ-MODIFY-WRITE, so it races with the control panel. It reads the zone, decides, then
 * writes. Configuring a mail provider in another tab mid-run is how cloakcal.com ended up
 * with two SPF records: the first run merged Porkbun's, Zoho's setup added its own, and the
 * next run saw only the first. Re-running now repairs that, but the window is real — do not
 * edit DNS by hand while this is running.
 */

import { execFile } from 'node:child_process'
import { isSpfRecord, mergeSpf } from './spf.js'
import { promisify } from 'node:util'
import {
  CONFIRMATION_HTML,
  CONFIRMATION_SUBJECT,
  RECOVERY_HTML,
  RECOVERY_SUBJECT,
} from './email-templates.js'

const run = promisify(execFile)

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface Config {
  readonly domain: string
  readonly supabaseRef: string
  readonly senderName: string
  readonly senderAddress: string
  readonly siteUrl: string
  readonly porkbunKey: string
  readonly porkbunSecret: string
  readonly resendKey: string
  readonly supabaseToken: string
  readonly vercelProject: string | null
  readonly dryRun: boolean
  readonly mergeSpf: boolean
}

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. Run:  cp tools/email-setup.env.example .env.email-setup  then fill ` +
        `it in. The .env.email-setup path is gitignored; the template is not.`,
    )
  }
  return value.trim()
}

function loadConfig(): Config {
  const domain = process.env['EMAIL_DOMAIN']?.trim() ?? 'cloakcal.com'
  return {
    domain,
    supabaseRef: required('SUPABASE_PROJECT_REF'),
    senderName: process.env['EMAIL_SENDER_NAME']?.trim() ?? 'CloakCal',
    senderAddress: process.env['EMAIL_SENDER_ADDRESS']?.trim() ?? `no-reply@${domain}`,
    siteUrl: required('SITE_URL'),
    porkbunKey: required('PORKBUN_API_KEY'),
    porkbunSecret: required('PORKBUN_SECRET_KEY'),
    resendKey: required('RESEND_API_KEY'),
    supabaseToken: required('SUPABASE_ACCESS_TOKEN'),
    vercelProject: process.env['VERCEL_PROJECT']?.trim() ?? null,
    dryRun: process.argv.includes('--dry-run'),
    mergeSpf: process.argv.includes('--merge-spf'),
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

let step = 0
const heading = (text: string) => {
  step += 1
  console.log(`\n\x1b[1m${step}. ${text}\x1b[0m`)
}
const ok = (text: string) => console.log(`   \x1b[32m✓\x1b[0m ${text}`)
const info = (text: string) => console.log(`   \x1b[2m·\x1b[0m ${text}`)
const warn = (text: string) => console.log(`   \x1b[33m!\x1b[0m ${text}`)

class SetupError extends Error {
  constructor(message: string, readonly fix?: string) {
    super(message)
    this.name = 'SetupError'
  }
}

// ---------------------------------------------------------------------------
// Porkbun — https://api.porkbun.com/api/json/v3
// ---------------------------------------------------------------------------

const PORKBUN = 'https://api.porkbun.com/api/json/v3'

interface PorkbunRecord {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly content: string
  readonly ttl: string
  readonly prio: string | null
}

async function porkbun<T>(config: Config, path: string, body: Record<string, unknown> = {}): Promise<T> {
  // Credentials go in the body as well as the headers. The spec accepts either; sending
  // both means the call works against older Porkbun deployments that predate the headers.
  const response = await fetch(`${PORKBUN}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.porkbunKey,
      'X-Secret-API-Key': config.porkbunSecret,
    },
    body: JSON.stringify({ apikey: config.porkbunKey, secretapikey: config.porkbunSecret, ...body }),
  })

  const json = (await response.json()) as { status?: string; message?: string } & T
  if (json.status !== 'SUCCESS') {
    throw new SetupError(
      `Porkbun ${path} failed: ${json.message ?? response.statusText}`,
      /not opted in|api access/i.test(json.message ?? '')
        ? `Enable API access for ${config.domain}: porkbun.com -> Domain Management -> ` +
          `${config.domain} -> toggle "API ACCESS" on. It is off by default, per domain.`
        : undefined,
    )
  }
  return json
}

/** Root records come back with an empty-ish name; normalise so comparisons are honest. */
const subdomainOf = (record: PorkbunRecord, domain: string): string =>
  record.name === domain ? '' : record.name.replace(new RegExp(`\\.?${domain.replace('.', '\\.')}$`), '')

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

interface ResendRecord {
  readonly record: string
  readonly name: string
  readonly type: string
  readonly value: string
  readonly priority?: number
  readonly ttl: string
  readonly status: string
}

interface ResendDomain {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly records: readonly ResendRecord[]
}

async function resend<T>(
  config: Config,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`https://api.resend.com${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${config.resendKey}`,
      'Content-Type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })

  const json = (await response.json()) as T & { message?: string; name?: string }
  if (!response.ok) {
    throw new SetupError(`Resend ${path} failed (${response.status}): ${json.message ?? 'unknown'}`)
  }
  return json
}

async function ensureResendDomain(config: Config): Promise<ResendDomain> {
  const existing = await resend<{ data: Array<{ id: string; name: string }> }>(config, '/domains')
  const match = existing.data?.find((d) => d.name === config.domain)

  if (match !== undefined) {
    info(`domain already registered with Resend (${match.id})`)
    return resend<ResendDomain>(config, `/domains/${match.id}`)
  }

  if (config.dryRun) {
    throw new SetupError(
      'Dry run cannot continue: the domain is not in Resend yet, so there are no DNS ' +
        'records to validate. Run without --dry-run.',
    )
  }

  const created = await resend<ResendDomain>(config, '/domains', {
    method: 'POST',
    body: { name: config.domain, region: 'us-east-1' },
  })
  ok(`added ${config.domain} to Resend (${created.id})`)
  return created
}

// ---------------------------------------------------------------------------
// Supabase Management API
// ---------------------------------------------------------------------------

async function supabase<T>(
  config: Config,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`https://api.supabase.com/v1${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${config.supabaseToken}`,
      'Content-Type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new SetupError(
      `Supabase ${path} failed (${response.status}): ${text.slice(0, 300)}`,
      response.status === 401
        ? 'SUPABASE_ACCESS_TOKEN must be a personal access token from ' +
          'supabase.com/dashboard/account/tokens — not the anon or service key.'
        : undefined,
    )
  }
  return (text === '' ? {} : JSON.parse(text)) as T
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function preflight(config: Config): Promise<void> {
  heading('Checking credentials')

  await porkbun(config, '/ping')
  ok('Porkbun API key works')

  await resend<{ data: unknown }>(config, '/domains')
  ok('Resend API key works')

  const project = await supabase<{ name: string }>(config, `/projects/${config.supabaseRef}`)
  ok(`Supabase token works (project "${project.name}")`)

  if (config.dryRun) warn('dry run: nothing will be written')
}

/**
 * Write Resend's records into Porkbun, skipping any that already match.
 *
 * Comparison is on (subdomain, type, value) rather than on Porkbun's record id, because the
 * id changes if a record is ever recreated by hand and we would then add a duplicate.
 */
async function writeDnsRecords(config: Config, domain: ResendDomain): Promise<void> {
  heading('Writing DNS records at Porkbun')

  const current = await porkbun<{ records: PorkbunRecord[] }>(config, `/dns/retrieve/${config.domain}`)
  info(`${current.records.length} existing records`)

  // Guard the one failure mode that is silent and total. A second SPF record does not add
  // to the first: RFC 7208 makes multiple SPF records a permerror, and receivers then treat
  // the domain as having no SPF at all. Mail keeps sending and quietly lands in spam.
  const resendSpf = domain.records.find((r) => r.record === 'SPF' && r.type === 'TXT')

  // ALL of them, not the first. An earlier version used .find() here, which assumed a
  // domain has at most one SPF record — exactly the broken state this code exists to
  // detect. It cannot assume the thing it is checking for. Two records appeared on
  // cloakcal.com when a mail provider was configured in another tab between two runs.
  const existingSpfRecords = current.records.filter(
    (r) => r.type === 'TXT' && subdomainOf(r, config.domain) === '' && isSpfRecord(r.content),
  )
  const existingSpf = existingSpfRecords[0]

  if (existingSpfRecords.length > 1) {
    warn(`${existingSpfRecords.length} root SPF records found — this domain is currently a permerror`)
    for (const record of existingSpfRecords) info(`  ${record.content}`)
  }

  // Fold every existing SPF record together with Resend's, so a domain that is already in
  // the two-record broken state collapses to one correct record rather than staying broken.
  const mergedSpf =
    resendSpf === undefined || existingSpf === undefined
      ? null
      : existingSpfRecords
          .map((r) => r.content)
          .reduce((acc, content) => mergeSpf(acc, content), resendSpf.value)

  // Already merged by a previous run. Comparing against the MERGED value rather than
  // against Resend's raw one is what makes this idempotent: the stored record will never
  // equal Resend's record once other senders are included, so a naive inequality check
  // would try to rewrite it on every single run.
  if (existingSpfRecords.length === 1 && existingSpf !== undefined && mergedSpf === existingSpf.content) {
    info('SPF already includes Resend, left alone')
  } else if (resendSpf !== undefined && existingSpf !== undefined && mergedSpf !== null) {
    const merged = mergedSpf

    if (!config.mergeSpf) {
      throw new SetupError(
        `${config.domain} already has an SPF record and it does not match Resend's.`,
        `Two SPF records is a permerror, not a merge, so this script will not add a second.\n` +
          `      Existing: ${existingSpf.content}\n` +
          `      Resend:   ${resendSpf.value}\n` +
          `      Merged:   ${merged}\n` +
          `      Re-run with --merge-spf to replace the existing record with the merged value,\n` +
          `      or set it by hand if you would rather look at it first.`,
      )
    }

    info(`existing SPF: ${existingSpf.content}`)
    info(`merged SPF:   ${merged}`)

    if (!config.dryRun) {
      // Edit by RECORD ID, replacing in place. Creating would leave two records, which is
      // the failure this whole branch exists to avoid.
      //
      // Not editByNameType: that endpoint targets every record matching a (type,
      // subdomain) pair, and for a root TXT the subdomain is empty — which both makes the
      // path end in a bare slash and would sweep in any other root TXT record, such as a
      // domain-verification token. It also simply returns "unable to edit" in that shape.
      await porkbun(config, `/dns/edit/${config.domain}/${existingSpf.id}`, {
        name: '',
        type: 'TXT',
        content: merged,
        ttl: 600,
      })

      // Then remove the surplus. This is the ONE deletion this tool performs, it only ever
      // touches records it just folded into the survivor, and it only runs under the
      // explicit --merge-spf opt-in. Leaving them would mean the merge changed nothing:
      // the domain would still have multiple SPF records and still be a permerror.
      for (const surplus of existingSpfRecords.slice(1)) {
        await porkbun(config, `/dns/delete/${config.domain}/${surplus.id}`)
        ok(`removed surplus SPF record (${surplus.content})`)
      }
    }
    ok(`${config.dryRun ? 'would merge' : 'merged'} SPF into one record`)
  }

  for (const record of domain.records) {
    const subdomain = record.name.replace(new RegExp(`\\.?${config.domain.replace('.', '\\.')}$`), '')

    const already = current.records.find(
      (r) =>
        r.type === record.type &&
        subdomainOf(r, config.domain) === subdomain &&
        r.content.replace(/^"|"$/g, '') === record.value.replace(/^"|"$/g, ''),
    )

    if (already !== undefined) {
      info(`${record.type} ${subdomain || '@'} already correct`)
      continue
    }

    const body: Record<string, unknown> = {
      name: subdomain,
      type: record.type,
      content: record.value,
      ttl: 600,
      ...(record.priority === undefined ? {} : { prio: record.priority }),
      ...(config.dryRun ? { dryRun: true } : {}),
    }

    await porkbun(config, `/dns/create/${config.domain}`, body)
    ok(`${config.dryRun ? 'would add' : 'added'} ${record.type} ${subdomain || '@'} (${record.record})`)
  }

  // Resend does not hand back a DMARC record, but a domain that authenticates and has no
  // DMARC policy still gets treated with suspicion by Gmail and Outlook bulk filters.
  // p=none is the correct starting point: it asks for reports and quarantines nothing, so
  // it cannot break delivery while alignment is still being observed.
  const hasDmarc = current.records.some(
    (r) => r.type === 'TXT' && subdomainOf(r, config.domain) === '_dmarc',
  )
  if (!hasDmarc) {
    const value = `v=DMARC1; p=none; rua=mailto:dmarc@${config.domain}`
    if (!config.dryRun) {
      await porkbun(config, `/dns/create/${config.domain}`, {
        name: '_dmarc',
        type: 'TXT',
        content: value,
        ttl: 600,
      })
    }
    ok(`${config.dryRun ? 'would add' : 'added'} DMARC (p=none)`)
  } else {
    info('DMARC already present, left alone')
  }
}

/** Poll rather than assume: DNS propagation is the step that actually takes time. */
async function waitForVerification(config: Config, domainId: string): Promise<boolean> {
  heading('Verifying with Resend')

  if (config.dryRun) {
    warn('dry run: skipping verification')
    return false
  }

  await resend(config, `/domains/${domainId}/verify`, { method: 'POST' })

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const domain = await resend<ResendDomain>(config, `/domains/${domainId}`)
    if (domain.status === 'verified') {
      ok('domain verified')
      return true
    }
    info(`status "${domain.status}", checking again in 15s (${attempt}/20)`)
    await new Promise((resolve) => setTimeout(resolve, 15_000))
  }

  warn('still not verified after 5 minutes. DNS can take longer; re-run this script later.')
  return false
}

async function createSendKey(config: Config): Promise<string> {
  heading('Creating a scoped Resend key')

  if (config.dryRun) {
    warn('dry run: no key created')
    return 're_dry_run'
  }

  // sending_access, not full_access: this key ends up in Vercel's environment and in
  // Supabase's SMTP settings. A full-access key sitting there could also delete domains and
  // mint further keys, which is a lot of authority for something whose only job is to send.
  const key = await resend<{ token: string }>(config, '/api-keys', {
    method: 'POST',
    body: { name: `${config.domain} sending`, permission: 'sending_access' },
  })
  ok('created a sending-only key')

  // Resend returns a key's token only at creation, so a re-run cannot reuse the previous
  // one and necessarily mints another. Say so, rather than letting dead keys pile up
  // silently every time this is re-run to resume from a later failure.
  const all = await resend<{ data: Array<{ id: string; name: string }> }>(config, '/api-keys')
  const siblings = all.data?.filter((k) => k.name === `${config.domain} sending`) ?? []
  if (siblings.length > 1) {
    warn(
      `${siblings.length} keys now share this name. Only the newest is in use — ` +
        `revoke the rest at resend.com/api-keys.`,
    )
  }

  return key.token
}

async function configureSupabaseSmtp(config: Config, sendKey: string): Promise<void> {
  heading('Pointing Supabase Auth at Resend')

  // Read first. The field names for SMTP are documented, but reading the live config and
  // checking the keys exist turns an assumption about this API's shape into a check that
  // fails loudly here rather than silently no-opping.
  const before = await supabase<Record<string, unknown>>(config, `/projects/${config.supabaseRef}/config/auth`)

  const expected = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_admin_email', 'smtp_sender_name']
  const missing = expected.filter((key) => !(key in before))
  if (missing.length > 0) {
    throw new SetupError(
      `Supabase auth config does not expose ${missing.join(', ')} — the API shape has changed.`,
      'Stop and check https://api.supabase.com/api/v1#/projects%20config/updateV1AuthConfig',
    )
  }

  const patch: Record<string, unknown> = {
    external_email_enabled: true,
    smtp_host: 'smtp.resend.com',
    // 465 is implicit TLS. The STARTTLS ports (587/2587) are equally valid, but implicit
    // TLS cannot be downgraded by a middlebox that strips the STARTTLS capability.
    //
    // A STRING, not a number, despite Supabase's own documented example showing
    // `"smtp_port": 587` unquoted. The live API rejects a number with
    // "expected string, received number". Found by running it.
    smtp_port: '465',
    smtp_user: 'resend',
    smtp_pass: sendKey,
    smtp_admin_email: config.senderAddress,
    smtp_sender_name: config.senderName,
    // Confirmation ON is only defensible once mail actually sends. Until now it was on with
    // no working sender, which is why sign-up could not complete for any address.
    mailer_autoconfirm: false,
    site_url: config.siteUrl,
  }

  // Branded templates. Supabase's defaults are an unstyled sentence and a naked link, which
  // is both off-brand and the exact shape of a phishing mail — a bad look for the one message
  // that asks somebody to click through and change a credential.
  //
  // Same read-then-write discipline as the SMTP keys above: set these only if the live config
  // actually exposes them, so a renamed field fails loudly here instead of silently no-opping
  // and leaving the defaults in place looking configured.
  const templateFields: Record<string, string> = {
    mailer_subjects_recovery: RECOVERY_SUBJECT,
    mailer_templates_recovery_content: RECOVERY_HTML,
    mailer_subjects_confirmation: CONFIRMATION_SUBJECT,
    mailer_templates_confirmation_content: CONFIRMATION_HTML,
  }
  for (const [key, value] of Object.entries(templateFields)) {
    if (key in before) {
      patch[key] = value
    } else {
      warn(`no ${key} field in this API version — set that template in the dashboard`)
    }
  }

  // The redirect allowlist key is not in the documented example, so set it only if the live
  // config confirms it exists. Guessing here would silently drop the setting.
  if ('uri_allow_list' in before) {
    patch['uri_allow_list'] = [config.siteUrl, `${config.siteUrl}/**`].join(',')
  } else {
    warn('no uri_allow_list field in this API version — set redirect URLs in the dashboard')
  }

  if (config.dryRun) {
    warn(`dry run: would PATCH ${Object.keys(patch).length} auth settings`)
    return
  }

  await supabase(config, `/projects/${config.supabaseRef}/config/auth`, { method: 'PATCH', body: patch })
  ok('SMTP configured, branded templates installed, confirmation enabled, site URL set')
}

async function pushVercelEnv(config: Config, sendKey: string): Promise<void> {
  if (config.vercelProject === null) return
  heading('Pushing RESEND_API_KEY to Vercel')

  if (config.dryRun) {
    warn('dry run: no env var written')
    return
  }

  for (const target of ['preview', 'production']) {
    try {
      await run('vercel', ['env', 'add', 'RESEND_API_KEY', target, '--force'], {
        input: sendKey,
      } as never)
      ok(`set for ${target}`)
    } catch (error) {
      warn(`could not set for ${target}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig()

  console.log(`\n\x1b[1mEmail setup — ${config.domain}\x1b[0m`)
  console.log(`\x1b[2mResend sending, Porkbun DNS, Supabase Auth SMTP\x1b[0m`)

  await preflight(config)

  const domain = await ensureResendDomain(config)
  await writeDnsRecords(config, domain)

  const verified = await waitForVerification(config, domain.id)
  if (!verified && !config.dryRun) {
    warn('stopping before SMTP config — Supabase would accept it but mail would bounce')
    printManualSteps(config)
    return
  }

  const sendKey = await createSendKey(config)
  await configureSupabaseSmtp(config, sendKey)
  await pushVercelEnv(config, sendKey)

  console.log(`\n\x1b[32m\x1b[1mDone.\x1b[0m Supabase now sends from ${config.senderAddress}.`)
  printManualSteps(config)
}

function printManualSteps(config: Config): void {
  console.log(`\n\x1b[1mStill manual — not exposed by any API:\x1b[0m`)
  console.log(
    `   support@${config.domain} forwarding. Porkbun's v3 API has 68 endpoints and full DNS\n` +
      `   CRUD, but no email-forwarding route — only /email/setPassword, for their paid\n` +
      `   mailboxes. Set it at porkbun.com -> Domain Management -> ${config.domain} ->\n` +
      `   Email Forwarding. This adds its own MX records; they do not conflict with the\n` +
      `   sending records above, which sit on a subdomain.`,
  )
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`\n\x1b[31m✗ ${message}\x1b[0m`)
  if (error instanceof SetupError && error.fix !== undefined) {
    console.error(`\n\x1b[33mFix:\x1b[0m ${error.fix}`)
  }
  process.exitCode = 1
})
