'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { createApi } from '@/lib/client/api';
import { createController, type Controller, type WorkspaceLinks } from '@/lib/client/controller';
import {
  createStore,
  flowSteps,
  initialState,
  isVerificationPhase,
  previewCard,
  previewIcon,
  reducer,
  visibleUrlError,
  type Action,
  type FlowState,
  type Step,
  pendingActions,
} from '@/lib/client/flow';
import type { KeyStorage } from '@/lib/client/keys';
import type { PreviewResponse } from '../../../packages/core/src/api-types';
import { API_LIMITS } from '@/lib/client/limits';
import { checkSlug, type SlugCheck } from '@/lib/client/slug';
import { en } from '@/lib/client/strings';
import { plainText } from '@/lib/client/text';
import { CardPreview, type UnfurlMode } from './CardPreview';
import { CopyButton, ValueField } from './CopyButton';
import {
  AlertIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CloseIcon,
  LinkIcon,
  ShieldIcon,
  SpinnerIcon,
} from './icons';
import { MyLinks } from './MyLinks';
import { useInputCapture } from './useInputCapture';

type BrowserStorage = KeyStorage & { length: number; key(index: number): string | null };

function browserStorage(): BrowserStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const noop = () => () => {};
const getOrigin = () => window.location.origin;
const getServerOrigin = () => '';

export function App() {
  const [store] = useState(() => createStore(reducer, initialState));
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const origin = useSyncExternalStore(noop, getOrigin, getServerOrigin);
  const controller = useMemo<Controller | null>(
    () =>
      origin === ''
        ? null
        : createController(
            store,
            {
              api: createApi((input, init) => window.fetch(input, init)),
              storage: browserStorage(),
              origin,
            },
            browserStorage(),
          ),
    [store, origin],
  );
  // Bumped whenever the set of links may have changed; MyLinks reloads on it.
  const [linksVersion, setLinksVersion] = useState(0);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const resultSlug = state.result?.link.slug;
  const cleanupSignature = state.cleanups.map((c) => `${c.workspace}:${c.status}`).join(',');
  useEffect(() => {
    setLinksVersion((v) => v + 1);
  }, [resultSlug, cleanupSignature]);

  function onUrlChange(url: string, immediate = false) {
    if (timer.current) clearTimeout(timer.current);
    store.dispatch({ type: 'url_changed', url });
    if (url.trim() === '' || !controller) return;
    if (immediate) void controller.loadPreview();
    else timer.current = setTimeout(() => void controller.loadPreview(), 600);
  }

  function previewNow() {
    if (timer.current) clearTimeout(timer.current);
    if (store.getState().url.trim() !== '' && controller) void controller.loadPreview();
  }

  const inputRef = useRef<HTMLInputElement>(null);
  useInputCapture(inputRef, { setUrl: onUrlChange, previewNow }, state);

  const busy = state.phase === 'creating' || state.phase === 'verifying';
  const host = origin === '' ? '' : new URL(origin).host;
  const previewMode: UnfurlMode =
    state.phase === 'previewing' ? 'loading' : state.preview ? 'ready' : 'empty';

  return (
    <div className="stage">
      <StepIndicator steps={flowSteps(state)} />
      <p className="visually-hidden" role="status">
        {announcement(state)}
      </p>

      <section aria-labelledby="url-heading" className="panel panel-main">
        <h2 id="url-heading" className="visually-hidden">
          {en.urlLabel}
        </h2>
        <UrlField
          state={state}
          inputRef={inputRef}
          onChange={(url) => onUrlChange(url)}
          onSubmit={previewNow}
        />
        <CardPreview
          card={state.preview ? (previewCard(state) ?? state.preview.card) : null}
          excerpt={state.preview?.excerpt ?? []}
          icon={previewIcon(state)}
          host={host}
          sourceHost={state.preview ? `${state.preview.workspace}.notion.site` : host}
          mode={previewMode}
        />
        {state.preview && state.phase !== 'created' ? (
          <CreateForm
            state={state}
            origin={origin}
            busy={busy}
            dispatch={store.dispatch}
            onCreate={() => void controller?.create()}
          />
        ) : null}
      </section>

      {isVerificationPhase(state.phase) ? (
        <VerifySection state={state} controller={controller} dispatch={store.dispatch} />
      ) : null}

      {state.phase === 'created' && state.result ? (
        <SuccessPanel
          state={state}
          origin={origin}
          controller={controller}
          onAnother={() => store.dispatch({ type: 'reset' })}
        />
      ) : null}

      {controller ? (
        <MyLinks controller={controller} cleanups={state.cleanups} version={linksVersion} />
      ) : null}
    </div>
  );
}

