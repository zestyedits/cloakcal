-- M3 — root key lifecycle storage.
--
-- WHAT THIS TABLE HOLDS: bytes CloakCal cannot open. Every row is the User Root Key
-- sealed under a key derived on the user's device — from their password, their recovery
-- phrase, or another device's keypair. The server stores them, replicates them, backs them
-- up, and can do nothing with them. That is the entire point of D7: no escrow, so "we
-- cannot read your events" is a property of the mathematics rather than a promise about
-- our conduct.
--
-- WHY ONE TABLE FOR THREE WRAPS. They are the same operation with different key sources,
-- and keeping them together means the "you must always have at least one wrap" invariant
-- is one query rather than a union across three shapes. Splitting them would also invite a
-- future migration that adds a fourth kind somewhere else and forgets the RLS policy.

create table public.root_key_wraps (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,

  kind          text not null check (kind in ('password', 'recovery', 'device')),

  -- Set only for kind='device'. Populated when the wrap is created by an already-unlocked
  -- device for a newly paired one.
  device_id     uuid references public.devices (id) on delete cascade,

  -- Argon2id parameters actually used, so they can be raised over time without stranding
  -- existing wraps. THE CLIENT ENFORCES ITS OWN FLOOR over these values (see
  -- packages/crypto/src/kdf.ts): they arrive from the server, and a server able to lower
  -- them could make every derivation cheap to brute-force. Stored so they may only ever be
  -- used to make a derivation more expensive.
  kdf           jsonb,

  -- The sender's one-time ECDH public key for kind='device'. Public by construction.
  ephemeral_public_key bytea,

  wrapped       bytea not null,
  nonce         bytea not null,
  alg           public.cloak_alg not null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint root_key_wraps_device_pair
    check ((kind = 'device') = (device_id is not null)),
  constraint root_key_wraps_ephemeral_pair
    check ((kind = 'device') = (ephemeral_public_key is not null)),
  constraint root_key_wraps_kdf_pair
    check ((kind = 'password') = (kdf is not null)),

  -- A 32-byte payload under AES-GCM is 48 bytes: 32 of ciphertext plus the 16-byte tag.
  -- Anything shorter is not an authenticated wrap of a root key, whatever it claims to be.
  constraint root_key_wraps_length check (octet_length(wrapped) = 48),
  constraint root_key_wraps_nonce_length check (octet_length(nonce) = 12)
);

-- Exactly one password wrap and one recovery wrap per user: a second of either would be a
-- silent fork, where changing the password leaves an older wrap that still opens the
-- account. Device wraps are one per device, which the FK plus this index gives us.
create unique index root_key_wraps_one_password
  on public.root_key_wraps (user_id) where kind = 'password';
create unique index root_key_wraps_one_recovery
  on public.root_key_wraps (user_id) where kind = 'recovery';
create unique index root_key_wraps_one_per_device
  on public.root_key_wraps (device_id) where device_id is not null;

create index root_key_wraps_user_idx on public.root_key_wraps (user_id);

create trigger root_key_wraps_touch before update on public.root_key_wraps
  for each row execute function public.touch_updated_at();

alter table public.root_key_wraps enable row level security;
alter table public.root_key_wraps force row level security;

-- Strictly own-row. There is no sharing story for a root key wrap and there never will be:
-- a policy that let anyone else read one would defeat the table's only purpose.
create policy root_key_wraps_all on public.root_key_wraps
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- devices — supersede the inline wrapped_root_key column
-- ---------------------------------------------------------------------------
--
-- 0001 put wrapped_root_key directly on devices, before there was anywhere to record the
-- ephemeral public key that an ECIES wrap requires. Keeping both would leave two places a
-- device wrap could live, and a reader would have to know which one is authoritative.

alter table public.devices drop column wrapped_root_key;

comment on column public.devices.public_key is
  'Raw ECDH P-256 public key (65 bytes, uncompressed point). ADR 0002 specifies X25519; '
  'P-256 is used instead for universal WebCrypto support — see packages/crypto/src/device.ts.';

alter table public.devices
  add constraint devices_public_key_length check (octet_length(public_key) = 65);

-- ---------------------------------------------------------------------------
-- profiles — record that Cloak setup completed
-- ---------------------------------------------------------------------------
--
-- Tier A by necessity: the app must know whether to show the setup flow or the unlock
-- screen before it has any key. It is a boolean about ceremony completion, never content.
--
-- recovery_phrase_confirmed_at is separate from cloak_initialized_at on purpose. A user
-- who generated a phrase but never confirmed it has an account that looks protected and
-- is one forgotten password away from unrecoverable. The UI must be able to tell.

alter table public.profiles
  add column cloak_initialized_at timestamptz,
  add column recovery_phrase_confirmed_at timestamptz;
