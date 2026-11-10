/** Service worker (Chrome) / event page (Firefox) wiring: binds background.ts to chrome.*. */
import { answerResolve, handleCopy, type CopyDeps, type NotifyState } from './background';
import { EXPLICIT_TIMEOUT_MS, INTERCEPT_TIMEOUT_MS, ORIGIN, RELAY_MARGIN_MS } from './config';
import { createKeyStore, type StorageArea } from './keys';
import { resolveLink, type Kind } from './link-service';

// chrome.storage areas are overloaded (callback/promise, keys/defaults); this adapter pins
// the one promise form the key store needs.
function area(a: chrome.storage.StorageArea): StorageArea {
  return {
    get: (key) => a.get(key),
    set: (items) => a.set(items),
    remove: (key) => a.remove(key),
  };
}

const local = area(chrome.storage.local);
// storage.session (Chrome 102+, Firefox 115+) holds the public-proof cache so it dies with
// the browser session instead of accumulating forever.
const keys = createKeyStore(local, area(chrome.storage.session));
const now = (): number => Date.now();
// A bare `fetch` stored on an object and called as `deps.fetch(...)` runs with that object as
// `this` and throws "Illegal invocation"; binding keeps it callable from any object.
const netFetch = fetch.bind(globalThis);

const BADGE: Record<NotifyState, { text: string; color: string }> = {
  ok: { text: 'OK', color: '#2e7d32' },
  no_key: { text: '!', color: '#c62828' },
  error: { text: '!', color: '#c62828' },
};

async function notify(state: NotifyState, text: string): Promise<void> {
  const badge = BADGE[state];
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setTitle({ title: `ntn-link: ${text}` });
  setTimeout(() => {
    void chrome.action.setBadgeText({ text: '' });
    void chrome.action.setTitle({ title: 'Copy pretty ntn-link' });
  }, 3000);
}

/**
 * Registers every listener. Called synchronously at the top level of the entry script:
 * MV3 only wakes a stopped service worker for listeners registered during its first turn.
 * `copy` is the one browser-specific piece (see clipboard-chrome.ts / clipboard-firefox.ts).
 */
export function startBackground(copy: (text: string) => Promise<void>): void {
  const copyDeps: CopyDeps = {
    async activeTabUrl() {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.url;
    },
    resolve: (url, kind) =>
      resolveLink({
        url,
        kind,
        keys,
        fetch: netFetch,
        timeoutMs: EXPLICIT_TIMEOUT_MS,
        origin: ORIGIN,
        now,
      }),
    copy,
    notify,
    async openOptions(path) {
      await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
    },
  };

  const COMMANDS: Record<string, Kind> = { 'copy-pretty': 'pretty', 'copy-fast': 'fast' };

  chrome.commands.onCommand.addListener((command) => {
    const kind = COMMANDS[command];
    if (kind !== undefined) void handleCopy(kind, copyDeps);
  });

  chrome.action.onClicked.addListener(() => {
    void handleCopy('pretty', copyDeps);
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // Only our own content scripts: a message from another extension is not a relay request.
    if (sender.id !== chrome.runtime.id) return false;
    const answer = answerResolve(message, {
      keys,
      fetch: netFetch,
      now,
      // Shorter than the page-side wait so the chain ends before the wrapper gives up.
      timeoutMs: INTERCEPT_TIMEOUT_MS - RELAY_MARGIN_MS,
      origin: ORIGIN,
    });
    if (answer === undefined) return false;
    answer.then(sendResponse, () => {
      sendResponse(null);
    });
    return true;
  });
}
