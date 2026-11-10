/**
 * Page-world (MAIN) wrapper around the async Clipboard API.
 *
 * Notion's "Copy link" builds the URL and awaits `navigator.clipboard.write` (or
 * `writeText`); wrapping those two methods is enough to substitute the text. The wrapper
 * is deliberately timid: any doubt, error or delay means the ORIGINAL payload is written
 * unchanged, and it never throws or rejects for its own reasons.
 */

import { INTERCEPT_TIMEOUT_MS } from './config';

export interface InterceptDeps {
  /** The object whose `write`/`writeText` are replaced (`Clipboard.prototype` in a page). */
  target: Pick<Clipboard, 'write' | 'writeText'>;
  /** Asks the extension for a replacement; null means "leave it". Must not throw ideally. */
  ask(url: string, timeoutMs: number): Promise<string | null>;
  isNotionPageUrl(text: string): boolean;
  /** Registers a callback for copies that bypass the wrapped methods (Ctrl+C, execCommand). */
  watchNativeCopy?(onCopy: () => void): void;
  /** Builds the single-item payload `write` expects (ClipboardItem is page-global). */
  textItem(text: string): ClipboardItem;
}

export interface InterceptOptions {
  timeoutMs?: number;
}

function isHttpUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

interface PlainTextItem {
  types: readonly string[];
  getType(type: 'text/plain'): Promise<Blob>;
}

function isPlainTextItem(item: unknown): item is PlainTextItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'types' in item &&
    Array.isArray(item.types) &&
    item.types.length === 1 &&
    item.types[0] === 'text/plain' &&
    'getType' in item &&
    typeof item.getType === 'function'
  );
}

function safely<T>(run: () => Promise<T>): Promise<T> {
  try {
    return run();
  } catch (error) {
    return Promise.reject(error);
  }
}

export function installInterceptor(deps: InterceptDeps, opts: InterceptOptions = {}): void {
  const timeoutMs = opts.timeoutMs ?? INTERCEPT_TIMEOUT_MS;
  const { target } = deps;
  const originalWrite = target.write;
  const originalWriteText = target.writeText;
  // Every wrapped call takes a number. A call that waited for a replacement and is no longer
  // the newest must not write at all: the user (or page) copied something newer meanwhile,
  // and a late write, even of the original text, would clobber it.
  let newest = 0;
  // A native copy is newer than any pending replacement and must not be overwritten by it.
  deps.watchNativeCopy?.(() => {
    newest++;
  });

  async function replacement(url: string, budgetMs: number): Promise<string | null> {
    if (budgetMs <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs);
    });
    try {
      const link = await Promise.race([deps.ask(url, budgetMs), deadline]);
      // Whatever the relay sends back is page-reachable data: only a plain URL is accepted.
      return typeof link === 'string' && isHttpUrl(link) ? link : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function writeTextWrapped(self: Clipboard, text: string): Promise<void> {
    const mine = ++newest;
    let out = text;
    try {
      if (typeof text === 'string' && deps.isNotionPageUrl(text)) {
        out = (await replacement(text, timeoutMs)) ?? text;
      }
    } catch {
      out = text;
    }
    if (mine !== newest) return;
    return originalWriteText.call(self, out);
  }

  async function replaceItems(
    items: ClipboardItems,
    expired: () => boolean,
    startedAt: number,
  ): Promise<ClipboardItems> {
    // Only a lone text/plain item is Notion's Copy link; anything richer is left alone
    // because rebuilding it as plain text would silently drop formats.
    const only = Array.isArray(items) && items.length === 1 ? items[0] : undefined;
    if (!isPlainTextItem(only)) return items;
    const text = await (await only.getType('text/plain')).text();
    // After the deadline the original payload is already being written; starting the proof
    // and link creation now would act on a copy the user no longer gets a link for.
    if (expired() || !deps.isNotionPageUrl(text)) return items;
    const link = await replacement(text, timeoutMs - (Date.now() - startedAt));
    return link === null ? items : [deps.textItem(link)];
  }

  async function writeWrapped(self: Clipboard, items: ClipboardItems): Promise<void> {
    const mine = ++newest;
    let out = items;
    // Decoding a (possibly promise-backed) item counts against the same deadline: a slow item
    // must not push the native write past the click's transient activation.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let late = false;
    try {
      out = await Promise.race([
        replaceItems(items, () => late, Date.now()),
        new Promise<ClipboardItems>((resolve) => {
          timer = setTimeout(() => {
            late = true;
            resolve(items);
          }, timeoutMs);
        }),
      ]);
    } catch {
      out = items;
    } finally {
      clearTimeout(timer);
    }
    if (mine !== newest) return;
    return originalWrite.call(self, out);
  }

  target.writeText = function writeText(this: Clipboard, text: string): Promise<void> {
    return safely(() => writeTextWrapped(this, text));
  };
  target.write = function write(this: Clipboard, items: ClipboardItems): Promise<void> {
    return safely(() => writeWrapped(this, items));
  };
}