/**
 * Screen-reader narration of what the page is doing or moved to: a request in flight is announced
 * the moment it starts (errors announce themselves as alerts). A background cleanup is only
 * announced while the flow itself has nothing to say, so it never hides the step the person is on.
 */
function announcement(state: FlowState): string {
  const pending = pendingActions(state);
  if (pending.includes('create')) return en.announce.creating;
  if (pending.includes('challenge')) return en.announce.requestingChallenge;
  if (pending.includes('verify')) return en.announce.verifying;
  if (pending.includes('fast')) return en.announce.savingFast;
  const step = stepAnnouncement(state);
  if (step === '' && pending.includes('cleanup')) return en.announce.cleaning;
  return step;
}

function stepAnnouncement(state: FlowState): string {
  switch (state.phase) {
    case 'previewing':
      return en.announce.previewing;
    case 'ready':
      return state.preview ? en.announce.ready : '';
    case 'needs_verification':
      return en.announce.needsVerification;
    case 'awaiting_proof':
      return en.announce.awaitingProof;
    case 'created':
      return en.announce.created;
    default:
      return '';
  }
}

function StepIndicator({ steps }: { steps: Step[] }) {
  return (
    <ol className="steps-bar" aria-label={en.stepsLabel}>
      {steps.map((step, index) => (
        <li
          key={step.id}
          className="step"
          data-status={step.status}
          aria-current={step.status === 'current' || step.status === 'busy' ? 'step' : undefined}
        >
          <span className="step-dot" aria-hidden="true">
            {step.status === 'done' ? (
              <CheckIcon size={12} />
            ) : step.status === 'busy' ? (
              <SpinnerIcon size={12} />
            ) : (
              index + 1
            )}
          </span>
          <span className="step-name">{en.stepNames[step.id]}</span>
          <span className="visually-hidden">{`, ${en.stepStatus[step.status]}`}</span>
        </li>
      ))}
    </ol>
  );
}

function UrlField({
  state,
  inputRef,
  onChange,
  onSubmit,
}: {
  state: FlowState;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (url: string) => void;
  onSubmit: () => void;
}) {
  const id = useId();
  const error = visibleUrlError(state);
  const previewing = state.phase === 'previewing';
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor={`${id}-url`} className="label">
        {en.urlLabel}
      </label>
      <div className="field" data-invalid={error ? 'true' : undefined}>
        <span className="field-lead" aria-hidden="true">
          <LinkIcon size={20} />
        </span>
        <input
          id={`${id}-url`}
          ref={inputRef}
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={en.urlPlaceholder}
          value={state.url}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={`${id}-hint${error ? ` ${id}-err` : ''}`}
          aria-invalid={error ? true : undefined}
          className="input input-hero"
        />
        <span className="field-trail">
          {previewing ? (
            <SpinnerIcon size={18} />
          ) : state.url !== '' ? (
            <button
              type="button"
              className="icon-btn"
              aria-label={en.clear}
              data-return-focus=""
              onClick={() => onChange('')}
            >
              <CloseIcon size={16} />
            </button>
          ) : null}
        </span>
      </div>
      <p id={`${id}-hint`} className="hint" aria-live="polite">
        {previewing ? en.previewLoading : en.urlHint}
      </p>
      <div className="msg-slot" aria-live="polite">
        {error ? <FieldError id={`${id}-err`} message={error.message} /> : null}
      </div>
    </form>
  );
}

