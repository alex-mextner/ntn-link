import { previewRequestSchema } from '@ntn-link/core';
import { bearerKey, guarded, json, limit, readBody } from '@/lib/http';
import { getService } from '@/lib/service';

export function POST(request: Request): Promise<Response> {
  return guarded(async () => {
    const service = getService();
    await limit(service, 'preview', request);
    const body = await readBody(request, previewRequestSchema);
    return json(await service.preview(body, bearerKey(request)));
  });
}
