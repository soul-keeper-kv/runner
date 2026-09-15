-- Runner Service initial schema (blueprint section 51).
--
-- Scope rule: this database holds what the Runner *owns* — the Registry, runs,
-- revisions, live sessions and evidence. It holds no authored test cases and no
-- copy of another service's domain model. References to external systems are
-- stored as opaque text (`tenant_ref`, `workspace_ref`, `external_test_case_ref`)
-- precisely so the Runner never needs to understand the caller's database.
--
-- Selector definitions are JSONB rather than normalized columns: they are a
-- tagged union that will grow new strategies, and querying inside one is rare
-- compared with reading it whole (blueprint 51, "do not over-normalize").

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- External references and execution profiles
-- ---------------------------------------------------------------------------

CREATE TABLE external_workspaces (
  workspace_ref     TEXT PRIMARY KEY,
  tenant_ref        TEXT,
  display_name      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE external_workspaces IS
  'Opaque workspace identities owned by the calling service. The Runner stores them only to scope its own data.';

CREATE TABLE environments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_ref     TEXT NOT NULL REFERENCES external_workspaces(workspace_ref) ON DELETE CASCADE,
  environment_ref   TEXT NOT NULL,
  base_url          TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_ref, environment_ref)
);

CREATE TABLE execution_profiles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_ref     TEXT NOT NULL REFERENCES external_workspaces(workspace_ref) ON DELETE CASCADE,
  profile_ref       TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  strategy          TEXT NOT NULL
                      CHECK (strategy IN ('FORM_LOGIN','API_TOKEN','COOKIE','STORAGE_STATE','OAUTH','SSO')),
  login_url         TEXT,
  form_fields       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_ref, profile_ref)
);

-- Only *references* to secrets are stored. A password never reaches this
-- database, and never reaches Test IR (blueprint section 50).
CREATE TABLE secret_references (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id        UUID NOT NULL REFERENCES execution_profiles(id) ON DELETE CASCADE,
  secret_key        TEXT NOT NULL,
  secret_ref        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id, secret_key)
);

COMMENT ON TABLE secret_references IS
  'Opaque pointers into an external secret store. Plaintext credentials must never be written here.';

-- ---------------------------------------------------------------------------
-- Registry: pages, components, elements
-- ---------------------------------------------------------------------------

