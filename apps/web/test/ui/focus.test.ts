/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import {
  classifyTarget,
  routeKeydown,
  returnsFocusAfterClick,
  routePaste,
  shouldRefocus,
  type ElementInfo,
  type KeyContext,
  type PasteContext,
  type RefocusReason,
  type RefocusContext,
  type TargetKind,
} from '../../lib/client/focus';

function el(tag: string, overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    tag,
    role: null,
    inputType: null,
    contentEditable: false,
    tabIndex: null,
    hasHref: false,
    disabled: false,
    readOnly: false,
    isPrimaryInput: false,
    returnFocus: false,
    ...overrides,
  };
}

const BODY = el('body');
const HTML = el('html');

describe('classifyTarget', () => {
  test.each<[string, ElementInfo[], TargetKind]>([
    ['no element', [], 'none'],
    ['body', [BODY, HTML], 'none'],
    ['the document element', [HTML], 'none'],
    ['the URL field', [el('input', { inputType: 'url', isPrimaryInput: true }), BODY], 'primary'],
    ['a text input', [el('input', { inputType: 'text' }), BODY], 'editable'],
    ['an input without a type attribute', [el('input'), BODY], 'editable'],
    ['a textarea', [el('textarea'), BODY], 'editable'],
    ['a select', [el('select'), BODY], 'editable'],
    ['a contenteditable div', [el('div', { contentEditable: true }), BODY], 'editable'],
    ['a custom text box', [el('div', { role: 'textbox', tabIndex: 0 }), BODY], 'editable'],
    [
      'a read-only value box',
      [el('div', { role: 'textbox', tabIndex: 0, readOnly: true }), BODY],
      'interactive',
    ],
    ['a checkbox', [el('input', { inputType: 'checkbox' }), BODY], 'interactive'],
    ['a radio', [el('input', { inputType: 'radio' }), BODY], 'interactive'],
    ['a button', [el('button'), BODY], 'interactive'],
    ['a link with href', [el('a', { hasHref: true }), BODY], 'interactive'],
    ['an anchor without href', [el('a'), BODY], 'passive'],
    ['a summary', [el('summary'), el('details'), BODY], 'interactive'],
    ['a tab stop div', [el('div', { tabIndex: 0 }), BODY], 'interactive'],
    ['a role=button div', [el('div', { role: 'button' }), BODY], 'interactive'],
    ['a script-only focus target', [el('h2', { tabIndex: -1 }), BODY], 'passive'],
    ['a plain paragraph', [el('p'), el('section'), BODY], 'passive'],
    ['a disabled button', [el('button', { disabled: true }), BODY], 'passive'],
    [
      'a disabled text input',
      [el('input', { inputType: 'text', disabled: true }), BODY],
      'passive',
    ],
    ['a read-only textarea', [el('textarea', { readOnly: true }), BODY], 'interactive'],
  ])('%s is %s', (_name, chain, expected) => {
    expect(classifyTarget(chain)).toBe(expected);
  });

  test('a click on a span inside a button counts as the button', () => {
    expect(classifyTarget([el('span'), el('button'), el('form'), BODY])).toBe('interactive');
  });

  test('a span inside a link counts as the link', () => {
    expect(classifyTarget([el('span'), el('a', { hasHref: true }), BODY])).toBe('interactive');
  });

  test('a node inside a label is interactive (clicking it toggles its control)', () => {
    expect(classifyTarget([el('span'), el('label'), BODY])).toBe('interactive');
  });

  test('only ancestors below body are consulted', () => {
    expect(classifyTarget([el('div'), el('main'), el('body', { tabIndex: 0 })])).toBe('passive');
  });
});

function refocus(overrides: Partial<RefocusContext> = {}): RefocusContext {
  return {
    active: 'none',
    inputAvailable: true,
    overlayOpen: false,
    selectionActive: false,
    documentFocused: true,
    touch: false,
    reason: 'state',
    ...overrides,
  };
}

