/** `sqlHarness.dispose` is the afterAll cleanup of the live-database run: it must not give up early. */
import { afterEach, describe, expect, test, vi } from 'bun:test';
import type { SqlExecutor, SqlStatement } from '../src/sql-executor';
import { sqlHarness } from './support/sql-harness';

const NO_PAUSE = [0, 0] as const;

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Moves the fake clock forward until `pending` settles (a step is longer than any cleanup deadline). */
async function runToCompletion<T>(pending: Promise<T> | undefined): Promise<T | undefined> {
  const state = { done: false };
  void pending?.then(() => {
    state.done = true;
  });
  for (let step = 0; step < 50 && !state.done; step++) {
    await flushMicrotasks();
    vi.advanceTimersByTime(12_000);
  }
  await flushMicrotasks();
  return pending;
}

function recordingExecutor(failWhen: (statement: SqlStatement, call: number) => boolean): {
  executor: SqlExecutor;
  statements: SqlStatement[];
} {
  const statements: SqlStatement[] = [];
  const executor: SqlExecutor = {
    query: (statement) => {
      statements.push(statement);
      return failWhen(statement, statements.length)
        ? Promise.reject(
            Object.assign(new Error('postgres://u:secret@host/db reset'), { code: 'ECONNRESET' }),
          )
        : Promise.resolve([]);
    },
    transaction: () => Promise.reject(new Error('unused')),
  };
  return { executor, statements };
}

const touches = (statement: SqlStatement, table: string) => statement.text.includes(table);

describe('sqlHarness dispose', () => {
  afterEach(() => vi.useRealTimers());

  test('removes the run rows and the set members with the run prefix', async () => {
    const { executor, statements } = recordingExecutor(() => false);
    const harness = sqlHarness(executor, undefined, NO_PAUSE);
    await harness.dispose?.();
    expect(statements.map((s) => s.text.split(' WHERE')[0]).toSorted()).toEqual([
      'DELETE FROM ntn_kv',
      'DELETE FROM ntn_set_members',
    ]);
    for (const { params } of statements) {
      expect(params).toEqual([`%${harness.keyPrefix}%`]);
    }
    expect(harness.keyPrefix).toMatch(/^ntnlinktest:[0-9a-f]{12}:$/);
  });

  test('retries a failed statement and still succeeds', async () => {
    const { executor, statements } = recordingExecutor((_statement, call) => call <= 2);
    await sqlHarness(executor, undefined, NO_PAUSE).dispose?.();
    expect(statements).toHaveLength(4);
  });

  test('runs the second cleanup even when the first gave up, then reports the failure', async () => {
    const { executor, statements } = recordingExecutor((statement) => touches(statement, 'ntn_kv'));
    const harness = sqlHarness(executor, undefined, NO_PAUSE);
    await expect(harness.dispose?.()).rejects.toThrow(`Cleanup of ${harness.keyPrefix} failed`);
    expect(statements.filter((s) => touches(s, 'ntn_set_members'))).toHaveLength(1);
    expect(statements.filter((s) => touches(s, 'FROM ntn_kv'))).toHaveLength(3);
  });

  test('both cleanups are started before either finishes, so one stalled statement cannot starve the other', async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    const executor: SqlExecutor = {
      query: (statement) => {
        started.push(statement.text.split(' WHERE')[0] ?? '');
        return new Promise(() => {});
      },
      transaction: () => Promise.reject(new Error('unused')),
    };
    const settled = sqlHarness(executor, undefined, NO_PAUSE)
      .dispose?.()
      .catch(() => undefined);
    await flushMicrotasks();
    expect(started.toSorted()).toEqual(['DELETE FROM ntn_kv', 'DELETE FROM ntn_set_members']);
    await runToCompletion(settled);
  });

  test('retries each statement after the pauses', async () => {
    const attempts = new Map<string, number>();
    const executor: SqlExecutor = {
      query: (statement) => {
        const n = (attempts.get(statement.text) ?? 0) + 1;
        attempts.set(statement.text, n);
        return n <= 2 ? Promise.reject(new Error('blip')) : Promise.resolve([]);
      },
      transaction: () => Promise.reject(new Error('unused')),
    };
    await sqlHarness(executor, undefined, [30, 30]).dispose?.();
    expect([...attempts.values()]).toEqual([3, 3]);
  });

  test('the failure names the error class and code, never its message', async () => {
    const { executor } = recordingExecutor(() => true);
    const error = await sqlHarness(executor, undefined, NO_PAUSE)
      .dispose?.()
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain('Error ECONNRESET');
    expect((error as Error).message).not.toContain('secret');
    expect((error as Error).message).not.toContain('postgres://');
  });

  test('an executor that ignores its abort signal still ends in the by-hand message', async () => {
    vi.useFakeTimers();
    const attempts: string[] = [];
    const executor: SqlExecutor = {
      query: (statement) => {
        attempts.push(statement.text);
        return new Promise(() => {});
      },
      transaction: () => Promise.reject(new Error('unused')),
    };
    const harness = sqlHarness(executor, undefined, NO_PAUSE);
    const error = await runToCompletion(harness.dispose?.().catch((e: unknown) => e));
    expect((error as Error).message).toContain(`Cleanup of ${harness.keyPrefix} failed`);
    expect(attempts).toHaveLength(6);
  });
});
