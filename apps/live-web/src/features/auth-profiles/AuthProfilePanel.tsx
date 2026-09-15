import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  runnerApi,
  RunnerApiError,
  type AuthProfile,
  type AuthStrategy,
  type TokenPlacement,
} from '../../lib/runner-api.js';

/**
 * Managing auth profiles.
 *
 * Why this panel exists: a profile used to live only in the worker's
 * environment, so reaching a new application meant editing a variable and
 * restarting a process — and a user could not discover which profiles existed.
 * They typed a name and learned it was wrong from a failed login.
 *
 * What it will not do: show a stored credential. The Runner never returns one,
 * so a set password renders as "set" and changing it means typing a new value.
 * That is the property that makes editing profiles from a browser acceptable at
 * all — the value travels inward, is sealed, and stops there.
 */

const STRATEGIES: readonly AuthStrategy[] = [
  'FORM_LOGIN',
  'STORAGE_STATE',
  'API_TOKEN',
  'COOKIE',
  'OAUTH',
  'SSO',
];

/** One row of the login form being described. */
interface FieldDraft {
  /** The credential key, e.g. `username`. Also the secret's name. */
  key: string;
  /** How the element is named on the page, e.g. `USERNAME *`. */
  intent: string;
  /** Left blank on an existing profile to keep whatever is stored. */
  value: string;
}

/** One header the profile sends with every request. */
interface HeaderDraft {
  name: string;
  value: string;
  /** Names a credential instead of holding one, so the value stays sealed. */
  secretRef: string;
}

/**
 * Where the token goes.
 *
 * Kept as a flat draft rather than the discriminated union the contract uses,
 * because a form is edited field by field: a user switching from a header to a
 * storage key should not lose what they typed.
 */
interface PlacementDraft {
  kind: 'header' | 'localStorage' | 'sessionStorage' | 'cookie';
  /** Header or cookie name. */
  name: string;
  /** Header value prefix. */
  prefix: string;
  /** Storage key. */
  key: string;
  /** JSON envelope with a {{token}} placeholder. */
  jsonTemplate: string;
}

interface ProfileDraft {
  ref: string;
  displayName: string;
  strategy: AuthStrategy;
  loginUrl: string;
  submitIntent: string;
  fields: FieldDraft[];
  headers: HeaderDraft[];
  /** `static` takes a token from the credentials above; `apiLogin` fetches one. */
  tokenKind: 'static' | 'apiLogin';
  tokenSecretRef: string;
  /**
   * The token itself, for a `static` source.
   *
   * Entered here rather than as a credential field elsewhere: asking only which
   * field held it sent a real JWT into the header *prefix* box instead, which
   * stored `Bearer eyJ…` as a literal prefix and left the secret empty.
   */
  tokenValue: string;
  tokenLoginUrl: string;
  tokenBodyTemplate: string;
  tokenPath: string;
  placements: PlacementDraft[];
}

const NEW_PLACEMENT: PlacementDraft = {
  kind: 'header',
  name: '',
  prefix: 'Bearer ',
  key: '',
  jsonTemplate: '',
};

const NEW_PROFILE: ProfileDraft = {
  ref: '',
  displayName: '',
  strategy: 'FORM_LOGIN',
  loginUrl: '',
  submitIntent: 'Log in',
  fields: [
    { key: 'username', intent: '', value: '' },
    { key: 'password', intent: '', value: '' },
  ],
  headers: [],
  tokenKind: 'static',
  tokenSecretRef: 'token',
  tokenValue: '',
  tokenLoginUrl: '',
  tokenBodyTemplate: '{"username":"{{username}}","password":"{{password}}"}',
  tokenPath: 'data.access_token',
  placements: [NEW_PLACEMENT],
};

