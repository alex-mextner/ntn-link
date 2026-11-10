'use client';

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createApi } from '@/lib/client/api';
import { createController, type Controller, type WorkspaceLinks } from '@/lib/client/controller';
import {
  createStore,
  initialState,
  isVerificationPhase,
  previewCard,
  reducer,
  visibleUrlError,
  type Action,
  type FlowState,
} from '@/lib/client/flow';
import type { KeyStorage } from '@/lib/client/keys';
import type { PreviewResponse } from '../../../packages/core/src/api-types';
import { API_LIMITS } from '@/lib/client/limits';
import { checkSlug, type SlugCheck } from '@/lib/client/slug';
import { ru } from '@/lib/client/strings';
import { plainText } from '@/lib/client/text';
import { CardPreview } from './CardPreview';
import { CopyButton, ValueField } from './CopyButton';
import { MyLinks } from './MyLinks';

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

  function onUrlChange(url: string) {
    if (timer.current) clearTimeout(timer.current);
    store.dispatch({ type: 'url_changed', url });
    if (url.trim() !== '' && controller) {
      timer.current = setTimeout(() => void controller.loadPreview(), 600);
    }
  }

  function previewNow() {
    if (timer.current) clearTimeout(timer.current);
    if (state.url.trim() !== '' && controller) void controller.loadPreview();
  }

  const busy = state.phase === 'creating' || state.phase === 'verifying';

  return (
    <>
      <section aria-labelledby="url-heading" className="panel">
        <h2 id="url-heading" className="visually-hidden">
          {ru.urlLabel}
        </h2>
        <UrlField state={state} onChange={onUrlChange} onSubmit={previewNow} />
        {state.phase === 'previewing' ? <PreviewSkeleton /> : null}
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
    </>
  );
}

