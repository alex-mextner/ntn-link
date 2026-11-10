import {
  ApiError,
  timingSafeEqual,
  updateLinkRequestSchema,
  type Caller,
  type DeleteLinkResponse,
} from '@ntn-link/core';
import { bearerKey, guarded, json, limit, readBody } from '@/lib/http';
import { getService } from '@/lib/service';

interface Context {
  params: Promise<{ workspace: string; slug: string }>;
}

/** The operator token is a separate credential; a wrong one is an error, never a fallback to owner auth. */
function callerOf(request: Request): Caller {
  const presented = request.headers.get('x-admin-token');
  if (presented === null) return { kind: 'owner', ownerKey: bearerKey(request) };
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || !timingSafeEqual(presented, expected)) {
    throw new ApiError('unauthorized', 'The admin token is not valid.');
  }
  return { kind: 'operator' };
}

export function PATCH(request: Request, { params }: Context): Promise<Response> {
  return guarded(async () => {
    const service = getService();
    await limit(service, 'links', request);
    const { workspace, slug } = await params;
    const body = await readBody(request, updateLinkRequestSchema);
    return json(await service.updateLink(workspace, slug, body, bearerKey(request)));
  });
}

export function DELETE(request: Request, { params }: Context): Promise<Response> {
  return guarded(async () => {
    const service = getService();
    await limit(service, 'links', request);
    const { workspace, slug } = await params;
    await service.deleteLink(workspace, slug, callerOf(request));
    const body: DeleteLinkResponse = { deleted: true };
    return json(body);
  });
}
