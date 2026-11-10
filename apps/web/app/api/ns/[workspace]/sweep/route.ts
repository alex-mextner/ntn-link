import { bearerKey, guarded, json, limit } from '@/lib/http';
import { getService } from '@/lib/service';

/** Above the 20 s sweep budget plus storage round trips. */
export const maxDuration = 60;

export function POST(
  request: Request,
  { params }: { params: Promise<{ workspace: string }> },
): Promise<Response> {
  return guarded(async () => {
    const service = getService();
    await limit(service, 'sweep', request);
    const { workspace } = await params;
    return json(await service.sweepLinks(workspace, bearerKey(request)));
  });
}
