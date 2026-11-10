/**
 * Resolves a Notion page URL to its ntn-link (pretty = redirect link, fast = `/read`).
 *
 * This is the path for EXPLICIT user actions (toolbar, shortcut) and the last step of the
 * gated automatic path; it may contact our API, including `/api/preview` for URLs that
 * name no workspace. The automatic path reaches it only after every privacy gate passed.
 */
import { callApi, isRecord, parseLinkView, type LinkSummary } from './api';
import { classifyPageUrl, type ClassifiedPage } from './notion-url';
import type { KeyStore } from './keys';
import { TIMED_OUT, withTimeout } from './timeout';

export type Kind = 'pretty' | 'fast';

export type ResolveResult =
  | { ok: true; link: string }
  | {
      ok: false;
      reason: 'not_notion' | 'no_key' | 'api_error' | 'timeout';
      message: string;
      /** Workspace the URL resolved to, when known; lets the options page prefill it. */
      workspace?: string;
    };

export interface ResolveArgs {
  url: string;
  kind: Kind;
  keys: KeyStore;
  fetch: typeof fetch;
  timeoutMs: number;
  origin: string;
  now: () => number;
}

export type ResolveLink = (args: ResolveArgs) => Promise<ResolveResult>;

const fail = (
  reason: 'api_error' | 'no_key',
  message: string,
  workspace?: string,
): ResolveResult => ({
  ok: false,
  reason,
  message,
  ...(workspace !== undefined ? { workspace } : {}),
});

function pick(link: { redirectUrl: string; fastUrl: string | null }, kind: Kind): string | null {
  return kind === 'fast' ? link.fastUrl : link.redirectUrl;
}

/** Thrown inside the pipeline below to carry a ready-made failure out of nested steps. */
class Stop extends Error {
  constructor(readonly result: ResolveResult) {
    super(result.ok ? 'ok' : result.message);
  }
}

const stop = (...args: Parameters<typeof fail>): never => {
  throw new Stop(fail(...args));
};

function isPublishedHost(url: string): boolean {
  try {
    return new URL(url.trim()).hostname.toLowerCase().endsWith('.notion.site');
  } catch {
    return false;
  }
}

// Two overlapping resolutions of one page would both list an empty namespace and both create
// a link (`/page` and `/page-2`); running them one after another lets the second hit the cache.
const queues = new Map<string, Promise<unknown>>();

// A run whose deadline passed must not hold the queue even if its fetch never settles.
async function serialized<T>(
  pageId: string,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(pageId) ?? Promise.resolve();
  const mine = previous.then(run, run);
  const aborted = new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  // The reservation always includes the predecessor: a waiter that times out while still
  // queued must not let a later request overtake the run that is actually in progress.
  const tail = previous.then(() =>
    Promise.race([
      mine.then(
        () => undefined,
        () => undefined,
      ),
      aborted,
    ]),
  );
  queues.set(pageId, tail);
  void tail.then(() => {
    if (queues.get(pageId) === tail) queues.delete(pageId);
  });
  return mine;
}

interface Ctx {
  api: { origin: string; fetch: typeof fetch; signal: AbortSignal };
  ownerKey: string;
  workspace: string;
}

interface Resolved {
  workspace: string;
  pageId: string;
  canonical: string;
}

/** Preview follows Notion's redirects, so it names the page the URL really leads to. */
async function previewPage(page: ClassifiedPage, api: Ctx['api']): Promise<Resolved> {
  const preview = await callApi({
    ...api,
    path: '/api/preview',
    method: 'POST',
    body: { url: page.canonical },
  });
  if (!preview.ok) return stop('api_error', preview.message);
  const b = preview.body;
  if (
    !isRecord(b) ||
    typeof b.workspace !== 'string' ||
    typeof b.pageId !== 'string' ||
    typeof b.canonicalUrl !== 'string'
  ) {
    return stop('api_error', 'Unexpected answer from ntn-link.');
  }
  return {
    workspace: b.workspace,
    pageId: b.pageId.replaceAll('-', '').toLowerCase(),
    canonical: b.canonicalUrl,
  };
}

