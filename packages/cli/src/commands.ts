/** The user-facing commands. Only `create` ever prints a link on stdout. */
import { ApiFailure, NetworkFailure } from './api';
import type { Command } from './args';
import { type Ctx, keyFor, say } from './ctx';
import { EXIT, Fail, plainText } from './errors';
import { VERIFY_CODE, proveOwnership, waitForCleanTitle } from './ownership';
import type {
  ChallengeAction,
  CreateLinkRequest,
  LinkView,
  SweepLinksResponse,
  UpdateLinkRequest,
} from '../../core/src/api-types';

type Of<K extends Command['kind']> = Extract<Command, { kind: K }>;

const needsVerification = (error: unknown): error is ApiFailure =>
  error instanceof ApiFailure && error.code === 'needs_verification';

/**
 * Creates the link; if the server wants proof of ownership, runs the challenge once and retries.
 * `linkedPageId` is the page id the service resolved for the URL being linked.
 */
async function createWithOwnership(
  ctx: Ctx,
  body: CreateLinkRequest,
  ws: string,
  linkedPageId: string,
): Promise<LinkView> {
  const saved = keyFor(ctx, ws);
  try {
    return (await ctx.api.createLink(body, saved)).link;
  } catch (error) {
    if (!needsVerification(error)) throw error;
    if (saved) say(ctx, `The saved key for "${ws}" was not accepted.`);
    const action = error.action ?? (saved ? 'rotate' : 'claim');
    return verifyAndCreate(ctx, body, ws, linkedPageId, saved, action);
  }
}

async function verifyAndCreate(
  ctx: Ctx,
  body: CreateLinkRequest,
  ws: string,
  linkedPageId: string,
  firstKey: string | null,
  firstAction: ChallengeAction,
): Promise<LinkView> {
  let saved = firstKey;
  let action = firstAction;
  for (;;) {
    const proof = await proveOwnership(ctx, body.url, ws, action, saved);
    if (proof.verifiedUrl !== null) {
      if (await isLinkedPage(ctx, proof.verifiedUrl, body.url, linkedPageId)) {
        await waitForCleanTitle(ctx, body.url);
      }
      return (await ctx.api.createLink(body, proof.key)).link;
    }
    const created = await createWithOtherRunsKey(ctx, body, proof.key);
    if (!(created instanceof ApiFailure)) return created;
    // The service rejected that key too: verify again, against it.
    saved = proof.key;
    action = created.action ?? 'rotate';
  }
}

/**
 * Another run finished the ownership check while this one waited: use its key. That run may still
 * be waiting for the code to leave the title of this very page. Returns the failure when the
 * service wants another verification.
 */
async function createWithOtherRunsKey(
  ctx: Ctx,
  body: CreateLinkRequest,
  key: string,
): Promise<LinkView | ApiFailure> {
  if (VERIFY_CODE.test((await ctx.api.preview(body.url)).card.title)) {
    await waitForCleanTitle(ctx, body.url);
  }
  try {
    return (await ctx.api.createLink(body, key)).link;
  } catch (error) {
    if (needsVerification(error)) return error;
    throw error;
  }
}

/**
 * Whether the page the code was verified on is the page being linked. Notion URLs for one page
 * differ in many ways (host, slug text, encoding, query), so the service's own page id decides,
 * never a local parse of the URL. If the service cannot tell, assume yes: the cautious side is to
 * ask for the title clean-up.
 */
async function isLinkedPage(
  ctx: Ctx,
  verifiedUrl: string,
  linkedUrl: string,
  linkedPageId: string,
): Promise<boolean> {
  if (verifiedUrl === linkedUrl) return true;
  try {
    return (await ctx.api.preview(verifiedUrl)).pageId === linkedPageId;
  } catch (error) {
    if (!(error instanceof ApiFailure || error instanceof NetworkFailure)) throw error;
    ctx.log.write(
      `could not resolve the verified page, assuming it is the linked page: ${error.message}`,
    );
    return true;
  }
}

async function copyLink(ctx: Ctx, url: string): Promise<void> {
  if (await ctx.io.copy(url)) {
    say(ctx, 'Copied to the clipboard.');
    return;
  }
  say(
    ctx,
    'Warning: no clipboard tool found (tried pbcopy, wl-copy, xclip, xsel); the link was not copied.',
  );
}

