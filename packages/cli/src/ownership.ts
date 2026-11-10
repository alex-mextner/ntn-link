/**
 * Proof of workspace ownership (spec section 4) from the client side.
 * The claimToken exists only in the local variables of proveOwnership: it is never
 * logged, never printed and never written to disk.
 */
import { ApiFailure } from './api';
import { type Ctx, say } from './ctx';
import { EXIT, Fail } from './errors';
import type { ChallengeAction, ChallengeResponse, VerifyResponse } from '../../core/src/api-types';

const MAX_VERIFY_ATTEMPTS = 5;

/** Any ownership code, not just ours: leftovers of earlier attempts count too. */
export const VERIFY_CODE = /ntn-verify-[a-z0-9]{10}/;

function nonceInstructions(challenge: ChallengeResponse): string[] {
  const ws = challenge.workspace;
  const why =
    challenge.action === 'rotate'
      ? `The key stored for "${ws}" is missing or no longer valid. Proving control again issues a new key.`
      : `Links under "${ws}" need proof that you control that Notion workspace.`;
  return [
    why,
    '',
    '  1. Open any public page of that workspace (the page you are linking works).',
    '  2. Put this text into its title, anywhere in it:',
    '',
    `       ${challenge.nonce}`,
    '',
    '  3. Publish the page and wait a few seconds. If you used a different page than the one',
    '     you are linking, you will paste its URL below.',
    `The code expires at ${challenge.expiresAt}. You can remove it from the title as soon as this succeeds.`,
  ];
}

/**
 * Stores the new key unless another run saved a different one since this flow began (then that
 * newer key wins and is the one to use). Returns the key to continue with.
 */
function saveKey(ctx: Ctx, ws: string, key: string, previous: string | null): string {
  try {
    if (ctx.keys.set(ctx.origin, ws, key, previous)) return key;
    say(
      ctx,
      'Another ntn-link run saved a newer key for this workspace meanwhile; keeping that one.',
    );
    return ctx.keys.get(ctx.origin, ws) ?? key;
  } catch (error) {
    // The link can still be created with the in-memory key; only a later run will need a rotation.
    const reason = error instanceof Error ? error.message : String(error);
    say(
      ctx,
      `Warning: could not save the owner key (${reason}); the next run will need to verify again.`,
    );
    return key;
  }
}

function reportVerified(ctx: Ctx, result: VerifyResponse): void {
  if (result.action !== 'rotate') {
    say(ctx, `Verified. You now own "${result.workspace}".`);
    return;
  }
  say(
    ctx,
    `Key rotated; ${result.removedLinks} link(s) pointing to pages that are no longer public were removed.`,
  );
  if (!result.cleanupComplete) {
    say(
      ctx,
      'Warning: the service could not finish removing links to pages that are no longer public; some may remain until it sweeps again.',
    );
  }
}

export interface Proof {
  key: string;
  /** The page the service checked: the linked page unless the user named another. */
  verifiedUrl: string;
}

export async function proveOwnership(
  ctx: Ctx,
  url: string,
  action: ChallengeAction,
): Promise<Proof> {
  if (!ctx.io.isTTY) {
    throw new Fail(
      'This workspace needs a one-time ownership check that must be done in a terminal. ' +
        `Run \`ntn-link ${url}\` interactively once; the key is then saved and later runs need no terminal.`,
      EXIT.verificationNeedsTerminal,
    );
  }
  say(ctx, 'Requesting an ownership challenge...');
  const challenge = await ctx.api.challenge(url, action);
  ctx.log.secret(challenge.claimToken);
  if (!/^ntn-verify-[a-z0-9]+$/.test(challenge.nonce)) {
    throw new Fail('The server returned a malformed challenge code.', EXIT.failure);
  }
  ctx.log.write(
    `challenge issued: ${challenge.action} nonce=${challenge.nonce} expires=${challenge.expiresAt}`,
  );
  for (const line of nonceInstructions(challenge)) say(ctx, line);

  const previous = ctx.keys.get(ctx.origin, challenge.workspace);
  let verifiedUrl = url;
  for (let attempt = 1; ; attempt++) {
    const answer = await ctx.io.ask(
      'Press Enter when the title is published (or paste the URL of the page that carries the code): ',
    );
    verifiedUrl = answer.trim() || verifiedUrl;
    say(
      ctx,
      'Checking (a key rotation can take a while: the service re-checks your existing links)...',
    );
    try {
      const result = await ctx.api.verify(verifiedUrl, challenge.nonce, challenge.claimToken);
      ctx.log.secret(result.ownerKey);
      const key = saveKey(ctx, result.workspace, result.ownerKey, previous);
      reportVerified(ctx, result);
      return { key, verifiedUrl };
    } catch (error) {
      // The page title often takes a moment to publish; let the user retry the same challenge.
      const retryable = error instanceof ApiFailure && error.code === 'nonce_not_found';
      if (!retryable || attempt >= MAX_VERIFY_ATTEMPTS) throw error;
      say(ctx, error.message);
    }
  }
}

/**
 * When the code sits in the title of the page being linked, creating the link right away would
 * snapshot that title (and derive the slug from it). Wait until the page is clean again.
 */
export async function waitForCleanTitle(ctx: Ctx, url: string): Promise<void> {
  if (!ctx.io.isTTY) {
    throw new Fail(
      'The page title still contains an ownership code (ntn-verify-...). Remove it, then run the command again.',
      EXIT.failure,
    );
  }
  say(
    ctx,
    'Now remove the code from the page title and publish, so the link preview does not carry it.',
  );
  for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
    await ctx.io.ask('Press Enter when the code is gone from the title: ');
    const { card } = await ctx.api.preview(url);
    if (!VERIFY_CODE.test(card.title)) return;
    say(ctx, 'Notion still shows the code in the title; give it a few seconds.');
  }
  throw new Fail(
    'The code is still in the page title. Your key is saved: remove the code and run the same command again.',
    EXIT.failure,
  );
}