async function findLink(ctx: Ctx, pageId: string): Promise<LinkSummary | null> {
  const list = await callApi({
    ...ctx.api,
    ownerKey: ctx.ownerKey,
    path: `/api/ns/${ctx.workspace}/links`,
  });
  if (!list.ok) return stop('api_error', list.message, ctx.workspace);
  // A malformed list must not read as "empty": creating would duplicate an existing link.
  const links = isRecord(list.body) && Array.isArray(list.body.links) ? list.body.links : null;
  const views = links?.map(parseLinkView);
  if (views === undefined || views.includes(null)) {
    return stop('api_error', 'Unexpected answer from ntn-link.', ctx.workspace);
  }
  return views.find((v) => v?.pageId.replaceAll('-', '').toLowerCase() === pageId) ?? null;
}

async function mutate(
  ctx: Ctx,
  path: string,
  method: 'POST' | 'PATCH',
  body: object,
): Promise<LinkSummary> {
  const res = await callApi({ ...ctx.api, ownerKey: ctx.ownerKey, path, method, body });
  if (!res.ok) return stop('api_error', res.message, ctx.workspace);
  const view = isRecord(res.body) ? parseLinkView(res.body.link) : null;
  return view ?? stop('api_error', 'Unexpected answer from ntn-link.', ctx.workspace);
}

async function resolveInner(args: ResolveArgs, signal: AbortSignal): Promise<ResolveResult> {
  const { keys } = args;
  const page = classifyPageUrl(args.url);
  if (page === null) {
    return { ok: false, reason: 'not_notion', message: 'Open a public Notion page first' };
  }
  const api = { origin: args.origin, fetch: args.fetch, signal };
  // A `notion.so/<name>/<id>` hint is Notion's internal workspace name, which need not be the
  // published `<ws>.notion.site` one, so only a notion.site host is trusted as is; anything
  // else asks the API (explicit action, so contacting it is allowed) before a key is chosen.
  const target: Omit<Resolved, 'workspace'> & { workspace: string | null } = isPublishedHost(
    args.url,
  )
    ? page
    : await previewPage(page, api);
  const { workspace } = target;
  const ownerKey = workspace === null ? null : await keys.getKey(workspace);
  if (workspace === null || ownerKey === null) {
    return fail(
      'no_key',
      `No owner key for "${workspace ?? 'this workspace'}" yet.`,
      workspace ?? undefined,
    );
  }

  const cacheId = `${args.origin}|${workspace}|${target.pageId}`;
  // Serialized by the RESOLVED page, so an alias URL and the canonical URL share one queue.
  return serialized(target.pageId, signal, () =>
    createOrFind({ args, api, ownerKey, workspace, target, cacheId }),
  );
}

interface Creation {
  args: ResolveArgs;
  api: Ctx['api'];
  ownerKey: string;
  workspace: string;
  target: { pageId: string; canonical: string };
  cacheId: string;
}

async function createOrFind(c: Creation): Promise<ResolveResult> {
  const { args, api, ownerKey, workspace, target, cacheId } = c;
  const { keys, kind } = args;
  const cached = await keys.getLinkCache(cacheId, args.now());
  const hit = cached === null ? null : pick(cached, kind);
  if (hit !== null) return { ok: true, link: hit };

  const ctx: Ctx = { api, ownerKey, workspace };
  let found =
    (await findLink(ctx, target.pageId)) ??
    (await mutate(ctx, '/api/links', 'POST', { url: target.canonical, fast: true }));
  if (kind === 'fast' && found.fastUrl === null) {
    // The link exists with the fast copy switched off; asking for the fast link means on.
    found = await mutate(ctx, `/api/links/${found.workspace}/${found.slug}`, 'PATCH', {
      fast: true,
    });
  }
  await keys.setLinkCache(
    cacheId,
    { redirectUrl: found.redirectUrl, fastUrl: found.fastUrl },
    args.now(),
  );
  const link = pick(found, kind);
  return link === null
    ? fail('api_error', 'ntn-link returned no link.', workspace)
    : { ok: true, link };
}

export const resolveLink: ResolveLink = async (args) => {
  try {
    const out = await withTimeout(args.timeoutMs, (signal) => resolveInner(args, signal));
    if (out === TIMED_OUT) {
      return { ok: false, reason: 'timeout', message: 'ntn-link took too long to answer.' };
    }
    return out;
  } catch (error) {
    if (error instanceof Stop) return error.result;
    // Storage failures and other surprises must not escape into the copy path.
    return fail('api_error', 'Something went wrong while contacting ntn-link.');
  }
};