describe('shouldRefocus', () => {
  test.each<TargetKind>(['none', 'passive'])('reclaims focus from %s', (active) => {
    expect(shouldRefocus(refocus({ active }))).toBe(true);
  });

  test.each<TargetKind>(['primary', 'editable', 'interactive'])(
    'never steals focus from %s',
    (active) => {
      expect(shouldRefocus(refocus({ active }))).toBe(false);
    },
  );

  test('does nothing while a dialog or menu is open', () => {
    expect(shouldRefocus(refocus({ overlayOpen: true }))).toBe(false);
  });

  test('does nothing when the window itself is not focused (alt-tab, browser chrome)', () => {
    expect(shouldRefocus(refocus({ documentFocused: false, reason: 'focusout' }))).toBe(false);
  });

  test('does nothing when there is no usable field on this step', () => {
    expect(shouldRefocus(refocus({ inputAvailable: false }))).toBe(false);
  });

  test.each<RefocusReason>(['pointer', 'focusout'])(
    'keeps a text selection alive (%s)',
    (reason) => {
      expect(shouldRefocus(refocus({ selectionActive: true, reason }))).toBe(false);
    },
  );

  test('a state change reclaims focus even over a selection: the control is gone', () => {
    expect(shouldRefocus(refocus({ selectionActive: true, reason: 'state' }))).toBe(true);
  });

  test('Tab to another control is never undone: its target is interactive', () => {
    const target = classifyTarget([el('button'), BODY]);
    expect(shouldRefocus(refocus({ active: target, reason: 'focusout' }))).toBe(false);
  });
});

function paste(overrides: Partial<PasteContext> = {}): PasteContext {
  return {
    target: 'none',
    text: 'https://thsm.notion.site/page',
    inputAvailable: true,
    overlayOpen: false,
    ...overrides,
  };
}

describe('routePaste', () => {
  test.each<TargetKind>(['none', 'passive'])('captures a paste on %s', (target) => {
    expect(routePaste(paste({ target }))).toEqual({
      action: 'capture',
      text: 'https://thsm.notion.site/page',
    });
  });

  test('trims the clipboard text', () => {
    expect(routePaste(paste({ text: '  https://a.notion.site/x \n' }))).toEqual({
      action: 'capture',
      text: 'https://a.notion.site/x',
    });
  });

  test('a paste into the URL field itself is left to the browser, with an instant preview', () => {
    expect(routePaste(paste({ target: 'primary' }))).toEqual({ action: 'preview-after-default' });
  });

  test.each<TargetKind>(['editable', 'interactive'])('ignores a paste into %s', (target) => {
    expect(routePaste(paste({ target }))).toEqual({ action: 'ignore' });
  });

  test.each(['', '   ', '\n'])('ignores an empty clipboard (%p), e.g. an image', (text) => {
    expect(routePaste(paste({ text }))).toEqual({ action: 'ignore' });
  });

  test('ignores everything without a usable field or under an open dialog', () => {
    expect(routePaste(paste({ inputAvailable: false }))).toEqual({ action: 'ignore' });
    expect(routePaste(paste({ overlayOpen: true }))).toEqual({ action: 'ignore' });
  });
});

function key(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    key: 'h',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    defaultPrevented: false,
    target: 'none',
    inputHasText: false,
    inputAvailable: true,
    overlayOpen: false,
    ...overrides,
  };
}

