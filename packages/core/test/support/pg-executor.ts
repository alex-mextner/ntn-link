/**
 * `SqlExecutor` over a node-postgres pool: plain Postgres with real concurrent connections,
 * which PGlite (one connection) cannot give. Test-only; production uses the Neon HTTP driver.
 */
import { Pool } from 'pg';
import type { SqlExecutor, SqlRow, SqlStatement } from '../../src/sql-executor';

export interface PgExecutor extends SqlExecutor {
  close: () => Promise<void>;
}

async function rowsOf(
  target: Pick<Pool, 'query'>,
  { text, params }: SqlStatement,
): Promise<readonly SqlRow[]> {
  return (await target.query<SqlRow>(text, [...params])).rows;
}

export function pgExecutor(connectionString: string): PgExecutor {
  const pool = new Pool({ connectionString, max: 20 });
  return {
    query: (statement) => rowsOf(pool, statement),
    async transaction(statements) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const results: Array<readonly SqlRow[]> = [];
        for (const statement of statements) results.push(await rowsOf(client, statement));
        await client.query('COMMIT');
        return results;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
