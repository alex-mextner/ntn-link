/**
 * Chrome offscreen document: a service worker has no clipboard, so the copy happens here
 * with execCommand on a temporary textarea (the one clipboard path available without focus).
 */
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== 'ntn-offscreen-copy' ||
    !('text' in message) ||
    typeof message.text !== 'string'
  ) {
    return false;
  }
  const box = document.createElement('textarea');
  box.value = message.text;
  document.body.append(box);
  box.select();
  const ok = document.execCommand('copy');
  box.remove();
  sendResponse(ok);
  return false;
});
