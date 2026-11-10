import { bearerKey, guarded, json, limit } from '@/lib/http';
import { getService } from '@/lib/service';

/** Room for the 10 s database warm-up (Neon scale-to-zero, see PostgresStore) plus the request's own work. */
export const maxDuration = 30;

export function GET(
  request: Request,
  { params }: { params: Promise<{ workspace: string }> },
): Promise<Response> {
  return guarded(async () => {
    const service = getService();
    await limit(service, 'links', request);
    const { workspace } = await params;
    return json(await service.listLinks(workspace, bearerKey(request)));
  });
}
