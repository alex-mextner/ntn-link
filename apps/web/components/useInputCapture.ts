'use client';

import { useEffect, useRef, type RefObject } from 'react';
import {
  classifyTarget,
  describeChain,
  isOverlayRole,
  returnsFocusAfterClick,
  routeKeydown,
  routePaste,
  shouldRefocus,
  type RefocusReason,
  type TargetKind,
} from '@/lib/client/focus';

export interface InputCaptureActions {
  /** Replaces the URL field's content; `immediate` skips the typing debounce. */
  setUrl(url: string, immediate: boolean): void;
  /** Starts the preview for whatever the field holds now. */
  previewNow(): void;
}

const OVERLAY_SELECTOR =
  'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"]';

function inputUsable(input: HTMLInputElement | null): input is HTMLInputElement {
  return (
    input !== null && input.isConnected && !input.disabled && input.getClientRects().length > 0
  );
}

function overlayOpen(): boolean {
  return (
    document.querySelector(OVERLAY_SELECTOR) !== null ||
    isOverlayRole(document.activeElement?.getAttribute('role') ?? null)
  );
}

function selectionActive(): boolean {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString() !== '';
}

/**
 * Keeps the URL field the place input goes to (see lib/client/focus.ts for the rules):
 * focused on load and after every state change, reclaimed when focus falls on nothing, and
 * fed by pastes and typed characters that would otherwise land nowhere.
 *
 * Focus moves never scroll (`preventScroll`), except when the user typed or pasted: then the
 * field is brought into view so they see where their text went.
 */
export function useInputCapture(
  inputRef: RefObject<HTMLInputElement | null>,
  actions: InputCaptureActions,
  stateSignal: unknown,
): void {
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });

  // Load and every state change: the step may have replaced the control that had focus.
  useEffect(() => {
    reclaim(inputRef, 'state');
  }, [inputRef, stateSignal]);

  useEffect(() => {
    const kindOf = (target: EventTarget | null): TargetKind =>
      classifyTarget(describeChain(target instanceof Element ? target : null, inputRef.current));

    let pending: number | undefined;
    // Deferred: during focusout/pointerup the browser has not settled `document.activeElement`.
    const reclaimSoon = (reason: RefocusReason) => {
      clearTimeout(pending);
      pending = window.setTimeout(() => reclaim(inputRef, reason, touch), 0);
    };

    // While a button is held, focus falls to <body> on mousedown: wait for the release so a
    // drag-selection of page text is not interrupted.
    let pointerDown = false;
    let touch = false;
    const onPointerDown = (event: PointerEvent) => {
      pointerDown = true;
      touch = event.pointerType === 'touch';
    };
    const onPointerUp = () => {
      pointerDown = false;
      reclaimSoon('pointer');
    };
    // A cancelled pointer is a touch scroll or pan: not a tap, so no refocus (it would pop the
    // on-screen keyboard open again while the person scrolls).
    const onPointerCancel = () => {
      pointerDown = false;
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget === null && !pointerDown) reclaimSoon('focusout');
    };
    // Removing the focused element (a confirmed delete, a finished step) fires no focus event.
    const observer = new MutationObserver(() => reclaimSoon('focusout'));
    observer.observe(document.body, { childList: true, subtree: true });

    const onClick = (event: MouseEvent) => {
      const chain = describeChain(event.target instanceof Element ? event.target : null, null);
      const pointerType = event instanceof PointerEvent ? event.pointerType : '';
      if (returnsFocusAfterClick(chain, { detail: event.detail, pointerType })) {
        reclaimAfterClick(inputRef);
      }
    };

    const onPaste = (event: ClipboardEvent) => {
      const input = inputRef.current;
      if (!inputUsable(input)) return;
      const route = routePaste({
        target: kindOf(event.target),
        text: event.clipboardData?.getData('text') ?? '',
        inputAvailable: true,
        overlayOpen: overlayOpen(),
      });
      if (route.action === 'capture') {
        event.preventDefault();
        input.focus();
        latest.current.setUrl(route.text, true);
      } else if (route.action === 'preview-after-default') {
        // The browser inserts the text and React reports it; preview once that has landed.
        setTimeout(() => latest.current.previewNow(), 0);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const input = inputRef.current;
      if (!inputUsable(input)) return;
      const route = routeKeydown({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        isComposing: event.isComposing,
        defaultPrevented: event.defaultPrevented,
        target: kindOf(event.target),
        inputHasText: input.value !== '',
        inputAvailable: true,
        overlayOpen: overlayOpen(),
      });
      if (route.action === 'type') {
        event.preventDefault();
        input.focus();
        latest.current.setUrl(input.value + route.text, false);
      } else if (route.action === 'clear') {
        event.preventDefault();
        latest.current.setUrl('', false);
      }
    };

    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('click', onClick);
    window.addEventListener('paste', onPaste, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      clearTimeout(pending);
      observer.disconnect();
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      document.removeEventListener('click', onClick);
      window.removeEventListener('paste', onPaste, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [inputRef]);
}

function reclaim(
  inputRef: RefObject<HTMLInputElement | null>,
  reason: RefocusReason,
  touch = false,
): void {
  const input = inputRef.current;
  if (!inputUsable(input)) return;
  const active = classifyTarget(describeChain(document.activeElement, input));
  const refocus = shouldRefocus({
    active,
    inputAvailable: true,
    overlayOpen: overlayOpen(),
    selectionActive: selectionActive(),
    documentFocused: document.hasFocus(),
    touch,
    reason,
  });
  if (refocus) input.focus({ preventScroll: true });
}

/** A mouse click on Copy: the control keeps focus only until the click has been handled. */
function reclaimAfterClick(inputRef: RefObject<HTMLInputElement | null>): void {
  setTimeout(() => {
    const input = inputRef.current;
    if (inputUsable(input) && !overlayOpen() && document.hasFocus()) {
      input.focus({ preventScroll: true });
    }
  }, 0);
}