function FieldError({ id, message }: { id?: string; message: string }) {
  return (
    <p id={id} className="field-error" role="alert">
      <AlertIcon size={16} />
      <span>{message}</span>
    </p>
  );
}

function slugErrorMessage(state: FlowState, check: SlugCheck): string | null {
  if (state.error?.scope === 'slug') return state.error.message;
  if (check === 'empty') return en.slugEmpty;
  if (check === 'invalid') return en.slugInvalid;
  if (check === 'reserved') return en.slugReserved;
  return null;
}

function SlugField({
  state,
  prefix,
  prefixLabel,
  locked,
  error,
  dispatch,
}: {
  state: FlowState;
  prefix: string;
  prefixLabel: string;
  locked: boolean;
  error: string | null;
  dispatch: (action: Action) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={`${id}-slug`} className="label">
        {en.slugLabel}
      </label>
      <div className="slug-row" data-invalid={error ? 'true' : undefined}>
        <span className="slug-prefix" aria-hidden="true">
          {prefixLabel}
        </span>
        <input
          id={`${id}-slug`}
          name="slug"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={API_LIMITS.slugMaxLength}
          value={state.slug}
          disabled={locked}
          onChange={(event) => dispatch({ type: 'slug_changed', slug: event.target.value })}
          aria-describedby={`${id}-slug-hint${error ? ` ${id}-slug-err` : ''}`}
          aria-invalid={error ? true : undefined}
          className="input slug-input"
        />
      </div>
      <p id={`${id}-slug-hint`} className="hint">
        {en.slugHint}. <span className="mono">{`${prefix}${state.slug}`}</span>
      </p>
      <div className="msg-slot" aria-live="polite">
        {error ? <FieldError id={`${id}-slug-err`} message={error} /> : null}
      </div>
    </div>
  );
}

