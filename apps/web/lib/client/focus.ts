/**
 * Decisions behind the "the URL field is always ready" behavior. Everything here is pure:
 * the DOM is read once into plain descriptors (`describeChain`), and the rules below work on
 * those, so they run under bun test without a browser.
 *
 * Principles: never steal focus from anything a person can operate (other fields, buttons,
 * links, summaries, dialogs); only reclaim it when it is on nothing (body/null), on an
 * element nobody can act on (a heading with tabindex=-1, a disabled button), or when text is
 * typed or pasted with no field to receive it. Tab and Shift+Tab always keep working because
 * their focus targets are interactive elements.
 */

/** What is known about one element, from the target up to the root. */
export interface ElementInfo {
  tag: string;
  role: string | null;
  /** Value of the `type` attribute of an <input>, lower-cased. */
  inputType: string | null;
  contentEditable: boolean;
  /** Explicit `tabindex` attribute as a number, or null when absent. */
  tabIndex: number | null;
  hasHref: boolean;
  disabled: boolean;
  readOnly: boolean;
  /** This is the URL field the whole behavior serves. */
  isPrimaryInput: boolean;
  /** `data-return-focus`: a mouse click on this control hands focus back to the URL field. */
  returnFocus: boolean;
}

/**
 * - `none`: nothing has focus (null, <body>, the document itself).
 * - `primary`: the URL field.
 * - `editable`: another place text goes into (text inputs, textarea, select, contenteditable).
 * - `interactive`: anything else a person can operate (button, link, checkbox, summary, tab stop).
 * - `passive`: an element focus is of no use on (heading focused by script, disabled control).
 */
export type TargetKind = 'none' | 'primary' | 'editable' | 'interactive' | 'passive';

const TEXT_INPUT_TYPES = new Set([
  'text',
  'url',
  'search',
  'email',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'switch',
  'radio',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'listbox',
  'treeitem',
  'gridcell',
]);

const INTERACTIVE_TAGS = new Set(['button', 'select', 'textarea', 'summary', 'details', 'label']);

/** Roles that mean "something modal or transient is open"; focus belongs to it. */
const OVERLAY_ROLES = new Set(['dialog', 'alertdialog', 'menu', 'listbox']);

export function isOverlayRole(role: string | null): boolean {
  return role !== null && OVERLAY_ROLES.has(role);
}

function isEditable(info: ElementInfo): boolean {
  if (info.disabled) return false;
  if (info.contentEditable) return true;
  if (info.tag === 'textarea' || info.tag === 'select')
    return !info.readOnly || info.tag === 'select';
  if (info.tag === 'input') return info.inputType === null || TEXT_INPUT_TYPES.has(info.inputType);
  return info.role !== null && EDITABLE_ROLES.has(info.role) && !info.readOnly;
}

function isInteractive(info: ElementInfo): boolean {
  if (info.disabled) return false;
  if (INTERACTIVE_TAGS.has(info.tag)) return true;
  if (info.tag === 'input') return info.inputType !== 'hidden';
  if (info.tag === 'a' || info.tag === 'area') return info.hasHref;
  if (info.role !== null && (INTERACTIVE_ROLES.has(info.role) || EDITABLE_ROLES.has(info.role))) {
    return true;
  }
  // tabindex=-1 is "focusable by script only": headings we focus for screen readers use it.
  return info.tabIndex !== null && info.tabIndex >= 0;
}

/**
 * Classifies a focus or event target. `chain` is the target first, then its ancestors, so a
 * click on the <span> inside a <button> still counts as the button.
 */
export function classifyTarget(chain: readonly ElementInfo[]): TargetKind {
  const first = chain[0];
  if (first === undefined || first.tag === 'body' || first.tag === 'html') return 'none';
  if (first.isPrimaryInput) return 'primary';
  for (const info of chain) {
    if (info.tag === 'body' || info.tag === 'html') break;
    if (isEditable(info)) return 'editable';
    if (isInteractive(info)) return 'interactive';
  }
  return 'passive';
}

/**
 * After a mouse or pen click on a marked control (Copy), focus goes back to the URL field.
 * Keyboard activation (`detail` 0) keeps focus where the keyboard user put it, and a touch tap
 * does not pop the on-screen keyboard open.
 */
export function returnsFocusAfterClick(
  chain: readonly ElementInfo[],
  click: { detail: number; pointerType: string },
): boolean {
  const pointing =
    click.detail > 0 && (click.pointerType === 'mouse' || click.pointerType === 'pen');
  return pointing && chain.some((info) => info.returnFocus);
}

/** Why focus is being reconsidered: a state change, a focus loss (or DOM change), a pointer release. */
export type RefocusReason = 'state' | 'focusout' | 'pointer';

