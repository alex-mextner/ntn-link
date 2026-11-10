import { createLinkRequestSchema } from '@ntn-link/core';
import { bearerKey, guarded, json, limit, readBody } from '@/lib/http';
import { getService } from '@/lib/service';

/** Room for the 10 s database warm-up (Neon scale-to-zero, see PostgresStore) plus the request's own work (Notion calls have 10 s deadlines). */
export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
  return guarded(async () => {
    const service = getService();
    await limit(service, 'links', request);
    const body = await readBody(request, createLinkRequestSchema);
    const { created, ...response } = await service.createLink(body, bearerKey(request));
    return json(response, created ? 201 : 200);
  });
}
