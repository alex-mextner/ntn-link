/// <reference types="bun" />

import { afterEach, describe, expect, test, vi } from 'bun:test';
import { DeadlineError, raceDeadline } from '../../lib/client/deadline';

describe('raceDeadline', () => {
  afterEach(() => vi.useRealTimers());

  test('passes through a value that arrives in time', async () => {
    vi.useFakeTimers();
    expect(await raceDeadline(Promise.resolve('ok'), 100)).toBe('ok');
  });

  test('passes through a rejection that arrives in time', async () => {
    vi.useFakeTimers();
    const failure = new Error('denied');
    expect(await raceDeadline(Promise.reject(failure), 100).catch((e: unknown) => e)).toBe(failure);
  });

  test('rejects with DeadlineError when the promise never settles', async () => {
    vi.useFakeTimers();
    const settled = raceDeadline(new Promise<string>(() => {}), 100).catch((e: unknown) => e);
    vi.advanceTimersByTime(99);
    vi.advanceTimersByTime(1);
    expect(await settled).toBeInstanceOf(DeadlineError);
  });

  test('a late value after the deadline changes nothing', async () => {
    vi.useFakeTimers();
    let late!: (value: string) => void;
    const slow = new Promise<string>((resolve) => {
      late = resolve;
    });
    const settled = raceDeadline(slow, 100).catch((e: unknown) => e);
    vi.advanceTimersByTime(100);
    late('too late');
    expect(await settled).toBeInstanceOf(DeadlineError);
  });
});