function Switch({
  checked,
  disabled,
  busy,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        // aria-disabled keeps keyboard focus while a save runs; setFast ignores the change.
        aria-disabled={busy ? true : undefined}
        aria-busy={busy ? true : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track" aria-hidden="true" />
      <span className="switch-text">
        {label}
        {busy ? <SpinnerIcon size={14} /> : null}
        {hint ? <span className="hint block">{hint}</span> : null}
      </span>
    </label>
  );
}

function CustomizeFields({
  state,
  preview,
  locked,
  dispatch,
}: {
  state: FlowState;
  preview: PreviewResponse;
  locked: boolean;
  dispatch: (action: Action) => void;
}) {
  const id = useId();
  return (
    <details className="customize">
      <summary>{en.customize}</summary>
      <div className="stack">
        <div>
          <label htmlFor={`${id}-title`} className="label">
            {en.titleLabel}
          </label>
          <input
            id={`${id}-title`}
            type="text"
            className="input"
            maxLength={API_LIMITS.titleOverrideMaxLength}
            value={state.title}
            disabled={locked}
            placeholder={plainText(preview.card.title)}
            onChange={(event) => dispatch({ type: 'title_changed', title: event.target.value })}
            aria-describedby={`${id}-title-hint`}
          />
          <p id={`${id}-title-hint`} className="hint">
            {en.titleHint}
          </p>
        </div>
        <div>
          <label htmlFor={`${id}-desc`} className="label">
            {en.descriptionLabel}
          </label>
          <textarea
            id={`${id}-desc`}
            className="input"
            rows={3}
            maxLength={API_LIMITS.descriptionOverrideMaxLength}
            value={state.description}
            disabled={locked}
            placeholder={plainText(preview.card.description)}
            onChange={(event) =>
              dispatch({ type: 'description_changed', description: event.target.value })
            }
            aria-describedby={`${id}-desc-hint`}
          />
          <p id={`${id}-desc-hint`} className="hint">
            {en.descriptionHint}
          </p>
        </div>
      </div>
    </details>
  );
}

function CreateForm({
  state,
  origin,
  busy,
  dispatch,
  onCreate,
}: {
  state: FlowState;
  origin: string;
  busy: boolean;
  dispatch: (action: Action) => void;
  onCreate: () => void;
}) {
  const preview = state.preview;
  if (!preview) return null;
  const slugCheck = checkSlug(state.slug);
  const slugError = slugErrorMessage(state, slugCheck);
  const generalError = state.error?.scope === 'general' ? state.error : null;
  const host = origin === '' ? '' : new URL(origin).host;
  const locked = busy || isVerificationPhase(state.phase);
  const prefix = `${origin}/${preview.workspace}/`;

  return (
    <form
      noValidate
      className="stack form-create"
      onSubmit={(event) => {
        event.preventDefault();
        if (slugCheck === 'ok' && !locked) onCreate();
      }}
    >
      <SlugField
        state={state}
        prefix={prefix}
        prefixLabel={`${host}/${preview.workspace}/`}
        locked={locked}
        error={slugError}
        dispatch={dispatch}
      />

      <CustomizeFields state={state} preview={preview} locked={locked} dispatch={dispatch} />

      <Switch
        checked={state.fast}
        disabled={locked}
        onChange={(fast) => dispatch({ type: 'fast_changed', fast })}
        label={en.fastLabel}
        hint={en.fastHint}
      />

      <div className="msg-slot" aria-live="polite">
        {generalError ? <FieldError message={generalError.message} /> : null}
      </div>

      {state.notice === 'verified' ? (
        <p className="notice" role="status">
          <CheckIcon size={18} />
          <span>{en.verifiedNotice}</span>
        </p>
      ) : null}

      <button
        type="submit"
        className="btn btn-primary"
        disabled={slugCheck !== 'ok' || locked}
        aria-busy={state.phase === 'creating' ? true : undefined}
      >
        {state.phase === 'creating' ? (
          <SpinnerIcon />
        ) : isVerificationPhase(state.phase) ? (
          <ShieldIcon size={18} />
        ) : null}
        <span className="btn-label">
          {state.phase === 'creating'
            ? en.creating
            : isVerificationPhase(state.phase)
              ? en.createVerifyFirst
              : en.create}
        </span>
      </button>
    </form>
  );
}

function VerifySection({
  state,
  controller,
  dispatch,
}: {
  state: FlowState;
  controller: Controller | null;
  dispatch: (action: Action) => void;
}) {
  const workspace = state.preview?.workspace ?? '';
  const verification = state.verification;

  const error = state.error;
  const busy = state.phase === 'requesting_challenge' || state.phase === 'verifying';
  const section = useRef<HTMLElement>(null);
  // The panel opens below the fold on a phone: bring it into view so the click visibly did something.
  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    section.current?.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
  }, []);
  return (
    <section
      ref={section}
      aria-labelledby="verify-heading"
      className="panel panel-verify"
      aria-busy={busy}
    >
      {busy ? <span className="progress-bar" aria-hidden="true" /> : null}
      <div className="panel-title">
        <span className="badge-icon" aria-hidden="true">
          <ShieldIcon size={20} />
        </span>
        <h2 id="verify-heading">{en.verifyHeading}</h2>
      </div>
      <p className="lede">
        {state.verifyAction === 'rotate' ? en.verifyRotate(workspace) : en.verifyClaim(workspace)}
      </p>

      {verification ? (
        <>
          <h3 className="subheading">{en.verifyStepsHeading}</h3>
          <ol className="steps">
            {en.verifySteps.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ol>
          <span id="nonce-label" className="label">
            {en.nonceLabel}
          </span>
          <div className="copy-row">
            <ValueField id="nonce" labelledBy="nonce-label" value={verification.nonce} />
            <CopyButton text={verification.nonce} label={en.nonceLabel} />
          </div>
          <p className="hint">{en.verifyExpires}</p>
          <label htmlFor="proof-url" className="label spaced">
            {en.proofUrlLabel}
          </label>
          <input
            id="proof-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="input"
            value={state.proofUrl}
            disabled={state.phase === 'verifying'}
            onChange={(event) => dispatch({ type: 'proof_url_changed', url: event.target.value })}
            aria-describedby="proof-url-hint"
          />
          <p id="proof-url-hint" className="hint">
            {en.proofUrlHint}
          </p>
        </>
      ) : null}

      <div className="msg-slot" aria-live="polite">
        {error ? <FieldError message={error.message} /> : null}
      </div>

      <div className="actions">
        {verification ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void controller?.verify()}
          >
            {state.phase === 'verifying' ? <SpinnerIcon /> : null}
            <span className="btn-label">
              {state.phase === 'verifying' ? en.verifying : en.verifyButton}
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void controller?.requestChallenge()}
          >
            {state.phase === 'requesting_challenge' ? <SpinnerIcon /> : null}
            <span className="btn-label">
              {state.phase === 'requesting_challenge' ? en.verifyRequesting : en.verifyRequest}
            </span>
          </button>
        )}
      </div>
    </section>
  );
}

