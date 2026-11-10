/** Exit codes: one per error type so scripts can branch without parsing messages. */
import type { ErrorCode } from '../../core/src/api-types';

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  verificationNeedsTerminal: 3,
  config: 4,
  badPage: 5,
  slug: 6,
  unauthorized: 7,
  rateLimited: 8,
  challenge: 9,
  network: 10,
  sweepIncomplete: 11,
  sweepUnsupported: 12,
} as const;

/** A Map, not an object: the code comes from the server and `constructor` or `__proto__` must stay unknown. */
const CODE_EXITS: Array<[ErrorCode, number]> = [
  ['not_notion_url', EXIT.badPage],
  ['not_public', EXIT.badPage],
  ['unsupported_workspace', EXIT.badPage],
  ['slug_taken', EXIT.slug],
  ['slug_reserved', EXIT.slug],
  ['slug_invalid', EXIT.slug],
  ['unauthorized', EXIT.unauthorized],
  ['needs_verification', EXIT.unauthorized],
  ['namespace_claimed', EXIT.unauthorized],
  ['rate_limited', EXIT.rateLimited],
  ['challenge_expired', EXIT.challenge],
  ['challenge_invalid', EXIT.challenge],
  ['nonce_not_found', EXIT.challenge],
];
const BY_CODE = new Map<string, number>(CODE_EXITS);

/** Takes any string: the server may send a code this client has never heard of (exit 1). */
export function exitCodeFor(code: string): number {
  return BY_CODE.get(code) ?? EXIT.failure;
}

/**
 * Text from the server or from Notion titles ends up on a terminal; control characters
 * (including ANSI escapes) are replaced so a hostile origin cannot script the user's terminal.
 */
export function plainText(text: string): string {
  return text.replace(/\p{Cc}+/gu, ' ');
}

/** Thrown inside a command to stop with a message already meant for the user. */
export class Fail extends Error {
  constructor(
    message: string,
    readonly exit: number,
  ) {
    super(message);
  }
}
