/** MAIN-world content script entry: wires the interceptor to the page's real Clipboard. */
import { installInterceptor } from './intercept-main';
import { classifyPageUrl } from './notion-url';
import { createAsk } from './relay';

let counter = 0;
const nextId = (): string =>
  `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2)}`;

// Without ClipboardItem (old browsers) Notion itself falls back to writeText, which is wrapped too.
if (typeof Clipboard !== 'undefined') {
  installInterceptor({
    target: Clipboard.prototype,
    ask: createAsk(window, nextId),
    // Workspace-less URLs are filtered by the service worker too; excluding them here
    // keeps those copies from even reaching the extension.
    isNotionPageUrl: (text) => classifyPageUrl(text)?.workspace != null,
    watchNativeCopy: (onCopy) => {
      for (const type of ['copy', 'cut']) document.addEventListener(type, onCopy, true);
    },
    textItem: (text) =>
      new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }) }),
  });
}
