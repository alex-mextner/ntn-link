/** Options page controller. Owner keys are never rendered; the claim token lives in memory only. */
import type { ChallengeAction } from '../../packages/core/src/api-types';
import { ORIGIN } from './config';
import { createKeyStore, type StorageArea } from './keys';
import {
  requestChallenge,
  saveOwnerKey,
  setAutoWorkspace,
  verifyChallenge,
  workspaceFromUrl,
} from './options-logic';

function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`options.html is missing #${id}`);
  return found;
}

function area(a: chrome.storage.StorageArea): StorageArea {
  return {
    get: (key) => a.get(key),
    set: (items) => a.set(items),
    remove: (key) => a.remove(key),
  };
}

const keys = createKeyStore(area(chrome.storage.local));
const deps = { origin: ORIGIN, fetch: globalThis.fetch.bind(globalThis) };

const status = el('status', HTMLParagraphElement);
function say(kind: 'ok' | 'error', text: string): void {
  status.dataset.kind = kind;
  status.textContent = text;
}

// In-memory only: a stored claim token would outlive the 15 minute challenge for no reason.
let pending: { url: string; nonce: string; claimToken: string } | null = null;

async function renderWorkspaces(): Promise<void> {
  const list = el('workspaces', HTMLUListElement);
  list.replaceChildren();
  for (const ws of await keys.listWorkspaces()) {
    const item = document.createElement('li');
    item.className = 'ws';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = `auto-${ws}`;
    box.checked = await keys.isAutoEnabled(ws);
    const label = document.createElement('label');
    label.htmlFor = box.id;
    label.style.display = 'inline';
    const hasKey = (await keys.getKey(ws)) !== null;
    label.textContent = ` Replace Notion's Copy link for ${ws} (${hasKey ? 'owner key saved' : 'no owner key yet'})`;
    box.addEventListener('change', () => {
      void setAutoWorkspace(keys, ws, box.checked).then(renderWorkspaces);
    });
    item.append(box, label);
    if (hasKey) {
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.textContent = 'Forget key';
      forget.setAttribute('aria-label', `Forget the owner key for ${ws}`);
      forget.addEventListener('click', () => {
        void keys.removeKey(ws).then(renderWorkspaces);
      });
      item.append(forget);
    }
    list.append(item);
  }
}

el('origin', HTMLElement).textContent = ORIGIN;

el('add-form', HTMLFormElement).addEventListener('submit', (event) => {
  event.preventDefault();
  const input = el('add-ws', HTMLInputElement);
  // Adding a workspace never switches anything on: the checkbox stays off until clicked.
  void setAutoWorkspace(keys, input.value, false).then(async (res) => {
    if (!res.ok) return say('error', res.message);
    input.value = '';
    say('ok', `Added ${res.workspace}. Interception is still off for it.`);
    await renderWorkspaces();
  });
});

el('challenge-form', HTMLFormElement).addEventListener('submit', (event) => {
  event.preventDefault();
  const url = el('claim-url', HTMLInputElement).value.trim();
  const picked = document.querySelector<HTMLInputElement>('input[name="action"]:checked');
  const action: ChallengeAction = picked?.value === 'rotate' ? 'rotate' : 'claim';
  void requestChallenge(deps, url, action).then((res) => {
    if (!res.ok) return say('error', res.message);
    pending = { url, nonce: res.nonce, claimToken: res.claimToken };
    el('nonce', HTMLElement).textContent = res.nonce;
    el('verify', HTMLElement).hidden = false;
    say('ok', `Challenge for ${res.workspace} created; it expires at ${res.expiresAt}.`);
  });
});

el('copy-nonce', HTMLButtonElement).addEventListener('click', () => {
  if (pending) void navigator.clipboard.writeText(pending.nonce);
});

el('verify-button', HTMLButtonElement).addEventListener('click', (event) => {
  const current = pending;
  if (!current) return;
  const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
  // One request per press: a double click must not spend a second verification attempt.
  if (button) button.disabled = true;
  // The nonce may be published on any public page of the workspace, so the URL is read now.
  const verifyUrl = el('claim-url', HTMLInputElement).value.trim() || current.url;
  void verifyChallenge(deps, keys, { ...current, url: verifyUrl })
    .then(async (res) => {
      if (!res.ok) return say('error', res.message);
      // A newer challenge started meanwhile keeps its token and controls.
      if (pending === current) {
        pending = null;
        el('verify', HTMLElement).hidden = true;
      }
      say('ok', `Verified. Owner key for ${res.workspace} saved in this browser.`);
      await renderWorkspaces();
    })
    .finally(() => {
      if (button) button.disabled = false;
    });
});

el('key-form', HTMLFormElement).addEventListener('submit', (event) => {
  event.preventDefault();
  const ws = el('key-ws', HTMLInputElement);
  const key = el('key-value', HTMLInputElement);
  void saveOwnerKey(keys, ws.value, key.value).then(async (res) => {
    if (!res.ok) return say('error', res.message);
    key.value = '';
    say('ok', `Owner key for ${res.workspace} saved.`);
    await renderWorkspaces();
  });
});

const prefill = new URLSearchParams(location.search).get('url');
if (prefill !== null) {
  el('claim-url', HTMLInputElement).value = prefill;
  const ws = new URLSearchParams(location.search).get('ws') ?? workspaceFromUrl(prefill);
  if (ws !== null) {
    el('key-ws', HTMLInputElement).value = ws;
    el('add-ws', HTMLInputElement).value = ws;
  }
}
void renderWorkspaces();
