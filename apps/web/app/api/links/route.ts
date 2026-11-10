import { createLinkRequestSchema } from '@ntn-link/core';
import { bearerKey, guarded, json, limit, readBody } from '@/lib/http';
import { getService } from '@/lib/service';

export function POST(request: Request): Promise<Response> {
  return guarded(async () => {
    const service = getService();
    await limit(service, 'links', request);
    const body = await readBody(request, createLinkRequestSchema);
    return json(await service.createLink(body, bearerKey(request)), 201);
  });
}