CREATE TABLE pages (
  id                TEXT PRIMARY KEY,
  workspace_ref     TEXT NOT NULL REFERENCES external_workspaces(workspace_ref) ON DELETE CASCADE,
  application_id    TEXT,
  display_name      TEXT NOT NULL,
  description       TEXT,
  url_patterns      JSONB NOT NULL DEFAULT '[]'::jsonb,
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX pages_workspace_idx ON pages (workspace_ref);

CREATE TABLE components (
  id                TEXT PRIMARY KEY,
  workspace_ref     TEXT NOT NULL REFERENCES external_workspaces(workspace_ref) ON DELETE CASCADE,
  page_id           TEXT REFERENCES pages(id) ON DELETE SET NULL,
  display_name      TEXT NOT NULL,
  description       TEXT,
  root_selector     JSONB,
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX components_workspace_idx ON components (workspace_ref);
CREATE INDEX components_page_idx ON components (page_id);

CREATE TABLE elements (
  -- The stable identity Test IR references. Immutable for the element's life:
  -- renaming must never invalidate previously generated IR (blueprint 17.2).
  id                  TEXT PRIMARY KEY,
  workspace_ref       TEXT NOT NULL REFERENCES external_workspaces(workspace_ref) ON DELETE CASCADE,
  application_id      TEXT,
  page_id             TEXT REFERENCES pages(id) ON DELETE SET NULL,
  component_id        TEXT REFERENCES components(id) ON DELETE SET NULL,

  system_name         TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  description         TEXT,
  display_name_source TEXT NOT NULL DEFAULT 'AI'
                        CHECK (display_name_source IN ('USER','AI','UI_TEXT','HISTORY','RECORDER')),

  semantic_type       TEXT,
  role                TEXT,
  tags                JSONB NOT NULL DEFAULT '[]'::jsonb,

  primary_selector    JSONB NOT NULL,
  scoped_selector     JSONB,
  available_when      JSONB NOT NULL DEFAULT '[]'::jsonb,

  user_confirmed      BOOLEAN NOT NULL DEFAULT FALSE,
  confidence          REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),

  revision            INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX elements_workspace_idx ON elements (workspace_ref);
CREATE INDEX elements_page_idx ON elements (page_id);
CREATE INDEX elements_component_idx ON elements (component_id);

-- Resolution by user-defined name is a primary lookup path, so it is indexed
-- case-insensitively rather than scanned (blueprint 16, resolution order).
CREATE INDEX elements_display_name_idx ON elements (workspace_ref, lower(display_name));
CREATE UNIQUE INDEX elements_system_name_idx ON elements (workspace_ref, system_name);

CREATE TABLE element_aliases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  element_id        TEXT NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
  value             TEXT NOT NULL,
  source            TEXT NOT NULL
                      CHECK (source IN ('USER','AI','UI_TEXT','HISTORY','RECORDER')),
  usage_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (element_id, value)
);

CREATE INDEX element_aliases_value_idx ON element_aliases (lower(value));

COMMENT ON TABLE element_aliases IS
  'Alternative names an element answers to, learned from users, AI suggestions, UI text and past names.';

CREATE TABLE element_selectors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  element_id        TEXT NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
  selector          JSONB NOT NULL,
  score             INTEGER NOT NULL DEFAULT 0,
  is_primary        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Success and failure counts feed the confidence calculation, so a selector
  -- that has proven itself outranks one that merely looks good.
  success_count     INTEGER NOT NULL DEFAULT 0,
  failure_count     INTEGER NOT NULL DEFAULT 0,
  last_validated_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX element_selectors_element_idx ON element_selectors (element_id);

-- ---------------------------------------------------------------------------
-- Registry change control (blueprint sections 35 and 36)
-- ---------------------------------------------------------------------------

CREATE TABLE registry_modifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_ref     TEXT NOT NULL REFERENCES external_workspaces(workspace_ref) ON DELETE CASCADE,
  entity_kind       TEXT NOT NULL CHECK (entity_kind IN ('ELEMENT','PAGE','COMPONENT')),
  entity_id         TEXT,

  type              TEXT NOT NULL CHECK (type IN (
                      'SELECTOR_UPDATE','RENAME','DESCRIPTION_UPDATE','ALIAS_ADD',
                      'ALIAS_REMOVE','ELEMENT_CREATE','ELEMENT_DELETE','AVAILABILITY_UPDATE')),
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','PROPOSED','CONFIRMED','REJECTED')),

  before_value      JSONB,
  after_value       JSONB,

  proposed_by       TEXT NOT NULL CHECK (proposed_by IN ('USER','AI','HEALING','RECORDER','SYSTEM')),
  reason            TEXT,
  live_session_id   TEXT,
  execution_id      TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at        TIMESTAMPTZ,
  decided_by        TEXT
);

CREATE INDEX registry_modifications_pending_idx
  ON registry_modifications (workspace_ref, status)
  WHERE status IN ('DRAFT','PROPOSED');

COMMENT ON TABLE registry_modifications IS
  'Draft-then-commit record for every Registry change. Self-healing writes proposals here, never direct mutations.';

CREATE TABLE registry_revisions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_ref     TEXT NOT NULL REFERENCES external_workspaces(workspace_ref) ON DELETE CASCADE,
  entity_kind       TEXT NOT NULL CHECK (entity_kind IN ('ELEMENT','PAGE','COMPONENT')),
  entity_id         TEXT NOT NULL,
  version           INTEGER NOT NULL,

  changed_by        TEXT NOT NULL CHECK (changed_by IN ('USER','AI','HEALING','RECORDER','SYSTEM')),
  change_type       TEXT NOT NULL,
  modification_id   UUID REFERENCES registry_modifications(id) ON DELETE SET NULL,

  before_value      JSONB,
  after_value       JSONB,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_id, version)
);

CREATE INDEX registry_revisions_entity_idx ON registry_revisions (entity_id, version DESC);

-- ---------------------------------------------------------------------------
-- Executions
-- ---------------------------------------------------------------------------

