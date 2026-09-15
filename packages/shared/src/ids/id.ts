import { randomUUID } from 'node:crypto';

/**
 * Prefixed, sortable-ish identifiers.
 *
 * Prefixes make IDs self-describing in logs, timelines and error payloads —
 * `el_...` is unmistakably a registry element, `run_...` an execution.
 */
export const ID_PREFIXES = {
  execution: 'run',
  inspection: 'insp',
  step: 'step',
  liveSession: 'ls',
  browserSession: 'bs',
  command: 'cmd',
  event: 'evt',
  element: 'el',
  page: 'pg',
  component: 'cmp',
  revision: 'rev',
  modification: 'mod',
  snapshot: 'snap',
  artifact: 'art',
  runtime: 'rt',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

/** Generates a new prefixed ID, e.g. `run_9f2c4a1b8d3e4f60`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function newExecutionId(): string {
  return newId(ID_PREFIXES.execution);
}

export function newInspectionId(): string {
  return newId(ID_PREFIXES.inspection);
}

export function newLiveSessionId(): string {
  return newId(ID_PREFIXES.liveSession);
}

export function newElementId(): string {
  return newId(ID_PREFIXES.element);
}

export function newCommandId(): string {
  return newId(ID_PREFIXES.command);
}

export function newEventId(): string {
  return newId(ID_PREFIXES.event);
}

export function newRuntimeId(): string {
  return newId(ID_PREFIXES.runtime);
}

export function hasPrefix(id: string, prefix: IdPrefix): boolean {
  return id.startsWith(`${prefix}_`);
}

/**
 * Normalizes arbitrary human text into a code-safe identifier.
 *
 * Blueprint section 46: generated code identifiers must never be derived from
 * raw user text. `Create Customer Button` becomes `createCustomerButton`.
 */
export function toSystemName(displayName: string): string {
  const words = displayName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (words.length === 0) return 'unnamedElement';

  const [first, ...rest] = words as [string, ...string[]];
  const head = first.toLowerCase();
  const tail = rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  const candidate = [head, ...tail].join('');

  // A leading digit would be invalid as a TypeScript identifier.
  return /^[0-9]/.test(candidate) ? `el${candidate.charAt(0).toUpperCase()}${candidate.slice(1)}` : candidate;
}
