-- Runner-managed auth profiles, editable through the API.
--
-- Until now a profile lived only in `RUNNER_AUTH_PROFILES` in the worker's
-- environment, and blueprint section 50 said a credential exists nowhere else.
-- That kept the guarantee absolute and made every new profile a redeploy, which
-- is the wrong trade for a team authoring tests against several applications.
--
-- So the rule is relaxed *deliberately and narrowly*:
--
--   * `execution_profiles` (migration 0001) keeps the non-secret half — ref,
--     strategy, login URL, which named fields the login form has. All of it is
--     safe to read back over the API.
--   * `profile_secrets` below holds credential values, and only ever as
--     AES-256-GCM ciphertext under a key that lives in the environment
--     (`RUNNER_SECRET_KEY`), never in this database. A dump of Postgres alone
--     reveals nothing.
--   * `secret_references` (migration 0001) is unchanged and still means what
--     its comment says: a pointer into an external secret store. A profile may
--     use either mechanism — an environment variable name, or a value sealed
--     here — and the worker prefers the external reference when both exist,
--     because an external secret store is still the better answer.
--
-- The API never returns a sealed value, not even to the user who set it. It
-- reports only whether a secret is present, so a leaked read cannot become a
-- leaked credential.

BEGIN;

CREATE TABLE profile_secrets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id        UUID NOT NULL REFERENCES execution_profiles(id) ON DELETE CASCADE,
  -- The form field this credential fills: 'username', 'password', and whatever
  -- else a profile's form_fields names, such as 'companyCode'.
  secret_key        TEXT NOT NULL,

  -- Base64 of each part. Split into columns rather than one JSON blob so a
  -- record missing its nonce or tag is impossible to write.
  ciphertext        TEXT NOT NULL,
  iv                TEXT NOT NULL,
  auth_tag          TEXT NOT NULL,
  -- Recorded per row so a future key rotation or algorithm change can still
  -- read what this one wrote.
  algorithm         TEXT NOT NULL DEFAULT 'aes-256-gcm'
                      CHECK (algorithm IN ('aes-256-gcm')),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id, secret_key)
);

CREATE INDEX profile_secrets_profile_idx ON profile_secrets (profile_id);

COMMENT ON TABLE profile_secrets IS
  'Credential values for an auth profile, sealed with AES-256-GCM under RUNNER_SECRET_KEY. Never store plaintext here, and never return a sealed value over the API.';

COMMENT ON COLUMN profile_secrets.secret_key IS
  'The form field this credential fills, matching a key of execution_profiles.form_fields.';

-- A profile the API creates needs its workspace row to exist, because
-- execution_profiles.workspace_ref is a foreign key. The adapter upserts it,
-- and this index is what makes that upsert cheap.
CREATE INDEX execution_profiles_workspace_idx ON execution_profiles (workspace_ref);

COMMIT;