export interface RefocusContext {
  /** Classification of `document.activeElement`. */
  active: TargetKind;
  /** The URL field exists, is enabled and is on screen for the current step. */
  inputAvailable: boolean;
  /** A dialog, menu or similar is open. */
  overlayOpen: boolean;
  /** The user has text selected on the page (they are probably about to copy it). */
  selectionActive: boolean;
  /** The window itself has focus: when it does not, "body" only means the user went elsewhere. */
  documentFocused: boolean;
  /** The last pointer the person used was a finger. */
  touch: boolean;
  reason: RefocusReason;
}

/** Should focus be moved back onto the URL field right now? */
export function shouldRefocus(context: RefocusContext): boolean {
  if (!context.inputAvailable || context.overlayOpen || !context.documentFocused) return false;
  if (context.active !== 'none' && context.active !== 'passive') return false;
  // Dismissing the on-screen keyboard blurs the field and taps outside it are how people do
  // that: only a state change may bring the field (and keyboard) back on touch devices.
  if (context.touch && context.reason !== 'state') return false;
  // Text the user selected to copy must survive; only a state change (the control they had is
  // gone) reclaims focus regardless of a selection.
  if (context.reason !== 'state' && context.selectionActive) return false;
  return true;
}

export interface PasteContext {
  target: TargetKind;
  /** `clipboardData.getData('text')` (may be empty for images and files). */
  text: string;
  inputAvailable: boolean;
  overlayOpen: boolean;
}

export type PasteRoute =
  /** Leave the event alone. */
  | { action: 'ignore' }
  /** The URL field is focused: the browser inserts the text, the preview starts right after. */
  | { action: 'preview-after-default' }
  /** Nobody has the text: put it (trimmed) into the URL field and preview at once. */
  | { action: 'capture'; text: string };

export function routePaste(context: PasteContext): PasteRoute {
  if (!context.inputAvailable || context.overlayOpen) return { action: 'ignore' };
  const text = context.text.trim();
  if (text === '') return { action: 'ignore' };
  if (context.target === 'primary') return { action: 'preview-after-default' };
  if (context.target === 'editable' || context.target === 'interactive')
    return { action: 'ignore' };
  return { action: 'capture', text };
}

export interface KeyContext {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  target: TargetKind;
  /** The URL field currently holds text. */
  inputHasText: boolean;
  inputAvailable: boolean;
  overlayOpen: boolean;
}

export type KeyRoute =
  | { action: 'ignore' }
  /** Focus the URL field and insert `text` at its end. */
  | { action: 'type'; text: string }
  /** Empty the URL field. */
  | { action: 'clear' };

/** A single visible character; whitespace is left to the page (Space scrolls). */
function printable(key: string): boolean {
  return [...key].length === 1 && key.trim() !== '';
}

export function routeKeydown(context: KeyContext): KeyRoute {
  if (!context.inputAvailable || context.overlayOpen) return { action: 'ignore' };
  if (context.defaultPrevented || context.isComposing) return { action: 'ignore' };
  if (context.key === 'Escape') {
    const ownsKey =
      context.target === 'none' || context.target === 'primary' || context.target === 'passive';
    return context.inputHasText && ownsKey ? { action: 'clear' } : { action: 'ignore' };
  }
  if (context.ctrlKey || context.metaKey || context.altKey) return { action: 'ignore' };
  if (!printable(context.key)) return { action: 'ignore' };
  if (context.target === 'none' || context.target === 'passive') {
    return { action: 'type', text: context.key };
  }
  return { action: 'ignore' };
}

/** Reads `element` and its ancestors into descriptors; the only DOM-aware code of this module. */
export function describeChain(
  element: Element | null,
  primary: Element | null,
): readonly ElementInfo[] {
  const chain: ElementInfo[] = [];
  for (let node = element; node !== null; node = node.parentElement) {
    const tabAttribute = node.getAttribute('tabindex');
    const tabValue = tabAttribute === null ? Number.NaN : Number.parseInt(tabAttribute, 10);
    const contentEditable = node.getAttribute('contenteditable');
    chain.push({
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute('role'),
      inputType: node instanceof HTMLInputElement ? node.type.toLowerCase() : null,
      contentEditable:
        (node instanceof HTMLElement && node.isContentEditable) ||
        (contentEditable !== null && contentEditable !== 'false'),
      tabIndex: Number.isNaN(tabValue) ? null : tabValue,
      hasHref: node.hasAttribute('href'),
      disabled: node.matches(':disabled'),
      readOnly:
        node.getAttribute('aria-readonly') === 'true' ||
        ((node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) &&
          node.readOnly),
      isPrimaryInput: node === primary,
      returnFocus: node.hasAttribute('data-return-focus'),
    });
  }
  return chain;
}
