-- Token-based authentication for auth profiles.
--
-- `FORM_LOGIN` drives the real UI, which is the right default: it exercises the
-- same path a user takes, and the Runner already has a browser. But an
-- API-first application often has no form worth driving — the front end obtains
-- a token and hands it to every request — and for those, replaying a UI login
-- means automating a screen nobody uses.
--
-- Two columns, both JSONB, both describing *where things go* rather than what
-- they are:
--
--   * `token_config` says how a token is obtained (a value stored with the
--     profile, or an exchange with the application's login endpoint) and where
--     it must end up for the app to consider the browser signed in: a storage
--     key, a cookie, a request header, or several at once. There is no single
--     correct placement, and guessing wrong produces the worst failure in this
--     area — a login that reports success while every page still shows the
--     sign-in screen.
--
--   * `extra_headers` are headers added to every request the profile's browser
--     makes. Free-form because an internal application usually wants a tenant
--     id, an API version or a feature flag alongside authentication, and
--     enumerating those in the Runner would mean a redeploy per application.
--
-- No credential lives in either column. A header or a static token that *is* a
-- credential names an entry in `profile_secrets` (migration 0002) or
-- `secret_references`, so the value stays sealed or stays in the environment.

BEGIN;

ALTER TABLE execution_profiles
  ADD COLUMN token_config  JSONB,
  ADD COLUMN extra_headers JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN execution_profiles.token_config IS
  'How a token is obtained and where it is placed (storage key, cookie, header). References secrets by name; never contains a credential.';

COMMENT ON COLUMN execution_profiles.extra_headers IS
  'Headers added to every request this profile browser makes. A value may reference a secret by name instead of being literal.';

COMMIT;
