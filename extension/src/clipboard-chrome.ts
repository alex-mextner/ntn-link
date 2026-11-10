/**
 * Chrome: a service worker has no clipboard, so the copy happens in an offscreen document
 * (see offscreen.ts) created on demand.
 */
let creating: Promise<void> | null = null;

// Chrome allows one offscreen document, and a document that exists may not have registered its
// message listener yet: every copy waits for the shared creation promise while one is pending.
async function ensureOffscreen(): Promise<void> {
  creating ??= (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification:
        'Write the ntn-link to the clipboard after the user pressed the button or shortcut.',
    });
  })().finally(() => {
    creating = null;
  });
  await creating;
}

export async function copyViaOffscreen(text: string): Promise<void> {
  await ensureOffscreen();
  const answer: unknown = await chrome.runtime.sendMessage({ type: 'ntn-offscreen-copy', text });
  if (answer !== true) throw new Error('clipboard write failed');
}
