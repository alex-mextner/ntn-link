/**
 * Thin typed client for the same-origin JSON API. All paths are relative, so credentials can
 * only ever be sent to the origin that served the page. The owner key goes in the
 * Authorization header, never in a URL or body.
 */
import type {
  ChallengeAction,
  ChallengeResponse,
  CreateLinkRequest,
  CreateLinkResponse,
  DeleteLinkResponse,
  ListLinksResponse,
  PreviewResponse,
  UpdateLinkRequest,
  UpdateLinkResponse,
  VerifyResponse,
} from '../../../../packages/core/src/api-types';
import { ApiCallError, errorFromBody } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SweepResponse {
  workspace: string;
  removedLinks: number;
  cleanupComplete: boolean;
}

export interface Api {
  preview(url: string, ownerKey: string | null, signal?: AbortSignal): Promise<PreviewResponse>;
  challenge(url: string, action: ChallengeAction): Promise<ChallengeResponse>;
  verify(url: string, nonce: string, claimToken: string): Promise<VerifyResponse>;
  createLink(body: CreateLinkRequest, ownerKey: string): Promise<CreateLinkResponse>;
  updateLink(
    workspace: string,
    slug: string,
    body: UpdateLinkRequest,
    ownerKey: string,
  ): Promise<UpdateLinkResponse>;
  deleteLink(workspace: string, slug: string, ownerKey: string): Promise<DeleteLinkResponse>;
  listLinks(workspace: string, ownerKey: string): Promise<ListLinksResponse>;
  /** Pending contract: throws ApiCallError('not_implemented') when the server has no such route. */
  sweep(workspace: string, ownerKey: string): Promise<SweepResponse>;
}

export function createApi(fetchImpl: FetchLike): Api {
  async function call<T>(
    method: string,
    path: string,
    options: { body?: object; ownerKey?: string | null; signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body) headers['content-type'] = 'application/json';
    if (options.ownerKey) headers.authorization = `Bearer ${options.ownerKey}`;
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiCallError('network', 0);
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // Non-JSON body: handled below.
    }
    if (!response.ok) throw errorFromBody(response.status, parsed);
    if (parsed === null || typeof parsed !== 'object')
      throw new ApiCallError('unexpected', response.status);
    return parsed as T;
  }

  const seg = encodeURIComponent;
  return {
    preview: (url, ownerKey, signal) =>
      call('POST', '/api/preview', { body: { url }, ownerKey, signal }),
    challenge: (url, action) => call('POST', '/api/challenge', { body: { url, action } }),
    verify: (url, nonce, claimToken) =>
      call('POST', '/api/verify', { body: { url, nonce, claimToken } }),
    createLink: (body, ownerKey) => call('POST', '/api/links', { body, ownerKey }),
    updateLink: (workspace, slug, body, ownerKey) =>
      call('PATCH', `/api/links/${seg(workspace)}/${seg(slug)}`, { body, ownerKey }),
    deleteLink: (workspace, slug, ownerKey) =>
      call('DELETE', `/api/links/${seg(workspace)}/${seg(slug)}`, { ownerKey }),
    listLinks: (workspace, ownerKey) =>
      call('GET', `/api/ns/${seg(workspace)}/links`, { ownerKey }),
    async sweep(workspace, ownerKey) {
      try {
        return await call<SweepResponse>('POST', `/api/ns/${seg(workspace)}/sweep`, { ownerKey });
      } catch (error) {
        // An unrouted path answers a bare 404/405 (no typed body) => feature not deployed.
        if (
          error instanceof ApiCallError &&
          error.code === 'unexpected' &&
          [404, 405].includes(error.status)
        ) {
          throw new ApiCallError('not_implemented', error.status);
        }
        throw error;
      }
    },
  };
}
