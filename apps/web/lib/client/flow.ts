/**
 * State machine of the single-page flow (spec section 6):
 *
 *   idle -> previewing -> ready -> creating -> created
 *                           |         |
 *                           v         v
 *                    needs_verification -> requesting_challenge -> awaiting_proof -> verifying -> ready (key stored)
 *
 * The reducer is pure. The claimToken lives only in `verification` here (memory); nothing in
 * this module persists or logs it.
 */
import type {
  CardData,
  CardIcon,
  ChallengeAction,
  LinkView,
  PreviewResponse,
} from '../../../../packages/core/src/api-types';

export type Phase =
  | 'idle'
  | 'previewing'
  | 'ready'
  | 'creating'
  | 'needs_verification'
  | 'requesting_challenge'
  | 'awaiting_proof'
  | 'verifying'
  | 'created';

export interface Verification {
  action: ChallengeAction;
  nonce: string;
  claimToken: string;
  expiresAt: string;
}

export interface FlowError {
  /** Typed code, or 'network' / 'unexpected'. */
  code: string;
  message: string;
  /** Where the UI should show it. */
  scope: 'url' | 'slug' | 'general';
}

export type CleanupStatus = 'pending' | 'running' | 'done' | 'incomplete' | 'unsupported' | 'error';

export interface Cleanup {
  workspace: string;
  removedLinks: number;
  status: CleanupStatus;
  message: string | null;
}

export interface FlowState {
  phase: Phase;
  url: string;
  preview: PreviewResponse | null;
  /**
   * The browser holds an owner key for `preview.workspace` other than the one the preview request
   * carried (none was sent because the URL gave no workspace hint, one for a different
   * workspace, or the stored key changed while the request was in flight). It is a snapshot from
   * the moment the preview loaded: `preview.needsVerification` ignores such a key, so Create may
   * still go through without any proof, and the stepper then does not send the person to Verify.
   */
  keyUntested: boolean;
  slug: string;
  slugTouched: boolean;
  title: string;
  description: string;
  fast: boolean;
  /** Which challenge to request in `needs_verification`. */
  verifyAction: ChallengeAction;
  verification: Verification | null;
  /** Optional page that carries the proof code; empty means the page being linked. */
  proofUrl: string;
  /** Set right after verification: the user must restore the page title before creating. */
  notice: 'verified' | null;
  result: { link: LinkView; keySaved: boolean } | null;
  /** Unfinished or just finished post-rotation sweeps, one per workspace. */
  cleanups: Cleanup[];
  /** The fast-page switch of the created link is being saved. */
  fastSaving: boolean;
  error: FlowError | null;
}

export const initialState: FlowState = {
  phase: 'idle',
  url: '',
  preview: null,
  keyUntested: false,
  slug: '',
  slugTouched: false,
  title: '',
  description: '',
  fast: true,
  verifyAction: 'claim',
  verification: null,
  proofUrl: '',
  notice: null,
  result: null,
  cleanups: [],
  fastSaving: false,
  error: null,
};

export type Action =
  | { type: 'url_changed'; url: string }
  | { type: 'preview_started' }
  | { type: 'preview_loaded'; preview: PreviewResponse; keyUntested: boolean }
  | { type: 'preview_failed'; error: FlowError }
  | { type: 'slug_changed'; slug: string }
  | { type: 'title_changed'; title: string }
  | { type: 'description_changed'; description: string }
  | { type: 'fast_changed'; fast: boolean }
  | { type: 'proof_url_changed'; url: string }
  | { type: 'create_started' }
  | { type: 'create_succeeded'; link: LinkView; keySaved: boolean }
  | { type: 'create_failed'; error: FlowError }
  | { type: 'action_failed'; error: FlowError }
  | { type: 'verification_needed'; action: ChallengeAction; error: FlowError | null }
  | { type: 'challenge_started' }
  | { type: 'challenge_received'; verification: Verification }
  | { type: 'challenge_failed'; error: FlowError; action?: ChallengeAction }
  | { type: 'verify_started' }
  | { type: 'verify_failed'; error: FlowError; restart: boolean }
  | { type: 'verified' }
  | { type: 'cleanup_set'; workspace: string; cleanup: Cleanup | null }
  | { type: 'link_fast_started' }
  | { type: 'link_fast_changed'; workspace: string; slug: string; fast: boolean }
  | { type: 'reset' };

type ActionMap = { [A in Action as A['type']]: A };
type Handlers = { [K in keyof ActionMap]: (state: FlowState, action: ActionMap[K]) => FlowState };

