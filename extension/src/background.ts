/**
 * Service-worker logic with every browser API injected, so it is testable without a browser.
 * `background-main.ts` wires it to `chrome.*`.
 */
import type { Kind, ResolveResult } from './link-service';
import { RELAY_MARGIN_MS } from './config';
import { interceptionLink, type PolicyDeps } from './intercept-policy';

export type NotifyState = 'ok' | 'no_key' | 'error';

export interface CopyDeps {
  activeTabUrl(): Promise<string | undefined>;
  resolve(url: string, kind: Kind): Promise<ResolveResult>;
  copy(text: string): Promise<void>;
  notify(state: NotifyState, text: string): Promise<void>;
  /** Receives a path relative to the extension root, e.g. `options.html?url=...`. */
  openOptions(path: string): Promise<void>;
}

const NOT_NOTION = 'Open a public Notion page first';

/** Explicit user action (toolbar button or shortcut). Never throws. */
// Toolbar and shortcuts share one sequence: a slow earlier action must not overwrite the
// clipboard after the user already copied something newer.
let latestAction = 0;

export async function handleCopy(kind: Kind, deps: CopyDeps): Promise<void> {
  const mine = ++latestAction;
  try {
    const url = await deps.activeTabUrl();
    if (url === undefined) {
      await deps.notify('error', NOT_NOTION);
      return;
    }
    const out = await deps.resolve(url, kind);
    if (mine !== latestAction) return;
    if (out.ok) {
      await deps.copy(out.link);
      await deps.notify('ok', 'Link copied');
      return;
    }
    if (out.reason === 'no_key') {
      const ws = out.workspace === undefined ? '' : `&ws=${encodeURIComponent(out.workspace)}`;
      await deps.openOptions(`options.html?url=${encodeURIComponent(url)}${ws}`);
      await deps.notify('no_key', out.message);
      return;
    }
    await deps.notify('error', out.reason === 'not_notion' ? NOT_NOTION : out.message);
  } catch {
    await deps.notify('error', 'Could not copy the link').catch(() => undefined);
  }
}

/**
 * Answers `{type:'ntn-resolve', url}` from the relay. Anything else is not ours (returns
 * undefined so other listeners, such as the offscreen document, can answer).
 */
export function answerResolve(
  message: unknown,
  deps: PolicyDeps,
): Promise<string | null> | undefined {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== 'ntn-resolve'
  ) {
    return undefined;
  }
  if (!('url' in message) || typeof message.url !== 'string') return Promise.resolve(null);
  // The page already spent part of its budget (e.g. decoding the clipboard item); the chain
  // gets what is left, minus a margin so the page never gives up first.
  const budget =
    'budgetMs' in message && typeof message.budgetMs === 'number' ? message.budgetMs : null;
  const timeoutMs =
    budget === null ? deps.timeoutMs : Math.min(deps.timeoutMs, budget - RELAY_MARGIN_MS);
  if (timeoutMs <= 0) return Promise.resolve(null);
  return interceptionLink(message.url, { ...deps, timeoutMs });
}
