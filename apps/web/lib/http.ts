/**
 * HTTP glue shared by the API routes: body validation, owner-key and client-IP extraction,
 * and the `{error:{code,message}}` envelope from the public contract.
 */
import type { ZodType } from 'zod';
import { ApiError, enforceRateLimit, type RateLimitedAction, type Service } from '@ntn-link/core';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export function json(body: object, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/**
 * Structural check on purpose: route bundles can each carry their own copy of core, so an
 * error thrown by the shared service singleton is not `instanceof` this bundle's ApiError.
 */
function isApiError(error: unknown): error is ApiError {
  return (
    error instanceof Error &&
    error.name === 'ApiError' &&
    'code' in error &&
    'toBody' in error &&
    typeof error.toBody === 'function'
  );
}

export function errorResponse(error: unknown): Response {
  if (isApiError(error)) {
    const headers: Record<string, string> = {};
    if (error.retryAfterSeconds !== undefined) {
      headers['retry-after'] = String(error.retryAfterSeconds);
    }
    return json(error.toBody(), error.status, headers);
  }
  console.error('unhandled route error', error);
  return json(new ApiError('upstream_error', 'Unexpected server error.').toBody(), 502);
}

/** Runs a handler and converts anything it throws into the error envelope. */
export async function guarded(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return errorResponse(error);
  }
}

export async function readBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError('invalid_request', 'The request body must be JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` (${first.path.join('.')})` : '';
    throw new ApiError('invalid_request', `The request body is not valid${where}.`);
  }
  return parsed.data;
}

export function bearerKey(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1] ?? null;
}

/**
 * Forwarding headers are client-controlled unless an ingress we trust overwrites them. Vercel
 * does; for any other proxy the operator opts in with NTN_TRUST_PROXY=1. Otherwise every
 * caller shares one bucket, which is safe (a spoofed header cannot mint fresh buckets) at the
 * price of a global limit.
 */
export function clientIp(request: Request): string {
  const trusted = Boolean(process.env.VERCEL) || process.env.NTN_TRUST_PROXY === '1';
  if (!trusted) return 'untrusted-ingress';
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip') || 'unknown';
}

export function limit(service: Service, action: RateLimitedAction, request: Request) {
  return enforceRateLimit(service.store, action, clientIp(request));
}
