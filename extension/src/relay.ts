/**
 * Isolated-world relay between the page-world interceptor and the service worker.
 *
 * The page cannot call the extension directly and must not need to: requests travel
 * page -> window.postMessage -> relay -> runtime message -> service worker, which also
 * sidesteps Notion's CSP and CORS. The page (Notion's own scripts included) can send the
 * same messages, so nothing here is trusted: the service worker applies every privacy gate.
 */

export const REQUEST_TYPE = 'ntn-link:resolve';
export const REPLY_TYPE = 'ntn-link:reply';

export interface MessageWindow {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
  readonly origin: string;
}

/** Page side: ask the relay for a replacement link; resolves null on timeout or any problem. */
export function createAsk(
  win: MessageWindow,
  nextId: () => string,
): (url: string, timeoutMs: number) => Promise<string | null> {
  return (url, timeoutMs) =>
    new Promise((resolve) => {
      const id = nextId();
      const finish = (value: string | null): void => {
        clearTimeout(timer);
        win.removeEventListener('message', onMessage);
        resolve(value);
      };
      const onMessage = (event: MessageEvent): void => {
        const data: unknown = event.data;
        if (
          event.source === win &&
          typeof data === 'object' &&
          data !== null &&
          'type' in data &&
          data.type === REPLY_TYPE &&
          'id' in data &&
          data.id === id
        ) {
          finish('link' in data && typeof data.link === 'string' ? data.link : null);
        }
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      win.addEventListener('message', onMessage);
      try {
        win.postMessage({ type: REQUEST_TYPE, id, url, budgetMs: timeoutMs }, win.origin);
      } catch {
        finish(null);
      }
    });
}

/** Isolated side: forwards requests to the service worker and posts the answer back. */
export function startRelay(
  win: MessageWindow,
  send: (message: { type: 'ntn-resolve'; url: string; budgetMs?: number }) => Promise<unknown>,
): void {
  win.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      event.source !== win ||
      typeof data !== 'object' ||
      data === null ||
      !('type' in data) ||
      data.type !== REQUEST_TYPE ||
      !('id' in data) ||
      typeof data.id !== 'string' ||
      !('url' in data) ||
      typeof data.url !== 'string'
    ) {
      return;
    }
    const { id, url } = data;
    // The page's remaining time: the worker must not start a fresh budget after the page gave up.
    const budgetMs =
      'budgetMs' in data && typeof data.budgetMs === 'number' ? data.budgetMs : undefined;
    const reply = (link: string | null): void => {
      try {
        win.postMessage({ type: REPLY_TYPE, id, link }, win.origin);
      } catch {
        // Opaque-origin documents cannot be targeted; the page side then times out to the
        // original text, which is the safe outcome.
      }
    };
    send({ type: 'ntn-resolve', url, ...(budgetMs === undefined ? {} : { budgetMs }) }).then(
      (answer) => {
        reply(typeof answer === 'string' ? answer : null);
      },
      () => {
        reply(null);
      },
    );
  });
}