export async function create(ctx: Ctx, cmd: Of<'create'>): Promise<void> {
  say(ctx, 'Checking the page...');
  // The workspace decides which saved key to use, and only the server can parse every URL form.
  const preview = await ctx.api.preview(cmd.url);
  // --fast only selects which link is printed; whether the fast page exists is the service default (on).
  const body: CreateLinkRequest = { url: cmd.url, slug: cmd.slug };
  // A code left in the title (an interrupted earlier run) must not be snapshotted into the link.
  if (VERIFY_CODE.test(preview.card.title)) await waitForCleanTitle(ctx, cmd.url);
  const link = await createWithOwnership(ctx, body, preview.workspace, preview.pageId);
  const url = cmd.fast ? link.fastUrl : link.redirectUrl;
  if (url === null)
    throw new Fail('The server did not return a fast link for this page.', EXIT.failure);
  assertPlainUrl(url);
  ctx.io.stdout(`${url}\n`);
  ctx.log.write(`result: ${url}`);
  if (cmd.copy) await copyLink(ctx, url);
}

export async function list(ctx: Ctx, ws: string): Promise<void> {
  const { links } = await ctx.api.listLinks(ws, keyFor(ctx, ws));
  if (links.length === 0) say(ctx, `No links in "${ws}".`);
  for (const link of links) {
    const cells = [link.slug, link.card.title, link.redirectUrl].map(plainText);
    ctx.io.stdout(`${cells.join('\t')}\n`);
  }
}

/** stdout is scripted (`$(ntn-link ...)`, clipboards): only a clean http(s) URL may ever be printed there. */
function assertPlainUrl(url: string): void {
  let ok = plainText(url) === url;
  try {
    ok = ok && ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    ok = false;
  }
  if (!ok)
    throw new Fail('The server returned a link that is not a plain http(s) URL.', EXIT.failure);
}

const workspaceOf = (target: string): string => target.split('/')[0] ?? '';

export async function remove(ctx: Ctx, target: string): Promise<void> {
  await ctx.api.deleteLink(target, keyFor(ctx, workspaceOf(target)));
  say(ctx, `Deleted ${target}.`);
}

/** An empty string on the command line means "remove this override" (null in the API). */
function override(value: string | undefined): string | null | undefined {
  return value === '' ? null : value;
}

function updateBody(cmd: Of<'set'>): UpdateLinkRequest {
  const title = override(cmd.title);
  const description = override(cmd.description);
  // Undefined fields vanish in JSON.stringify, which is what "not specified" means to the API.
  return {
    slug: cmd.slug,
    fast: cmd.fast,
    canonicalMode: cmd.canonicalMode,
    overrides:
      title === undefined && description === undefined ? undefined : { title, description },
  };
}

export async function update(ctx: Ctx, cmd: Of<'set'>): Promise<void> {
  const { link } = await ctx.api.updateLink(
    cmd.target,
    updateBody(cmd),
    keyFor(ctx, workspaceOf(cmd.target)),
  );
  say(ctx, `Updated ${link.workspace}/${link.slug}: ${link.redirectUrl}`);
}

const SWEEP_ATTEMPTS = 10;
const SWEEP_DELAY_MS = 2000;

/**
 * Finishes the cleanup after a key rotation: the service removes links to pages that are no
 * longer public and says when it is done. Repeats a bounded number of times, silently, and ends
 * with one summary line on stderr (stdout stays empty).
 */
export async function sweep(ctx: Ctx, ws: string): Promise<void> {
  const key = keyFor(ctx, ws);
  let removed = 0;
  for (let attempt = 1; attempt <= SWEEP_ATTEMPTS; attempt++) {
    let result: SweepLinksResponse;
    try {
      result = await ctx.api.sweepLinks(ws, key);
    } catch (error) {
      // A service without the route answers 404/405 whatever the body says.
      if (error instanceof ApiFailure && (error.status === 404 || error.status === 405)) {
        throw new Fail(
          `The service at ${ctx.origin} does not support sweeping (HTTP ${error.status}); it may be an older version.`,
          EXIT.sweepUnsupported,
        );
      }
      throw error;
    }
    removed += result.removedLinks;
    ctx.log.write(
      `sweep attempt ${attempt}: removed=${result.removedLinks} complete=${result.cleanupComplete}`,
    );
    if (result.cleanupComplete) {
      say(ctx, `Swept "${ws}": removed ${removed} link(s); cleanup complete.`);
      return;
    }
    if (attempt < SWEEP_ATTEMPTS) await ctx.io.sleep(SWEEP_DELAY_MS);
  }
  throw new Fail(
    `Swept "${ws}": removed ${removed} link(s) but the service has not finished after ${SWEEP_ATTEMPTS} attempts. Run it again later: ntn-link sweep ${ws}`,
    EXIT.sweepIncomplete,
  );
}