describe('routeKeydown', () => {
  test.each<TargetKind>(['none', 'passive'])('redirects a printable key typed on %s', (target) => {
    expect(routeKeydown(key({ target }))).toEqual({ action: 'type', text: 'h' });
  });

  test('keeps case and symbols, including non-Latin characters and astral symbols', () => {
    expect(routeKeydown(key({ key: 'H' }))).toEqual({ action: 'type', text: 'H' });
    expect(routeKeydown(key({ key: ':' }))).toEqual({ action: 'type', text: ':' });
    expect(routeKeydown(key({ key: 'д' }))).toEqual({ action: 'type', text: 'д' });
    expect(routeKeydown(key({ key: '🌍' }))).toEqual({ action: 'type', text: '🌍' });
  });

  test.each<TargetKind>(['primary', 'editable', 'interactive'])(
    'leaves keys alone when %s has focus',
    (target) => {
      expect(routeKeydown(key({ target }))).toEqual({ action: 'ignore' });
    },
  );

  test.each(['ctrlKey', 'metaKey', 'altKey'] as const)(
    'does not break browser shortcuts (%s)',
    (modifier) => {
      expect(routeKeydown(key({ [modifier]: true }))).toEqual({ action: 'ignore' });
    },
  );

  test.each(['Tab', 'Enter', 'ArrowDown', 'PageDown', 'Home', 'F5', 'Shift', 'Backspace', 'Dead'])(
    'ignores the non-character key %s',
    (name) => {
      expect(routeKeydown(key({ key: name }))).toEqual({ action: 'ignore' });
    },
  );

  test('leaves Space alone so the page can scroll', () => {
    expect(routeKeydown(key({ key: ' ' }))).toEqual({ action: 'ignore' });
  });

  test('ignores IME composition and already handled events', () => {
    expect(routeKeydown(key({ isComposing: true }))).toEqual({ action: 'ignore' });
    expect(routeKeydown(key({ defaultPrevented: true }))).toEqual({ action: 'ignore' });
  });

  test('ignores everything without a usable field or under an open dialog', () => {
    expect(routeKeydown(key({ inputAvailable: false }))).toEqual({ action: 'ignore' });
    expect(routeKeydown(key({ overlayOpen: true }))).toEqual({ action: 'ignore' });
  });

  test.each<TargetKind>(['none', 'primary', 'passive'])(
    'Escape clears the field only when it has text (%s)',
    (target) => {
      expect(routeKeydown(key({ key: 'Escape', target, inputHasText: true }))).toEqual({
        action: 'clear',
      });
      expect(routeKeydown(key({ key: 'Escape', target, inputHasText: false }))).toEqual({
        action: 'ignore',
      });
    },
  );

  test.each<TargetKind>(['editable', 'interactive'])(
    'Escape inside another field or control is theirs (%s)',
    (target) => {
      expect(routeKeydown(key({ key: 'Escape', target, inputHasText: true }))).toEqual({
        action: 'ignore',
      });
    },
  );

  test('an open dialog keeps Escape', () => {
    expect(routeKeydown(key({ key: 'Escape', inputHasText: true, overlayOpen: true }))).toEqual({
      action: 'ignore',
    });
  });
});

describe('returnsFocusAfterClick', () => {
  const copy = [el('button', { returnFocus: true }), el('span'), BODY];
  const mouse = { detail: 1, pointerType: 'mouse' };

  test('a mouse or pen click on a marked control returns focus', () => {
    expect(returnsFocusAfterClick(copy, mouse)).toBe(true);
    expect(returnsFocusAfterClick(copy, { detail: 1, pointerType: 'pen' })).toBe(true);
  });

  test('a click on an icon inside the marked control counts too', () => {
    expect(returnsFocusAfterClick([el('svg'), ...copy], mouse)).toBe(true);
  });

  test('keyboard activation (detail 0) keeps focus on the control', () => {
    expect(returnsFocusAfterClick(copy, { detail: 0, pointerType: '' })).toBe(false);
  });

  test('a touch tap does not pop the on-screen keyboard open', () => {
    expect(returnsFocusAfterClick(copy, { detail: 1, pointerType: 'touch' })).toBe(false);
  });

  test('other controls keep focus', () => {
    expect(returnsFocusAfterClick([el('button'), BODY], mouse)).toBe(false);
  });
});

describe('touch devices', () => {
  test.each<RefocusReason>(['pointer', 'focusout'])(
    'a tap or a keyboard dismissal (%s) never drags the keyboard back',
    (reason) => {
      expect(shouldRefocus(refocus({ touch: true, reason }))).toBe(false);
    },
  );

  test('a state change still reclaims the field', () => {
    expect(shouldRefocus(refocus({ touch: true, reason: 'state' }))).toBe(true);
  });
});
