import { verifyRequestSchema } from '@ntn-link/core';
import { guarded, json, limit, readBody } from '@/lib/http';
import { getService, getTestFetcher } from '@/lib/service';

/** Rotation sweeps links (budget 20 s) after the key replacement; leave headroom for it. */
export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
  return guarded(async () => {
    const service = getService();
    await limit(service, 'verify', request);
    const body = await readBody(request, verifyRequestSchema);
    const verified = await service.verify(body);
    getTestFetcher()?.clearNonces(verified.workspace);
    return json(verified);
  });
}