/** Responses of async steps are applied only while the phase that started them is current. */
const handlers: Handlers = {
  url_changed: (state, action) => ({ ...initialState, url: action.url, cleanups: state.cleanups }),
  preview_started: (state) => ({
    ...state,
    phase: 'previewing',
    preview: null,
    keyUntested: false,
    error: null,
    verification: null,
    result: null,
    fastSaving: false,
  }),
  preview_loaded: (state, action) =>
    state.phase !== 'previewing'
      ? state
      : {
          ...state,
          phase: 'ready',
          preview: action.preview,
          keyUntested: action.keyUntested,
          slug: state.slugTouched ? state.slug : action.preview.proposedSlug,
          verifyAction: action.preview.suggestedAction ?? 'claim',
          error: null,
        },
  preview_failed: (state, action) =>
    state.phase !== 'previewing'
      ? state
      : { ...state, phase: 'idle', preview: null, error: action.error },
  slug_changed: (state, action) => ({
    ...state,
    slug: action.slug.toLowerCase(),
    slugTouched: true,
    error: clearScope(state.error, 'slug'),
  }),
  title_changed: (state, action) => ({ ...state, title: action.title }),
  description_changed: (state, action) => ({ ...state, description: action.description }),
  proof_url_changed: (state, action) => ({ ...state, proofUrl: action.url }),
  fast_changed: (state, action) => ({ ...state, fast: action.fast }),
  create_started: (state) => ({ ...state, phase: 'creating', error: null, notice: null }),
  create_succeeded: (state, action) =>
    state.phase !== 'creating'
      ? state
      : {
          ...state,
          phase: 'created',
          verification: null,
          error: null,
          result: { link: action.link, keySaved: action.keySaved },
        },
  create_failed: (state, action) =>
    state.phase !== 'creating' ? state : { ...state, phase: 'ready', error: action.error },
  action_failed: (state, action) => ({ ...state, fastSaving: false, error: action.error }),
  verification_needed: (state, action) => ({
    ...state,
    phase: 'needs_verification',
    verifyAction: action.action,
    verification: null,
    error: action.error,
  }),
  challenge_started: (state) =>
    state.phase !== 'needs_verification'
      ? state
      : { ...state, phase: 'requesting_challenge', error: null },
  challenge_received: (state, action) =>
    state.phase !== 'requesting_challenge'
      ? state
      : { ...state, phase: 'awaiting_proof', verification: action.verification, error: null },
  challenge_failed: (state, action) =>
    state.phase !== 'requesting_challenge'
      ? state
      : {
          ...state,
          phase: 'needs_verification',
          verification: null,
          verifyAction: action.action ?? state.verifyAction,
          error: action.error,
        },
  verify_started: (state) =>
    state.phase !== 'awaiting_proof' ? state : { ...state, phase: 'verifying', error: null },
  // Expired/invalid challenges cannot be retried: drop the token and ask for a new code.
  verify_failed: (state, action) => {
    if (state.phase !== 'verifying') return state;
    return action.restart
      ? { ...state, phase: 'needs_verification', verification: null, error: action.error }
      : { ...state, phase: 'awaiting_proof', error: action.error };
  },
  // The claimToken is spent. Ownership is proven: back to the form, which now has a key.
  verified: (state) =>
    state.phase !== 'verifying' || !state.preview
      ? state
      : {
          ...state,
          phase: 'ready',
          verification: null,
          proofUrl: '',
          notice: 'verified',
          preview: { ...state.preview, needsVerification: false, suggestedAction: null },
          error: null,
        },
  cleanup_set: (state, action) => ({
    ...state,
    cleanups: setCleanup(state.cleanups, action.workspace, action.cleanup),
  }),
  link_fast_started: (state) =>
    state.result ? { ...state, fastSaving: true, error: null } : state,
  link_fast_changed: (state, action) =>
    !state.result ||
    state.result.link.workspace !== action.workspace ||
    state.result.link.slug !== action.slug
      ? state
      : {
          ...state,
          fastSaving: false,
          result: {
            ...state.result,
            link: {
              ...state.result.link,
              fast: action.fast,
              fastUrl: action.fast ? `${state.result.link.redirectUrl}/read` : null,
            },
          },
        },
  reset: (state) => ({ ...initialState, cleanups: state.cleanups }),
};

type AnyHandler = (state: FlowState, action: Action) => FlowState;

