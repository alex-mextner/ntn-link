import { bearerKey, guarded, json, limit } from '@/lib/http';
import { getService } from '@/lib/service';

/** Room for the 10 s database warm-up (Neon scale-to-zero, see PostgresStore) plus the request's own work (Notion calls have 10 s deadlines). */
export const maxDuration = 60;

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