CREATE TABLE runs (
  id                     TEXT PRIMARY KEY,
  workspace_ref          TEXT NOT NULL REFERENCES external_workspaces(workspace_ref) ON DELETE CASCADE,
  tenant_ref             TEXT,
  external_test_case_ref TEXT,
  request_id             TEXT,
  idempotency_key        TEXT,

  status                 TEXT NOT NULL DEFAULT 'QUEUED'
                           CHECK (status IN ('QUEUED','RUNNING','WAITING_USER','PASSED','FAILED','CANCELLED')),
  mode                   TEXT NOT NULL DEFAULT 'AUTO'
                           CHECK (mode IN ('AUTO','REVIEW','INTERACTIVE')),

  environment_ref        TEXT,
  auth_profile_ref       TEXT,
  error                  JSONB,

  queued_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at             TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ
);

CREATE INDEX runs_workspace_status_idx ON runs (workspace_ref, status);
CREATE INDEX runs_queued_at_idx ON runs (queued_at DESC);

-- Scoped per workspace so two tenants can reuse the same key safely.
CREATE UNIQUE INDEX runs_idempotency_idx
  ON runs (workspace_ref, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The exact submitted payload, kept verbatim so a run is reproducible and
-- auditable. This is explicitly *not* the system of record for authored test
-- cases (blueprint 3.7 and 51).
CREATE TABLE run_ir_snapshots (
  run_id            TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  contract_version  TEXT NOT NULL,
  ir_version        TEXT NOT NULL,
  payload           JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE run_steps (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id           TEXT NOT NULL,
  step_index        INTEGER NOT NULL,
  type              TEXT NOT NULL,
  label             TEXT,

  status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','RUNNING','PASSED','FAILED','SKIPPED','WAITING_USER')),
  attempt           INTEGER NOT NULL DEFAULT 0,

  resolved_element  JSONB,
  evidence          JSONB NOT NULL DEFAULT '[]'::jsonb,
  error             JSONB,
  -- Which Registry revision was in force, so a past run stays explainable even
  -- after the Registry moves on.
  registry_revision INTEGER,

  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  duration_ms       INTEGER,

  UNIQUE (run_id, step_id, attempt)
);

CREATE INDEX run_steps_run_idx ON run_steps (run_id, step_index);

CREATE TABLE run_artifacts (
  id                TEXT PRIMARY KEY,
  run_id            TEXT REFERENCES runs(id) ON DELETE CASCADE,
  session_id        TEXT,
  step_id           TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('screenshot','trace','video','dom-snapshot','log')),
  content_type      TEXT NOT NULL,
  size_bytes        BIGINT NOT NULL,
  storage_url       TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX run_artifacts_run_idx ON run_artifacts (run_id);

CREATE TABLE live_sessions (
  id                TEXT PRIMARY KEY,
  workspace_ref     TEXT NOT NULL REFERENCES external_workspaces(workspace_ref) ON DELETE CASCADE,
  browser_session_id TEXT NOT NULL,
  run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL,

  execution_state   TEXT NOT NULL DEFAULT 'IDLE'
                      CHECK (execution_state IN ('IDLE','RUNNING','PAUSED','WAITING_USER','FAILED','CLOSED')),
  current_step_id   TEXT,
  selected_element_id TEXT,
  revision          INTEGER NOT NULL DEFAULT 0,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ
);

CREATE INDEX live_sessions_workspace_idx ON live_sessions (workspace_ref, execution_state);

CREATE TABLE execution_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            TEXT REFERENCES runs(id) ON DELETE CASCADE,
  session_id        TEXT,
  type              TEXT NOT NULL,
  -- Monotonic per run so a consumer can detect a dropped event.
  sequence          INTEGER NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX execution_events_run_idx ON execution_events (run_id, sequence);

CREATE TABLE webhook_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  url               TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  attempt           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','DELIVERED','FAILED')),
  response_status   INTEGER,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ
);

-- A failed callback must be visible rather than silently lost.
CREATE INDEX webhook_deliveries_pending_idx
  ON webhook_deliveries (status, created_at)
  WHERE status <> 'DELIVERED';

COMMIT;
