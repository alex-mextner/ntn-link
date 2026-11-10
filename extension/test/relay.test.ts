import { describe, expect, test } from 'bun:test';
import { REPLY_TYPE, REQUEST_TYPE, createAsk, startRelay, type MessageWindow } from '../src/relay';

/** A window whose postMessage delivers back to its own listeners, as in a browser. */
class FakeWindow implements MessageWindow {
  readonly origin = 'https://thsm.notion.site';
  listeners = new Set<(e: MessageEvent) => void>();
  posted: unknown[] = [];
  addEventListener(_t: 'message', l: (e: MessageEvent) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'message', l: (e: MessageEvent) => void): void {
    this.listeners.delete(l);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
    this.deliver(message, this);
  }
  deliver(data: unknown, source: unknown): void {
    queueMicrotask(() => {
      for (const l of this.listeners) l({ data, source } as unknown as MessageEvent);
    });
  }
}

describe('relay round trip', () => {
  test('ask -> relay -> send -> reply resolves with the link', async () => {
    const win = new FakeWindow();
    const sent: unknown[] = [];
    startRelay(win, async (m) => {
      sent.push(m);
      return 'https://x.example/thsm/our-trips';
    });
    const ask = createAsk(win, () => 'id-1');
    expect(await ask('https://thsm.notion.site/abc', 200)).toBe('https://x.example/thsm/our-trips');
    expect(sent).toEqual([
      { type: 'ntn-resolve', url: 'https://thsm.notion.site/abc', budgetMs: 200 },
    ]);
  });

  test('relay failure or non-string answer resolves null; no listener is leaked', async () => {
    const win = new FakeWindow();
    startRelay(win, () => Promise.reject(new Error('worker asleep')));
    const ask = createAsk(win, () => 'id-2');
    expect(await ask('u', 200)).toBeNull();
    expect(win.listeners.size).toBe(1); // only the relay's own
  });

  test('no relay: ask times out with null', async () => {
    const win = new FakeWindow();
    const ask = createAsk(win, () => 'id-3');
    expect(await ask('u', 15)).toBeNull();
    expect(win.listeners.size).toBe(0);
  });

  test('messages from another window or with the wrong shape are ignored', async () => {
    const win = new FakeWindow();
    const sent: unknown[] = [];
    startRelay(win, async (m) => {
      sent.push(m);
      return 'x';
    });
    win.deliver({ type: REQUEST_TYPE, id: 'a', url: 'u' }, { other: true });
    win.deliver({ type: REQUEST_TYPE, id: 7, url: 'u' }, win);
    win.deliver({ type: 'other', id: 'a', url: 'u' }, win);
    win.deliver('string', win);
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([]);
  });

  test('a reply with a different id does not resolve the ask', async () => {
    const win = new FakeWindow();
    const ask = createAsk(win, () => 'mine');
    const pending = ask('u', 30);
    win.deliver({ type: REPLY_TYPE, id: 'theirs', link: 'https://evil.example/' }, win);
    expect(await pending).toBeNull();
  });
});
