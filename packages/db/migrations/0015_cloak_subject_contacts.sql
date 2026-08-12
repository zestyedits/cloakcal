-- Two new Cloaked subject types, and nothing else.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS ITS OWN MIGRATION, WHICH LOOKS LIKE OVER-CEREMONY AND IS NOT
-- ---------------------------------------------------------------------------
--
-- A new enum value cannot be USED in the same transaction that adds it. Postgres refuses
-- with `unsafe use of new value "contact" of enum type cloak_subject`, because the value is
-- not durable until commit and an index or constraint built against it could be corrupt if
-- the transaction rolled back.
--
-- "Used" is broader than it sounds. It is not only INSERTs: a CHECK CONSTRAINT that mentions
-- the literal counts, which is exactly how this was found — 0016's widened
-- `cloaked_fields_valid_subject_field` names 'contact' and 'contact_group', and the combined
-- migration failed on it.
--
-- So the enum change lives alone. Each migration file is applied in its own transaction, so
-- by the time 0016 runs the values are committed and usable. Splitting is the only fix;
-- there is no flag that relaxes it.
--
-- `if not exists` makes both statements idempotent, so re-running against a database that
-- already has them is a no-op rather than an error.
--
-- See docs/decisions/0004-contacts-are-cloaked.md for WHY contacts are Cloaked at all.

alter type public.cloak_subject add value if not exists 'contact';
alter type public.cloak_subject add value if not exists 'contact_group';
