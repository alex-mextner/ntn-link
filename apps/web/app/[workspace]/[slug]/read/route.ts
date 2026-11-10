/** Placeholder until the fast variant lands: an honest 501, never fake content. */
import { ApiError } from '@ntn-link/core';
import { json } from '@/lib/http';

export function GET(): Response {
  return json(
    new ApiError('not_implemented', 'The fast variant is not available yet.').toBody(),
    501,
  );
}