function UrlField({
  state,
  onChange,
  onSubmit,
}: {
  state: FlowState;
  onChange: (url: string) => void;
  onSubmit: () => void;
}) {
  const id = useId();
  const error = visibleUrlError(state);
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor={`${id}-url`} className="label">
        {ru.urlLabel}
      </label>
      <input
        id={`${id}-url`}
        name="url"
        type="url"
        inputMode="url"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={ru.urlPlaceholder}
        value={state.url}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={`${id}-hint${error ? ` ${id}-err` : ''}`}
        aria-invalid={error ? true : undefined}
        className="input"
      />
      <p id={`${id}-hint`} className="hint">
        {ru.urlHint}
      </p>
      <div className="msg-slot" aria-live="polite">
        {error ? (
          <p id={`${id}-err`} className="field-error" role="alert">
            {error.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function PreviewSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <div className="card skeleton" aria-hidden="true">
        <div className="card-image" />
        <div className="card-body">
          <span className="skeleton-line" />
          <span className="skeleton-line short" />
        </div>
      </div>
      <p className="hint">{ru.previewLoading}</p>
    </div>
  );
}

function slugErrorMessage(state: FlowState, check: SlugCheck): string | null {
  if (state.error?.scope === 'slug') return state.error.message;
  if (check === 'empty') return ru.slugEmpty;
  if (check === 'invalid') return ru.slugInvalid;
  if (check === 'reserved') return ru.slugReserved;
  return null;
}

function SlugField({
  state,
  prefix,
  locked,
  error,
  dispatch,
}: {
  state: FlowState;
  prefix: string;
  locked: boolean;
  error: string | null;
  dispatch: (action: Action) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={`${id}-slug`} className="label">
        {ru.slugLabel}
      </label>
      <div className="slug-row">
        <span className="slug-prefix" aria-hidden="true">
          {prefix}
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
        {ru.slugHint}. <span className="mono">{`${prefix}${state.slug}`}</span>
      </p>
      <div className="msg-slot" aria-live="polite">
        {error ? (
          <p id={`${id}-slug-err`} className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
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
      <summary>{ru.customize}</summary>
      <div className="stack">
        <div>
          <label htmlFor={`${id}-title`} className="label">
            {ru.titleLabel}
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
            {ru.titleHint}
          </p>
        </div>
        <div>
          <label htmlFor={`${id}-desc`} className="label">
            {ru.descriptionLabel}
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
            {ru.descriptionHint}
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
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (slugCheck === 'ok' && !locked) onCreate();
      }}
    >
      <h3 className="subheading">{ru.previewHeading}</h3>
      <CardPreview card={previewCard(state) ?? preview.card} host={host} />

      <SlugField
        state={state}
        prefix={prefix}
        locked={locked}
        error={slugError}
        dispatch={dispatch}
      />

      <CustomizeFields state={state} preview={preview} locked={locked} dispatch={dispatch} />

      <label className="check">
        <input
          type="checkbox"
          checked={state.fast}
          disabled={locked}
          onChange={(event) => dispatch({ type: 'fast_changed', fast: event.target.checked })}
        />
        <span>
          {ru.fastLabel}
          <span className="hint block">{ru.fastHint}</span>
        </span>
      </label>

      <div className="msg-slot" aria-live="polite">
        {generalError ? (
          <p className="field-error" role="alert">
            {generalError.message}
          </p>
        ) : null}
      </div>

      {state.notice === 'verified' ? (
        <p className="notice" role="status">
          {ru.verifiedNotice}
        </p>
      ) : null}

      <button type="submit" className="btn primary" disabled={slugCheck !== 'ok' || locked}>
        {state.phase === 'creating' ? ru.creating : ru.create}
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
  const headingRef = useRef<HTMLHeadingElement>(null);
  const workspace = state.preview?.workspace ?? '';
  const verification = state.verification;
  const step = verification ? 'proof' : 'start';

  // Move focus to the section whenever its step changes so keyboard and screen-reader users land on it.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const error = state.error;
  const busy = state.phase === 'requesting_challenge' || state.phase === 'verifying';
  return (
    <section aria-labelledby="verify-heading" className="panel">
      <h2 id="verify-heading" ref={headingRef} tabIndex={-1}>
        {ru.verifyHeading}
      </h2>
      <p>
        {state.verifyAction === 'rotate' ? ru.verifyRotate(workspace) : ru.verifyClaim(workspace)}
      </p>

      {verification ? (
        <>
          <h3 className="subheading">{ru.verifyStepsHeading}</h3>
          <ol className="steps">
            {ru.verifySteps.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ol>
          <span id="nonce-label" className="label">
            {ru.nonceLabel}
          </span>
          <div className="copy-row">
            <ValueField id="nonce" labelledBy="nonce-label" value={verification.nonce} />
            <CopyButton text={verification.nonce} label={ru.nonceLabel} />
          </div>
          <p className="hint">{ru.verifyExpires}</p>
          <label htmlFor="proof-url" className="label">
            {ru.proofUrlLabel}
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
            {ru.proofUrlHint}
          </p>
        </>
      ) : null}

      <div className="msg-slot" aria-live="polite">
        {error ? (
          <p className="field-error" role="alert">
            {error.message}
          </p>
        ) : null}
      </div>

      <div className="actions">
        {verification ? (
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void controller?.verify()}
          >
            {state.phase === 'verifying' ? ru.verifying : ru.verifyButton}
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void controller?.requestChallenge()}
          >
            {state.phase === 'requesting_challenge' ? ru.verifyRequesting : ru.verifyRequest}
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
  const headingRef = useRef<HTMLHeadingElement>(null);
  const result = state.result;
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  if (!result) return null;
  const { link } = result;
  // Built from this page's origin so the links shown are always the ones this deployment serves.
  const redirect = `${origin}/${link.workspace}/${link.slug}`;
  const fast = `${redirect}/read`;
  return (
    <section aria-labelledby="success-heading" className="panel success">
      <h2 id="success-heading" ref={headingRef} tabIndex={-1}>
        {ru.successHeading}
      </h2>
      <LinkRow label={ru.redirectLinkLabel} hint={ru.redirectLinkHint} url={redirect} />
      {link.fast ? (
        <LinkRow label={ru.fastLinkLabel} hint={ru.fastLinkHint} url={fast} />
      ) : (
        <p className="hint">{ru.fastOff}</p>
      )}
      {result.keySaved ? (
        <label className="check">
          <input
            type="checkbox"
            checked={link.fast}
            onChange={(event) => void controller?.setFast(event.target.checked)}
          />
          <span>{ru.fastToggle}</span>
        </label>
      ) : null}
      <p className="hint">{result.keySaved ? ru.keySavedNote : ru.keyNotSaved}</p>
      <div className="msg-slot" aria-live="polite">
        {state.error ? (
          <p className="field-error" role="alert">
            {state.error.message}
          </p>
        ) : null}
      </div>
      <div className="actions">
        <button type="button" className="btn secondary" onClick={onAnother}>
          {ru.another}
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
        <CopyButton text={url} label={label} />
      </div>
      <p id={`${id}-hint`} className="hint">
        {hint}
      </p>
    </div>
  );
}

export type { WorkspaceLinks };
