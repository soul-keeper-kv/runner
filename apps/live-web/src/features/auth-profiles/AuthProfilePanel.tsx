import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  runnerApi,
  RunnerApiError,
  type AuthProfile,
  type AuthStrategy,
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

const NEW_PROFILE: {
  ref: string;
  displayName: string;
  strategy: AuthStrategy;
  loginUrl: string;
  submitIntent: string;
  fields: FieldDraft[];
} = {
  ref: '',
  displayName: '',
  strategy: 'FORM_LOGIN',
  loginUrl: '',
  submitIntent: 'Log in',
  fields: [
    { key: 'username', intent: '', value: '' },
    { key: 'password', intent: '', value: '' },
  ],
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

      return runnerApi.saveAuthProfile(workspaceRef, draft.ref.trim(), {
        displayName: draft.displayName.trim().length > 0 ? draft.displayName.trim() : draft.ref,
        strategy: draft.strategy,
        ...(draft.loginUrl.trim().length > 0 ? { loginUrl: draft.loginUrl.trim() } : {}),
        formFields,
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

      <div className="field">
        <label htmlFor="ap-submit">Submit control</label>
        <input
          id="ap-submit"
          value={draft.submitIntent}
          placeholder="Log in"
          onChange={(event) => setDraft({ ...draft, submitIntent: event.target.value })}
        />
      </div>

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
}

function describe(cause: unknown): string {
  if (cause instanceof RunnerApiError) {
    return `${cause.error.code}: ${cause.error.message}`;
  }
  return cause instanceof Error ? cause.message : 'Something went wrong.';
}
