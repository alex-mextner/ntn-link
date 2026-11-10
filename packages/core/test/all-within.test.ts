/**
 * The bounded-burst helper of the store contract: width is respected, and a failing call stops
 * the scheduling and is only rethrown after every call in flight has finished, so a harness
 * cleanup never races a write that is still running.
 */
import { expect, test } from 'bun:test';
import { allWithin } from './store-contract';

test('never runs more than `width` calls at once and keeps result order', async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await allWithin(30, 4, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Bun.sleep(2);
    inFlight--;
    return i * 2;
  });
  expect(peak).toBe(4);
  expect(results).toEqual(Array.from({ length: 30 }, (_, i) => i * 2));
});

test('a failure stops new calls and waits for the ones in flight before rejecting', async () => {
  let started = 0;
  let inFlight = 0;
  const failure = await allWithin(50, 5, async (i) => {
    started++;
    inFlight++;
    await Bun.sleep(i === 7 ? 1 : 20);
    inFlight--;
    if (i === 7) throw new Error('boom');
  }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ message: 'boom' });
  expect(inFlight).toBe(0);
  expect(started).toBeLessThan(50);
});
