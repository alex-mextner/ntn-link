import { challengeRequestSchema } from '@ntn-link/core';
import { guarded, json, limit, readBody } from '@/lib/http';
import { getService, getTestFetcher } from '@/lib/service';

/** Room for the 10 s database warm-up (Neon scale-to-zero, see PostgresStore) plus the request's own work. */
export const maxDuration = 30;

export function POST(request: Request): Promise<Response> {
  return guarded(async () => {
    const service = getService();
    await limit(service, 'challenge', request);
    const body = await readBody(request, challengeRequestSchema);
    const challenge = await service.issueChallenge(body);
    getTestFetcher()?.expectNonce(challenge.workspace, challenge.nonce);
    return json(challenge);
  });
}
