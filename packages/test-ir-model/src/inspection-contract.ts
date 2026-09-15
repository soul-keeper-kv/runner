/**
 * The public page-inspection contract, version `runner.inspection.v1`
 * (blueprint sections 10 and 52).
 *
 * This is the one entry point that needs no Test IR. A caller that has only a
 * URL — a Test Authoring service about to write its first step, or a form-fill
 * integration that does not yet know what the page contains — submits the URL
 * and receives the page's input fields and its submit control, each already
 * carrying a ranked selector.
 *
 * It is deliberately *not* an execution: nothing is clicked, filled or
 * asserted, so there is no verdict and no timeline. The Runner reads the page
 * and reports what it found.
 */

export const INSPECTION_CONTRACT_VERSION = 'runner.inspection.v1' as const;
export type InspectionContractVersion = typeof INSPECTION_CONTRACT_VERSION;

export const INSPECTION_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

export const TERMINAL_INSPECTION_STATUSES: readonly InspectionStatus[] = ['COMPLETED', 'FAILED'];

export function isTerminalInspectionStatus(status: InspectionStatus): boolean {
  return TERMINAL_INSPECTION_STATUSES.includes(status);
}

export interface InspectionOptionsV1 {
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Passed to navigation; `networkidle` suits pages that render client-side. */
  readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  /** Settle time after navigation, for late-rendering widgets. */
  readonly waitForMs?: number;
  readonly defaultTimeoutMs?: number;
  /**
   * Also report controls that are not inputs — links, tabs, menu items.
   * Off by default: the common request is "what do I have to fill in?".
   */
  readonly includeNonInputControls?: boolean;
}

export interface InspectionRequestV1 {
  readonly contractVersion: InspectionContractVersion;
  /** Caller-side correlation id, echoed in the result. */
  readonly requestId?: string;

  readonly tenantRef?: string;
  readonly workspaceRef: string;

  readonly url: string;
  /** Reuses a stored authenticated session; credentials are never inlined. */
  readonly authProfileRef?: string;
  readonly options?: InspectionOptionsV1;
}

/** The 202 response body returned by POST /api/v1/inspections. */
export interface InspectionAcceptedV1 {
  readonly inspectionId: string;
  readonly status: InspectionStatus;
  readonly statusUrl: string;
  readonly requestId?: string;
  readonly acceptedAt: string;
}

/**
 * A selector in the published, structured form.
 *
 * Kept as an open record rather than a tagged union so that adding a selector
 * strategy stays a compatible change for callers (blueprint rule 4: selectors
 * are data, never code).
 */
export interface InspectionSelectorV1 {
  readonly type: string;
  readonly value?: string;
  readonly role?: string;
  readonly name?: string;
  /** 0-100. Higher survives UI change better. */
  readonly score: number;
}

/**
 * One control a caller may need to supply a value for.
 *
 * `name` is what a human would call the field, taken from its label or
 * accessible name — not the `name` attribute, which is reported separately as
 * `fieldName` because it is frequently absent or machine-generated.
 */
export interface InspectionFieldV1 {
  readonly name: string;
  /** The HTML input type, or the ARIA role for non-input controls. */
  readonly type: string;
  readonly fieldName?: string;
  readonly placeholder?: string;
  readonly required: boolean;
  readonly enabled: boolean;
  /** Present for select/radio groups whose choices are enumerable. */
  readonly options?: readonly string[];
  readonly selector: InspectionSelectorV1;
  /** Ranked alternatives, so a caller can heal a broken primary itself. */
  readonly fallbacks: readonly InspectionSelectorV1[];
}

export interface InspectionControlV1 {
  readonly name: string;
  readonly role: string;
  readonly selector: InspectionSelectorV1;
  readonly fallbacks: readonly InspectionSelectorV1[];
}

/**
 * A draft registry entry for one element found on the page.
 *
 * This is the shape Page Object generation consumes: `systemName` is the
 * generated code identifier, `displayName` is what a human calls it, and the
 * selectors are ranked so generated code can fall back without being
 * regenerated.
 *
 * It is a *draft*. Nothing is written to the Registry by an inspection —
 * registry changes go through a confirmed modification, so that the audit
 * trail stays intact.
 */
export interface InspectionElementV1 {
  /** Normalized identifier, safe to emit as code. Never raw user text. */
  readonly systemName: string;
  readonly displayName: string;
  readonly description?: string;
  readonly role: string;
  /** Coarse classification — input, choice, button, link. */
  readonly semanticType?: string;
  /** Other names this element answers to, learned from the page. */
  readonly aliases?: readonly string[];

  readonly interactable: boolean;
  readonly editable: boolean;
  readonly required: boolean;
  readonly enabled: boolean;

  /** Present for value-carrying controls. */
  readonly fieldType?: string;
  readonly fieldName?: string;
  readonly placeholder?: string;

  readonly selector: InspectionSelectorV1;
  readonly fallbacks: readonly InspectionSelectorV1[];
  /** 0..1. Selector strength only: a first sighting has no history. */
  readonly confidence: number;
}

/** A draft page registry entry, identifying the page itself. */
export interface InspectionPageV1 {
  readonly systemName: string;
  readonly displayName: string;
  /** Matched against the current URL to recognize this page again. */
  readonly urlPattern: string;
}

export interface InspectionErrorV1 {
  readonly code: string;
  readonly kind: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export interface InspectionResultV1 {
  readonly inspectionId: string;
  readonly status: InspectionStatus;
  readonly requestId?: string;

  /** The URL finally landed on, which a redirect or SSO hop may change. */
  readonly url: string;
  readonly requestedUrl: string;
  readonly title?: string;

  /** The page itself, as a draft registry entry. */
  readonly page?: InspectionPageV1;
  /**
   * A draft registry entry for every element found — what Page Object
   * generation consumes. Empty while the inspection is QUEUED or RUNNING.
   */
  readonly elements: readonly InspectionElementV1[];

  /** The value-carrying subset of `elements`, as a convenience. */
  readonly fields: readonly InspectionFieldV1[];
  /** The control that most likely submits the form, when one is identifiable. */
  readonly submit?: InspectionControlV1;
  /** Other interactable controls; only populated on request. */
  readonly controls?: readonly InspectionControlV1[];

  readonly error?: InspectionErrorV1;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}