export function AuthProfilePanel(): JSX.Element {
  const [workspaceRef, setWorkspaceRef] = useState('workspace_demo');
  const [draft, setDraft] = useState(NEW_PROFILE);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const queryClient = useQueryClient();

  const profiles = useQuery({
    queryKey: ['auth-profiles', workspaceRef],
    queryFn: () => runnerApi.listAuthProfiles(workspaceRef),
    retry: false,
  });

  const usesToken = draft.strategy === 'API_TOKEN';

  const save = useMutation({
    mutationFn: () => {
      const formFields: Record<string, string> = {};
      const secrets: Record<string, string> = {};

      for (const field of draft.fields) {
        if (field.key.trim().length === 0) continue;
        if (field.intent.trim().length > 0) formFields[field.key] = field.intent.trim();
        // Only send what was typed: an untouched password field must not clear
        // the credential already stored.
        if (field.value.length > 0) secrets[field.key] = field.value;
      }
      if (draft.submitIntent.trim().length > 0) formFields.submit = draft.submitIntent.trim();

      // A header value typed here is a credential like any other, so it is
      // sent as a secret and referenced by name rather than stored literally.
      const extraHeaders = draft.headers
        .filter((header) => header.name.trim().length > 0)
        .map((header) => {
          const name = header.name.trim();
          if (header.secretRef.trim().length > 0) {
            const ref = header.secretRef.trim();
            if (header.value.length > 0) secrets[ref] = header.value;
            return { name, secretRef: ref };
          }
          return { name, value: header.value };
        });

      return runnerApi.saveAuthProfile(workspaceRef, draft.ref.trim(), {
        displayName: draft.displayName.trim().length > 0 ? draft.displayName.trim() : draft.ref,
        strategy: draft.strategy,
        ...(draft.loginUrl.trim().length > 0 ? { loginUrl: draft.loginUrl.trim() } : {}),
        formFields,
        ...(extraHeaders.length > 0 ? { extraHeaders } : {}),
        // Only for a token strategy: sending a token configuration with a
        // FORM_LOGIN profile would store one a later reader could mistake for
        // deliberate.
        ...(usesToken
          ? {
              tokenSource: tokenSourceOf(draft),
              tokenPlacements: placementsOf(draft),
            }
          : {}),
        // A pasted token is a credential like any other, so it is sent as a
        // secret under the name the source references. Only when typed: an
        // untouched field must not clear the token already stored.
        ...(usesToken && draft.tokenKind === 'static' && draft.tokenValue.length > 0
          ? {
              secrets: {
                ...secrets,
                [draft.tokenSecretRef.trim() || 'token']: draft.tokenValue,
              },
            }
          : {}),
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      });
    },
    onSuccess: (profile) => {
      setNotice(`Saved ${profile.ref}.`);
      setDraft(NEW_PROFILE);
      setEditing(undefined);
      void queryClient.invalidateQueries({ queryKey: ['auth-profiles', workspaceRef] });
    },
    onError: (cause) => setNotice(describe(cause)),
  });

  const remove = useMutation({
    mutationFn: (ref: string) => runnerApi.deleteAuthProfile(workspaceRef, ref),
    onSuccess: () => {
      setNotice(undefined);
      void queryClient.invalidateQueries({ queryKey: ['auth-profiles', workspaceRef] });
    },
    onError: (cause) => setNotice(describe(cause)),
  });

  /** Loads a profile into the form. Credentials stay blank — they never leave. */
  const edit = (profile: AuthProfile): void => {
    const entries = Object.entries(profile.formFields).filter(([key]) => key !== 'submit');

    const source = profile.tokenSource;

    setDraft({
      ref: profile.ref,
      displayName: profile.displayName,
      strategy: profile.strategy,
      loginUrl: profile.loginUrl ?? '',
      submitIntent: profile.formFields.submit ?? '',
      fields:
        entries.length > 0
          ? entries.map(([key, intent]) => ({ key, intent, value: '' }))
          : NEW_PROFILE.fields,
      // A header's value comes back only when it was literal; one naming a
      // secret shows its reference, and the value stays where it was sealed.
      headers: (profile.extraHeaders ?? []).map((header) => ({
        name: header.name,
        value: header.value ?? '',
        secretRef: header.secretRef ?? '',
      })),
      tokenKind: source?.kind ?? NEW_PROFILE.tokenKind,
      tokenSecretRef:
        source?.kind === 'static' ? source.secretRef : NEW_PROFILE.tokenSecretRef,
      // Left blank deliberately: the Runner never returns a stored token, so an
      // empty field here means "keep the one you have".
      tokenValue: '',
      tokenLoginUrl: source?.kind === 'apiLogin' ? source.url : '',
      tokenBodyTemplate:
        source?.kind === 'apiLogin'
          ? (source.bodyTemplate ?? '')
          : NEW_PROFILE.tokenBodyTemplate,
      tokenPath: source?.kind === 'apiLogin' ? source.tokenPath : NEW_PROFILE.tokenPath,
      placements:
        profile.tokenPlacements === undefined || profile.tokenPlacements.length === 0
          ? NEW_PROFILE.placements
          : profile.tokenPlacements.map((placement) => ({
              kind: placement.kind,
              name: 'name' in placement ? (placement.name ?? '') : '',
              prefix: 'prefix' in placement ? (placement.prefix ?? '') : 'Bearer ',
              key: 'key' in placement ? placement.key : '',
              jsonTemplate:
                'jsonTemplate' in placement ? (placement.jsonTemplate ?? '') : '',
            })),
    });
    setEditing(profile.ref);
    setNotice(`Editing ${profile.ref}. Leave a credential blank to keep the stored one.`);
  };

  const unavailable =
    profiles.error instanceof RunnerApiError &&
    profiles.error.error.code === 'CAPABILITY_NOT_IMPLEMENTED';

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Auth Profiles</h2>
        <span className="muted small">{profiles.data?.profiles.length ?? 0} stored</span>
      </header>

      <div className="field">
        <label htmlFor="ap-workspace">Workspace reference</label>
        <input
          id="ap-workspace"
          value={workspaceRef}
          onChange={(event) => setWorkspaceRef(event.target.value)}
        />
      </div>

      {unavailable ? (
        <p className="warn">
          {profiles.error instanceof RunnerApiError ? profiles.error.error.message : ''} Until then,
          declare profiles in the worker&apos;s <code>RUNNER_AUTH_PROFILES</code>.
        </p>
      ) : profiles.error !== null ? (
        <p className="warn">{describe(profiles.error)}</p>
      ) : (
        <ul className="profile-list">
          {(profiles.data?.profiles ?? []).map((profile) => (
            <li key={profile.ref}>
              <div className="profile-head">
                <code>{profile.ref}</code>
                <span className="muted small">{profile.strategy}</span>
              </div>
              <span className="feature-description">{profile.loginUrl ?? '—'}</span>
              <div className="profile-secrets">
                {Object.keys(profile.formFields)
                  .filter((key) => key !== 'submit')
                  .map((key) => {
                    const stored = profile.secretsPresent.includes(key);
                    const external = profile.secretRefs[key];
                    return (
                      <span
                        key={key}
                        className={`badge ${stored || external !== undefined ? 'badge-available' : 'badge-disabled'}`}
                        title={
                          external !== undefined
                            ? `resolved from the environment variable ${external}`
                            : stored
                              ? 'stored, encrypted'
                              : 'not set'
                        }
                      >
                        {key}: {external !== undefined ? 'env' : stored ? 'set' : 'missing'}
                      </span>
                    );
                  })}
              </div>
              <div className="button-row">
                <button type="button" onClick={() => edit(profile)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => remove.mutate(profile.ref)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 className="small">{editing === undefined ? 'New profile' : `Edit ${editing}`}</h3>

      <div className="field">
        <label htmlFor="ap-ref">Profile reference</label>
        <input
          id="ap-ref"
          value={draft.ref}
          placeholder="CARIS"
          onChange={(event) => setDraft({ ...draft, ref: event.target.value })}
        />
        <span className="muted">
          The name a live session and Test IR use. Immutable in practice — renaming it makes a new
          profile.
        </span>
      </div>

      <div className="field">
        <label htmlFor="ap-strategy">Strategy</label>
        <select
          id="ap-strategy"
          value={draft.strategy}
          onChange={(event) =>
            setDraft({ ...draft, strategy: event.target.value as AuthStrategy })
          }
        >
          {STRATEGIES.map((strategy) => (
            <option key={strategy} value={strategy}>
              {strategy}
            </option>
          ))}
        </select>
        <span className="muted">
          Only FORM_LOGIN and STORAGE_STATE are implemented; the others are accepted and report
          CAPABILITY_NOT_IMPLEMENTED at login time rather than pretending to work.
        </span>
      </div>

      <div className="field">
        <label htmlFor="ap-login-url">Login URL</label>
        <input
          id="ap-login-url"
          value={draft.loginUrl}
          placeholder="https://app.example.com/login/"
          onChange={(event) => setDraft({ ...draft, loginUrl: event.target.value })}
        />
      </div>

      {draft.fields.map((field, index) => (
        <div className="field" key={index}>
          <label htmlFor={`ap-field-${index}`}>{field.key || 'field'}</label>
          <div className="profile-field-row">
            <input
              id={`ap-field-${index}`}
              value={field.key}
              placeholder="username"
              onChange={(event) => updateField(index, { key: event.target.value })}
            />
            <input
              value={field.intent}
              placeholder="USERNAME *"
              onChange={(event) => updateField(index, { intent: event.target.value })}
            />
            <input
              type="password"
              value={field.value}
              placeholder={editing === undefined ? 'value' : 'unchanged'}
              autoComplete="new-password"
              onChange={(event) => updateField(index, { value: event.target.value })}
            />
          </div>
          <span className="muted">
            Credential key, then how the field is named on the page, then its value. The middle one
            is an accessible name — the Runner resolves it with the same locator engine every other
            target uses, so no selector goes here.
          </span>
        </div>
      ))}

      <div className="button-row">
        <button
          type="button"
          onClick={() =>
            setDraft({ ...draft, fields: [...draft.fields, { key: '', intent: '', value: '' }] })
          }
        >
          Add field
        </button>
      </div>

      {!usesToken && (
        <div className="field">
          <label htmlFor="ap-submit">Submit control</label>
          <input
            id="ap-submit"
            value={draft.submitIntent}
            placeholder="Log in"
            onChange={(event) => setDraft({ ...draft, submitIntent: event.target.value })}
          />
        </div>
      )}

      {usesToken && (
        <>
          <h4 className="small">Where the token comes from</h4>

          <div className="field">
            <label htmlFor="ap-token-kind">Source</label>
            <select
              id="ap-token-kind"
              value={draft.tokenKind}
              onChange={(event) =>
                setDraft({ ...draft, tokenKind: event.target.value as 'static' | 'apiLogin' })
              }
            >
              <option value="static">A token I paste in</option>
              <option value="apiLogin">Exchange credentials at a login endpoint</option>
            </select>
          </div>

          {draft.tokenKind === 'static' ? (
            /*
             * The token is entered *here*, not as a credential field above.
             *
             * An earlier version only asked which field held it, and left the
             * user to add that field themselves in another section. Nobody
             * guessed that, so a real JWT ended up pasted into the header
             * *prefix* box instead — which stored `Bearer eyJ…` as a literal
             * prefix and left the token secret empty, failing with "names token
             * secret but it resolved to nothing".
             */
            <div className="field">
              <label htmlFor="ap-token-value">Token</label>
              <input
                id="ap-token-value"
                type="password"
                autoComplete="new-password"
                value={draft.tokenValue}
                placeholder={editing === undefined ? 'paste the token' : 'unchanged'}
                onChange={(event) => setDraft({ ...draft, tokenValue: event.target.value })}
              />
              <span className="muted">
                Sealed like a password; the Runner never returns it. Paste the token only — the
                <code> Bearer </code> scheme belongs in the placement below. A token expires, so
                an endpoint exchange survives longer unattended.
              </span>
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="ap-token-url">Login endpoint</label>
                <input
                  id="ap-token-url"
                  value={draft.tokenLoginUrl}
                  placeholder="https://app.example.com/api/auth/login"
                  onChange={(event) => setDraft({ ...draft, tokenLoginUrl: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="ap-token-body">Request body</label>
                <textarea
                  id="ap-token-body"
                  rows={3}
                  value={draft.tokenBodyTemplate}
                  onChange={(event) =>
                    setDraft({ ...draft, tokenBodyTemplate: event.target.value })
                  }
                />
                <span className="muted">
                  <code>{'{{fieldName}}'}</code> is replaced with that credential, escaped, on the
                  worker. The credential never reaches this page.
                </span>
              </div>
              <div className="field">
                <label htmlFor="ap-token-path">Path to the token in the response</label>
                <input
                  id="ap-token-path"
                  value={draft.tokenPath}
                  placeholder="data.access_token"
                  onChange={(event) => setDraft({ ...draft, tokenPath: event.target.value })}
                />
                <span className="muted">
                  Required, and never guessed: whichever string looks like a JWT is a refresh
                  token about as often as an access token.
                </span>
              </div>
            </>
          )}

          <h4 className="small">Where the token goes</h4>
          {draft.placements.map((placement, index) => (
            <div className="field" key={index}>
              <div className="profile-field-row">
                <select
                  value={placement.kind}
                  onChange={(event) =>
                    updatePlacement(index, {
                      kind: event.target.value as PlacementDraft['kind'],
                    })
                  }
                >
                  <option value="header">Request header</option>
                  <option value="localStorage">localStorage</option>
                  <option value="sessionStorage">sessionStorage</option>
                  <option value="cookie">Cookie</option>
                </select>

                {placement.kind === 'header' ? (
                  <>
                    <input
                      value={placement.name}
                      placeholder="header name — Authorization"
                      onChange={(event) => updatePlacement(index, { name: event.target.value })}
                    />
                    <input
                      value={placement.prefix}
                      // Labelled as a scheme, not an empty box: an unlabelled
                      // field beside a header name reads as "the value", and a
                      // whole JWT was pasted here once.
                      placeholder="scheme only — Bearer "
                      onChange={(event) => updatePlacement(index, { prefix: event.target.value })}
                    />
                  </>
                ) : placement.kind === 'cookie' ? (
                  <input
                    value={placement.name}
                    placeholder="session"
                    onChange={(event) => updatePlacement(index, { name: event.target.value })}
                  />
                ) : (
                  <>
                    <input
                      value={placement.key}
                      placeholder="access_token"
                      onChange={(event) => updatePlacement(index, { key: event.target.value })}
                    />
                    <input
                      value={placement.jsonTemplate}
                      placeholder={'{"state":{"token":"{{token}}"}}'}
                      onChange={(event) =>
                        updatePlacement(index, { jsonTemplate: event.target.value })
                      }
                    />
                  </>
                )}
              </div>
              {placement.kind === 'header' && looksLikeAToken(placement.prefix) && (
                <span className="warn-inline">
                  That prefix looks like a token. Only the scheme belongs here —{' '}
                  <code>Bearer </code> — and the token itself goes in the Token field above.
                </span>
              )}
              {placement.kind !== 'header' && placement.kind !== 'cookie' && (
                <span className="muted">
                  Storage key, then the JSON envelope the app keeps, with{' '}
                  <code>{'{{token}}'}</code> where the token belongs. Copy the shape from the
                  running app rather than guessing: an envelope missing a flag the app checks
                  leaves it redirecting to its login page while the Runner reports success.
                </span>
              )}
            </div>
          ))}

          <div className="button-row">
            <button
              type="button"
              onClick={() =>
                setDraft({ ...draft, placements: [...draft.placements, NEW_PLACEMENT] })
              }
            >
              Add placement
            </button>
            {draft.placements.length > 1 && (
              <button
                type="button"
                onClick={() => setDraft({ ...draft, placements: draft.placements.slice(0, -1) })}
              >
                Remove last
              </button>
            )}
          </div>
        </>
      )}

      <h4 className="small">Extra request headers</h4>
      {draft.headers.map((header, index) => (
        <div className="field" key={index}>
          <div className="profile-field-row">
            <input
              value={header.name}
              placeholder="X-Tenant"
              onChange={(event) => updateHeader(index, { name: event.target.value })}
            />
            <input
              value={header.secretRef}
              placeholder="(secret name, optional)"
              onChange={(event) => updateHeader(index, { secretRef: event.target.value })}
            />
            <input
              type={header.secretRef.trim().length > 0 ? 'password' : 'text'}
              value={header.value}
              placeholder={
                header.secretRef.trim().length > 0 && editing !== undefined ? 'unchanged' : 'value'
              }
              onChange={(event) => updateHeader(index, { value: event.target.value })}
            />
          </div>
        </div>
      ))}

      <div className="button-row">
        <button
          type="button"
          onClick={() =>
            setDraft({
              ...draft,
              headers: [...draft.headers, { name: '', value: '', secretRef: '' }],
            })
          }
        >
          Add header
        </button>
      </div>
      <span className="muted">
        Sent with every request this profile&apos;s browser makes — useful for a tenant id or an
        API version. Give a secret name to store the value sealed instead of literally. A browser
        sends these to <em>every</em> origin the page reaches, including third parties, so a
        credential here is trusted to all of them.
      </span>

      <div className="button-row">
        <button
          type="button"
          className="primary"
          disabled={draft.ref.trim().length === 0 || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : editing === undefined ? 'Create profile' : 'Save changes'}
        </button>
        {editing !== undefined && (
          <button
            type="button"
            onClick={() => {
              setDraft(NEW_PROFILE);
              setEditing(undefined);
              setNotice(undefined);
            }}
          >
            Cancel
          </button>
        )}
      </div>

      {notice !== undefined && <p className="muted small">{notice}</p>}
    </section>
  );

  function updateField(index: number, patch: Partial<FieldDraft>): void {
    const fields = draft.fields.map((field, i) => (i === index ? { ...field, ...patch } : field));
    setDraft({ ...draft, fields });
  }

  function updateHeader(index: number, patch: Partial<HeaderDraft>): void {
    const headers = draft.headers.map((header, i) =>
      i === index ? { ...header, ...patch } : header,
    );
    setDraft({ ...draft, headers });
  }

  function updatePlacement(index: number, patch: Partial<PlacementDraft>): void {
    const placements = draft.placements.map((placement, i) =>
      i === index ? { ...placement, ...patch } : placement,
    );
    setDraft({ ...draft, placements });
  }
}

/**
 * The token source as the contract expects it.
 *
 * Built from the flat draft rather than edited as a union, so switching between
 * a stored token and a login endpoint does not discard what the user typed for
 * the other one.
 */
function tokenSourceOf(draft: ProfileDraft): NonNullable<AuthProfile['tokenSource']> {
  if (draft.tokenKind === 'static') {
    return { kind: 'static', secretRef: draft.tokenSecretRef.trim() || 'token' };
  }

  return {
    kind: 'apiLogin',
    url: draft.tokenLoginUrl.trim(),
    ...(draft.tokenBodyTemplate.trim().length > 0
      ? { bodyTemplate: draft.tokenBodyTemplate }
      : {}),
    tokenPath: draft.tokenPath.trim(),
  };
}

/**
 * Drops the fields that do not apply to each placement kind.
 *
 * The callback's return type is annotated rather than inferred: each branch
 * produces a differently shaped object, and TypeScript widens them to a union
 * of arrays instead of an array of the union.
 */
function placementsOf(draft: ProfileDraft): TokenPlacement[] {
  return draft.placements.flatMap((placement): TokenPlacement[] => {
    switch (placement.kind) {
      case 'header':
        return [
          {
            kind: 'header' as const,
            ...(placement.name.trim().length > 0 ? { name: placement.name.trim() } : {}),
            // An empty prefix is meaningful — a raw token with no `Bearer ` —
            // so it is sent whenever the field differs from the default.
            ...(placement.prefix !== 'Bearer ' ? { prefix: placement.prefix } : {}),
          },
        ];

      case 'localStorage':
      case 'sessionStorage': {
        if (placement.key.trim().length === 0) return [];
        return [
          {
            kind: placement.kind,
            key: placement.key.trim(),
            ...(placement.jsonTemplate.trim().length > 0
              ? { jsonTemplate: placement.jsonTemplate }
              : {}),
          },
        ];
      }

      case 'cookie': {
        if (placement.name.trim().length === 0) return [];
        return [{ kind: 'cookie' as const, name: placement.name.trim() }];
      }

      default:
        return [];
    }
  });
}

/**
 * Does this look like someone pasted a token where a scheme belongs?
 *
 * Deliberately a hint rather than a validation: an unusual scheme is legal, and
 * refusing one would be worse than a warning. But a long dotted string in the
 * prefix box is almost always the mistake this catches — it happened, and the
 * failure surfaced as "names token secret but it resolved to nothing".
 */
function looksLikeAToken(prefix: string): boolean {
  const value = prefix.trim();
  return value.length > 24 || value.split('.').length >= 3;
}

function describe(cause: unknown): string {
  if (cause instanceof RunnerApiError) {
    return `${cause.error.code}: ${cause.error.message}`;
  }
  return cause instanceof Error ? cause.message : 'Something went wrong.';
}
