import postgres from 'postgres'
const PW = process.env.PW
const targets = [
  ['dedicated (IPv6)', `postgresql://billing_writer:${PW}@db.bnjbgjzbddypqtoolunz.supabase.co:6543/postgres`],
  ['shared aws-0-us-east-2', `postgresql://billing_writer.bnjbgjzbddypqtoolunz:${PW}@aws-0-us-east-2.pooler.supabase.com:6543/postgres`],
  ['shared aws-1-us-east-2', `postgresql://billing_writer.bnjbgjzbddypqtoolunz:${PW}@aws-1-us-east-2.pooler.supabase.com:6543/postgres`],
]
for (const [label, url] of targets) {
  const sql = postgres(url, { prepare: false, max: 1, ssl: 'require', connect_timeout: 12, idle_timeout: 5 })
  try {
    const r = await sql`select current_user as who, current_setting('is_superuser') as su,
                               current_setting('statement_timeout') as st,
                               current_setting('idle_in_transaction_session_timeout') as idle`
    console.log(`✓ ${label}: user=${r[0].who} superuser=${r[0].su} statement_timeout=${r[0].st} idle=${r[0].idle}`)
  } catch (e) {
    console.log(`✗ ${label}: ${e.code ?? ''} ${e.message.slice(0, 110)}`)
  } finally { await sql.end({ timeout: 3 }).catch(() => {}) }
}
