/**
 * The seam between `PostgresStore` and a Postgres driver: exactly two capabilities, one
 * parameterised statement and a batch of statements run as one transaction. Production uses
 * the Neon HTTP driver (`neonHttpExecutor`, stateless, one HTTPS request per call, which is
 * what a serverless function needs); tests use an in-process Postgres (PGlite) or a plain
 * `pg` connection behind the same two methods.
 *
 * The Neon driver is imported on first use, so loading this module costs nothing for
 * deployments that use another store.
 */
import type { NeonQueryFunction } from '@neondatabase/serverless';

export type SqlParam = string | number | boolean | null;

export interface SqlStatement {
  /** Positional `$1`, `$2`, ... placeholders; values are never interpolated into the text. */
  readonly text: string;
  readonly params: readonly SqlParam[];
}

export type SqlRow = Readonly<Record<string, unknown>>;

export interface SqlExecutor {
  /** Runs one statement in its own implicit transaction. */
  query(statement: SqlStatement, signal: AbortSignal): Promise<readonly SqlRow[]>;
  /**
   * Runs the statements in order inside one READ COMMITTED transaction (all or nothing) and
   * resolves each statement's rows. Every statement takes its own snapshot, so a statement
   * sees what a lock taken by an earlier one in the batch waited for.
   */
  transaction(
    statements: readonly SqlStatement[],
    signal: AbortSignal,
  ): Promise<ReadonlyArray<readonly SqlRow[]>>;
}

/** A driver reply that is not rows of objects; distinguishes a malformed answer from a transport fault. */
export class MalformedReplyError extends Error {
  override name = 'MalformedReplyError';
}

/**
 * Executor over the Neon serverless HTTP driver. `signal` becomes the fetch signal of the
 * request, so a deadline cancels the HTTP call itself.
 */
export function neonHttpExecutor(connectionString: string): SqlExecutor {
  let client: Promise<NeonClient> | undefined;
  const connect = (): Promise<NeonClient> =>
    (client ??= import('@neondatabase/serverless').then(({ neon }) => neon(connectionString)));
  return {
    async query(statement, signal) {
      const sql = await connect();
      return rowsOf(
        await sql.query(statement.text, [...statement.params], { fetchOptions: { signal } }),
      );
    },
    async transaction(statements, signal) {
      const sql = await connect();
      const results = await sql.transaction(
        statements.map((statement) => sql.query(statement.text, [...statement.params])),
        { fetchOptions: { signal }, isolationLevel: 'ReadCommitted' },
      );
      return results.map(rowsOf);
    },
  };
}

type NeonClient = NeonQueryFunction<false, false>;

/** Anything but an array of row objects is a fault, never "no rows". */
function rowsOf(result: unknown): readonly SqlRow[] {
  if (!Array.isArray(result)) throw new MalformedReplyError('Unexpected result shape.');
  return result.map((row: unknown) => {
    if (typeof row !== 'object' || row === null)
      throw new MalformedReplyError('Unexpected row shape.');
    return Object.fromEntries(Object.entries(row));
  });
}