export function reducer(state: FlowState, action: Action): FlowState {
  // `handlers` pairs every action type with a handler of exactly that action (checked by the
  // `Handlers` type); TypeScript cannot correlate the lookup, so the pairing is asserted once here.
  const handler = handlers[action.type] as AnyHandler;
  return handler(state, action);
}

function setCleanup(cleanups: Cleanup[], workspace: string, next: Cleanup | null): Cleanup[] {
  const exists = cleanups.some((entry) => entry.workspace === workspace);
  if (next === null) return cleanups.filter((entry) => entry.workspace !== workspace);
  if (!exists) return [...cleanups, next];
  return cleanups.map((entry) => (entry.workspace === workspace ? next : entry));
}

function clearScope(error: FlowError | null, scope: FlowError['scope']): FlowError | null {
  return error && error.scope === scope ? null : error;
}

export function isVerificationPhase(phase: Phase): boolean {
  return (
    phase === 'needs_verification' ||
    phase === 'requesting_challenge' ||
    phase === 'awaiting_proof' ||
    phase === 'verifying'
  );
}

export type PendingAction = 'preview' | 'create' | 'challenge' | 'verify' | 'fast' | 'cleanup';

/**
 * Every request of the flow that is in flight right now. The UI shows a spinner, disables the
 * control that started it and narrates it for screen readers for as long as it is listed here.
 */
export function pendingActions(state: FlowState): PendingAction[] {
  const pending: PendingAction[] = [];
  if (state.phase === 'previewing') pending.push('preview');
  if (state.phase === 'creating') pending.push('create');
  if (state.phase === 'requesting_challenge') pending.push('challenge');
  if (state.phase === 'verifying') pending.push('verify');
  if (state.fastSaving) pending.push('fast');
  if (state.cleanups.some((cleanup) => cleanup.status === 'running')) pending.push('cleanup');
  return pending;
}

/** The card as the created link will show it: overrides win, an empty override falls back. */
export function previewCard(state: FlowState): CardData | null {
  if (!state.preview) return null;
  const { card } = state.preview;
  return {
    ...card,
    title: state.title.trim() || card.title,
    description: state.description.trim() || card.description,
  };
}

/** The page icon of the preview, for the generated card's mirror; null before there is one. */
export const previewIcon = (state: FlowState): CardIcon | null => state.preview?.icon ?? null;

/**
 * The error to show next to the URL field: URL-scoped errors, and any error while there is no
 * preview (network, upstream, rate limit) because nothing else on screen can show it then.
 */
export function visibleUrlError(state: FlowState): FlowError | null {
  const error = state.error;
  if (!error || isVerificationPhase(state.phase)) return null;
  return error.scope === 'url' || state.preview === null ? error : null;
}

export interface Store<S, A> {
  getState(): S;
  dispatch(action: A): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S, A>(reduce: (state: S, action: A) => S, initial: S): Store<S, A> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type StepId = 'preview' | 'verify' | 'create' | 'share';
export type StepStatus = 'done' | 'current' | 'busy' | 'upcoming';

export interface Step {
  id: StepId;
  status: StepStatus;
}

/**
 * Where the person is on the way from a Notion URL to a shared link, for the step indicator.
 * `busy` marks the step whose request is in flight. Verification counts as done as soon as the
 * workspace needs no proof (already owned, or just verified).
 */
export function flowSteps(state: FlowState): Step[] {
  const { phase, preview, keyUntested } = state;
  const verified = preview !== null && !preview.needsVerification;
  // A preview that still needs proof keeps Verify lit through a Create attempt too, so the
  // highlight does not hop to Create and back when Create turns into verification.
  const proofPending =
    isVerificationPhase(phase) ||
    ((phase === 'ready' || phase === 'creating') && !verified && !keyUntested);
  const current: StepId =
    phase === 'idle' || phase === 'previewing'
      ? 'preview'
      : proofPending
        ? 'verify'
        : phase === 'created'
          ? 'share'
          : 'create';
  const busy =
    phase === 'previewing' ||
    phase === 'requesting_challenge' ||
    phase === 'verifying' ||
    phase === 'creating';
  const order: StepId[] = ['preview', 'verify', 'create', 'share'];
  const at = order.indexOf(current);
  return order.map((id, index): Step => {
    if (id === current)
      return { id, status: phase === 'created' ? 'done' : busy ? 'busy' : 'current' };
    if (id === 'verify' && current !== 'verify') {
      return { id, status: verified || phase === 'created' ? 'done' : 'upcoming' };
    }
    return { id, status: index < at ? 'done' : 'upcoming' };
  });
}
