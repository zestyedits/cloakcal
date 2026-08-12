import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONFIRMATION_HTML,
  CONFIRMATION_SUBJECT,
  RECOVERY_HTML,
  RECOVERY_SUBJECT,
} from './email-templates.js'

/**
 * Writes the transactional emails to disk so they can be looked at, and pasted.
 *
 * `pnpm email:setup` installs these on Supabase automatically, but it needs credentials that
 * deliberately do not travel between machines — so on a fresh clone there is no way to push
 * them and no way to see them either. This closes the second gap: run it, open the files,
 * and either paste the source into Supabase → Authentication → Emails, or just check the
 * wording before running the real setup.
 *
 * Output goes to a gitignored directory. These are generated artefacts of
 * `email-templates.ts`, and committing them would create a second copy to drift.
 */

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '.email-preview')

/** A plausible link, so the preview shows the real layout rather than a template literal. */
const SAMPLE = 'https://cloakcal.com/recover?code=00000000-0000-4000-8000-000000000000'

const templates = [
  { name: 'recovery', subject: RECOVERY_SUBJECT, html: RECOVERY_HTML },
  { name: 'confirmation', subject: CONFIRMATION_SUBJECT, html: CONFIRMATION_HTML },
]

await mkdir(OUT, { recursive: true })

for (const { name, subject, html } of templates) {
  // Two files each. The `-source` one keeps `{{ .ConfirmationURL }}` intact and is what
  // Supabase wants; the preview substitutes it so a browser renders something real. Pasting
  // the preview by mistake would ship an email whose button always went to the same dead
  // link, which is exactly the sort of thing that survives a glance.
  await writeFile(join(OUT, `${name}-source.html`), html)
  await writeFile(join(OUT, `${name}-preview.html`), html.replaceAll('{{ .ConfirmationURL }}', SAMPLE))
  console.log(`${name}\n  subject: ${subject}\n  paste:   .email-preview/${name}-source.html\n  preview: .email-preview/${name}-preview.html`)
}

console.log(
  '\nSupabase → Authentication → Emails. Paste the -source file, which keeps the\n' +
    '{{ .ConfirmationURL }} placeholder Supabase substitutes. Or run `pnpm email:setup`\n' +
    'with .env.email-setup present and it installs both without any copying.',
)
