/**
 * In-process fake of the ntn-link HTTP contract (api-types.ts), just faithful enough
 * to drive the CLI: ownership challenge, bearer keys, links, typed error bodies.
 */
import {
  ERROR_STATUS,
  type ApiErrorBody,
  type CardData,
  type ChallengeAction,
  type ErrorCode,
  type LinkView,
} from '../../core/src/api-types';

export interface Seen {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

interface Challenge {
  claimToken: string;
  action: ChallengeAction;
}

interface Forced {
  code: ErrorCode;
  status: number;
  message: string;
  extra?: object;
}

export interface FakeServer {
  origin: string;
  seen: Seen[];
  /** ws -> owner key currently valid */
  owners: Map<string, string>;
  links: Map<string, LinkView>;
  /** nonce -> URL of the page whose title currently contains it. */
  publishedNonces: Map<string, string>;
  /** Answers the next request with this typed error instead of handling it. */
  failNext: Forced | null;
  /** Makes created links report this redirect URL (hostile or odd server). */
  redirectUrlOverride: string | null;
  stop(): void;
}

type Body = Record<string, string | boolean | undefined>;

function errorResponse(
  code: ErrorCode,
  message: string,
  extra: object = {},
  status?: number,
): Response {
  const body: ApiErrorBody = { error: { code, message, ...extra } };
  return Response.json(body, { status: status ?? ERROR_STATUS[code] });
}

const card = (title: string): CardData => ({
  title,
  description: '',
  imageUrl: null,
  language: null,
});

const bearer = (req: Request): string | null =>
  req.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;

/** Notion URL forms differ per host; the page identity is the id at the end of the path. */
const pageKey = (url: unknown): string => {
  if (typeof url !== 'string') return '';
  const last = new URL(url).pathname.split('/').findLast((part) => part !== '') ?? '';
  const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/.exec(
    last,
  )?.[1];
  return id?.replaceAll('-', '') ?? url;
};

const wsOf = (url: unknown): string => new URL(String(url)).hostname.split('.')[0] ?? '';

const slugOf = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const unauthorized = (): Response =>
  errorResponse('unauthorized', 'The owner key is missing or wrong.');

export function startFakeServer(): FakeServer {
  const challenges = new Map<string, Challenge>();
  let counter = 0;
  const server: FakeServer = {
    origin: '',
    seen: [],
    owners: new Map(),
    links: new Map(),
    publishedNonces: new Map(),
    failNext: null,
    redirectUrlOverride: null,
    stop: () => undefined,
  };

  /** The page title as Notion would currently show it: nonces placed by the owner are part of it. */
  function titleOf(url: unknown): string {
    const codes = [...server.publishedNonces]
      .filter(([, page]) => pageKey(page) === pageKey(url))
      .map(([nonce]) => nonce);
    return ['Our trips', ...codes].join(' ');
  }

  function preview(b: Body): Response {
    const ws = wsOf(b['url']);
    const claimed = server.owners.has(ws);
    return Response.json({
      workspace: ws,
      pageId: 'p',
      canonicalUrl: b['url'],
      card: card(titleOf(b['url'])),
      proposedSlug: slugOf(titleOf(b['url'])),
      namespaceClaimed: claimed,
      needsVerification: true,
      suggestedAction: claimed ? 'rotate' : 'claim',
    });
  }

  function challenge(b: Body): Response {
    const nonce = `ntn-verify-fake${String(++counter).padStart(6, '0')}`;
    const claimToken = `claim-token-secret-${counter}`;
    const action = b['action'] as ChallengeAction;
    challenges.set(nonce, { claimToken, action });
    return Response.json({
      workspace: wsOf(b['url']),
      action,
      nonce,
      claimToken,
      expiresAt: '2030-01-01T00:15:00.000Z',
    });
  }

  function verify(b: Body): Response {
    const nonce = String(b['nonce']);
    const pending = challenges.get(nonce);
    if (!pending || pending.claimToken !== b['claimToken']) {
      return errorResponse('challenge_invalid', 'That is not a valid challenge.');
    }
    if (pageKey(server.publishedNonces.get(nonce)) !== pageKey(b['url'])) {
      return errorResponse('nonce_not_found', 'The page title does not contain the code yet.');
    }
    challenges.delete(nonce);
    const ws = wsOf(b['url']);
    const ownerKey = `owner-key-secret-${counter}-${server.owners.size}`;
    server.owners.set(ws, ownerKey);
    return Response.json({
      workspace: ws,
      action: pending.action,
      ownerKey,
      removedLinks: 0,
      cleanupComplete: true,
    });
  }

  function createLink(req: Request, b: Body): Response {
    const ws = wsOf(b['url']);
    const owner = server.owners.get(ws);
    if (owner === undefined || bearer(req) !== owner) {
      const action = owner === undefined ? 'claim' : 'rotate';
      return errorResponse('needs_verification', 'Prove you control this Notion workspace first.', {
        action,
      });
    }
    const title = titleOf(b['url']);
    const slug = typeof b['slug'] === 'string' ? b['slug'] : slugOf(title);
    if (server.links.has(`${ws}/${slug}`)) {
      return errorResponse('slug_taken', `The slug "${slug}" is already taken in ${ws}.`);
    }
    const fast = b['fast'] !== false;
    const link: LinkView = {
      workspace: ws,
      slug,
      pageId: 'p',
      canonicalUrl: String(b['url']),
      card: card(title),
      overrides: {},
      fast,
      canonicalMode: 'self',
      createdAt: '2026-11-10T00:00:00.000Z',
      redirectUrl: server.redirectUrlOverride ?? `https://short.test/${ws}/${slug}`,
      fastUrl: fast ? `https://short.test/${ws}/${slug}/read` : null,
    };
    server.links.set(`${ws}/${slug}`, link);
    return Response.json({ link }, { status: 201 });
  }

  function changeLink(req: Request, ws: string, slug: string, patch: { fast?: boolean }): Response {
    if (bearer(req) !== server.owners.get(ws)) return unauthorized();
    const existing = server.links.get(`${ws}/${slug}`);
    if (!existing) return errorResponse('not_found', 'No such link.');
    if (req.method === 'DELETE') {
      server.links.delete(`${ws}/${slug}`);
      return Response.json({ deleted: true });
    }
    const updated: LinkView = { ...existing, fast: patch.fast ?? existing.fast };
    server.links.set(`${ws}/${slug}`, updated);
    return Response.json({ link: updated });
  }

  function listLinks(req: Request, ws: string): Response {
    if (bearer(req) !== server.owners.get(ws)) return unauthorized();
    return Response.json({
      workspace: ws,
      links: [...server.links.values()].filter((l) => l.workspace === ws),
    });
  }

  async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const text = await req.text();
    const body: unknown = text ? JSON.parse(text) : undefined;
    server.seen.push({ method: req.method, path, auth: req.headers.get('authorization'), body });
    const forced = server.failNext;
    if (forced) {
      server.failNext = null;
      return errorResponse(forced.code, forced.message, forced.extra, forced.status);
    }
    const b = (body ?? {}) as Body;
    if (path === '/api/preview') return preview(b);
    if (path === '/api/challenge') return challenge(b);
    if (path === '/api/verify') return verify(b);
    if (path === '/api/links' && req.method === 'POST') return createLink(req, b);
    const link = /^\/api\/links\/([^/]+)\/([^/]+)$/.exec(path);
    if (link) return changeLink(req, link[1] ?? '', link[2] ?? '', b);
    const ns = /^\/api\/ns\/([^/]+)\/links$/.exec(path);
    if (ns) return listLinks(req, ns[1] ?? '');
    return errorResponse('not_found', 'No such route.');
  }

  const listener = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handle });
  server.origin = `http://127.0.0.1:${listener.port}`;
  server.stop = () => void listener.stop(true);
  return server;
}
