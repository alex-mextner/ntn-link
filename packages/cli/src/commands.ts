/** The four user-facing commands. Only `create` ever prints a link on stdout. */
import { ApiFailure } from './api';
import type { Command } from './args';
import { type Ctx, keyFor, say } from './ctx';
import { EXIT, Fail, plainText } from './errors';
import { VERIFY_CODE, proveOwnership, waitForCleanTitle } from './ownership';
import type { CreateLinkRequest, LinkView, UpdateLinkRequest } from '../../core/src/api-types';

type Of<K extends Command['kind']> = Extract<Command, { kind: K }>;

/** Creates the link; if the server wants proof of ownership, runs the challenge once and retries. */
async function createWithOwnership(
  ctx: Ctx,
  body: CreateLinkRequest,
  ws: string,
): Promise<LinkView> {
  const saved = keyFor(ctx, ws);
  try {
    return (await ctx.api.createLink(body, saved)).link;
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.code !== 'needs_verification') throw error;
    if (saved) say(ctx, `The saved key for "${ws}" was not accepted.`);
    const action = error.action ?? (saved ? 'rotate' : 'claim');
    const proof = await proveOwnership(ctx, body.url, action);
    if (isSamePage(proof.verifiedUrl, body.url)) await waitForCleanTitle(ctx, body.url);
    return (await ctx.api.createLink(body, proof.key)).link;
  }
}

/** Notion URLs for one page differ (host, slug text, query); the 32-hex page id is what identifies it. */
function pageId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const last = parsed.pathname.split('/').findLast((part) => part !== '') ?? '';
  // The id is the tail of the last segment ("Title-<32 hex>" or a bare/dashed uuid); joining the
  // whole URL would glue a hex-looking title letter onto it.
  const candidates = [last, parsed.searchParams.get('p') ?? ''];
  for (const candidate of candidates) {
    const dashed = /(?:^|-)([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.exec(candidate);
    if (dashed?.[1]) return dashed[1].replaceAll('-', '').toLowerCase();
    const plain = /(?:^|-)([0-9a-f]{32})$/i.exec(candidate);
    if (plain?.[1]) return plain[1].toLowerCase();
  }
  return null;
}

/** Unknown identity counts as "same page": the cautious side is to ask for the title clean-up. */
function isSamePage(a: string, b: string): boolean {
  const idA = pageId(a);
  const idB = pageId(b);
  return idA === null || idB === null || idA === idB;
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
  const link = await createWithOwnership(ctx, body, preview.workspace);
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