function SuccessPanel({
  state,
  origin,
  controller,
  onAnother,
}: {
  state: FlowState;
  origin: string;
  controller: Controller | null;
  onAnother: () => void;
}) {
  const result = state.result;
  if (!result) return null;
  const { link } = result;
  // Built from this page's origin so the links shown are always the ones this deployment serves.
  const redirect = `${origin}/${link.workspace}/${link.slug}`;
  const fast = `${redirect}/read`;
  return (
    <section aria-labelledby="success-heading" className="panel panel-success">
      <div className="panel-title">
        <span className="badge-icon badge-ok" aria-hidden="true">
          <CheckIcon size={20} />
        </span>
        <h2 id="success-heading">{en.successHeading}</h2>
      </div>
      <LinkRow label={en.redirectLinkLabel} hint={en.redirectLinkHint} url={redirect} />
      {link.fast ? (
        <LinkRow label={en.fastLinkLabel} hint={en.fastLinkHint} url={fast} />
      ) : (
        <p className="hint">{en.fastOff}</p>
      )}
      {result.keySaved ? (
        <div className="spaced">
          <Switch
            checked={link.fast}
            busy={state.fastSaving}
            onChange={(checked) => void controller?.setFast(checked)}
            label={en.fastToggle}
          />
        </div>
      ) : null}
      <p className="hint spaced">{result.keySaved ? en.keySavedNote : en.keyNotSaved}</p>
      <div className="msg-slot" aria-live="polite">
        {state.error ? <FieldError message={state.error.message} /> : null}
      </div>
      <div className="actions">
        <button type="button" className="btn btn-secondary" onClick={onAnother}>
          {en.another}
        </button>
      </div>
    </section>
  );
}

function LinkRow({ label, hint, url }: { label: string; hint: string; url: string }) {
  const id = useId();
  return (
    <div className="link-row">
      <span id={`${id}-label`} className="label">
        {label}
      </span>
      <div className="copy-row">
        <ValueField id={id} labelledBy={`${id}-label`} describedBy={`${id}-hint`} value={url} />
        <span className="row-actions">
          <CopyButton text={url} label={label} />
          <a className="btn btn-secondary" href={url} target="_blank" rel="noopener">
            <ArrowUpRightIcon size={16} />
            <span className="btn-label">{en.openLink}</span>
            <span className="visually-hidden">{`: ${label}`}</span>
          </a>
        </span>
      </div>
      <p id={`${id}-hint`} className="hint">
        {hint}
      </p>
    </div>
  );
}

export type { WorkspaceLinks };
