/**
 * A stand-in for Neon's HTTP SQL endpoint (`POST /sql`), backed by any `SqlExecutor`, so the
 * production `neonHttpExecutor` and the real `@neondatabase/serverless` driver run end to end
 * in tests without a Neon account: the driver's request encoding (every parameter as text or
 * null), batch transactions with their isolation header, abort signals and error answers are
 * all exercised for real. It only answers text columns (every column is reported as `text`),
 * which is all `PostgresStore` selects.
 *
 * The wire format is the one the driver speaks (`Neon-Connection-String` header, body
 * `{query, params}` or `{queries: [...]}`, array-mode raw text rows, HTTP 400 with the error
 * fields on a database error).
 */
import { neonConfig } from '@neondatabase/serverless';
import type { SqlExecutor, SqlParam, SqlRow } from '../../src/sql-executor';

const TEXT_OID = 25;

export interface NeonShim {
  /** A connection string whose host the shim answers for. */
  readonly connectionString: string;
  /** The URL the driver's requests are sent to (the shim also sets it as `neonConfig.fetchEndpoint`). */
  readonly endpoint: string;
  readonly requests: Array<{ batch: boolean; isolation: string | null; statements: number }>;
  /** Makes the next request hang until the client gives up. */
  hangNext(): void;
  /** Makes the next request fail like a database error (HTTP 400). */
  failNext(error: { message: string; code: string }): void;
  /** Number of requests the client has abandoned. */
  readonly aborted: () => number;
  stop(): Promise<void>;
}

interface WireStatement {
  query: string;
  params: Array<string | null>;
}

function fieldsOf(rows: readonly SqlRow[]) {
  return Object.keys(rows[0] ?? {}).map((name) => ({ name, dataTypeID: TEXT_OID }));
}

function wireResult(rows: readonly SqlRow[]) {
  const fields = fieldsOf(rows);
  return {
    command: 'SELECT',
    rowCount: rows.length,
    fields,
    rows: rows.map((row) =>
      fields.map(({ name }) => (row[name] == null ? null : String(row[name]))),
    ),
  };
}

function assertWireParams(statement: WireStatement): readonly SqlParam[] {
  for (const param of statement.params) {
    if (param !== null && typeof param !== 'string') {
      throw Object.assign(new Error(`parameter sent as ${typeof param}, Neon sends text`), {
        code: '22023',
      });
    }
  }
  return statement.params;
}

/** Points the driver at the shim for as long as it runs; `stop` restores the global config. */
export function startNeonShim(backend: SqlExecutor): NeonShim {
  const requests: NeonShim['requests'] = [];
  let hang = false;
  let failure: { message: string; code: string } | null = null;
  let aborted = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/sql') {
        return new Response('not found', { status: 404 });
      }
      if (!request.headers.get('neon-connection-string')) {
        return new Response('missing Neon-Connection-String', { status: 401 });
      }
      const body: WireStatement | { queries: WireStatement[] } = await request.json();
      const batch = 'queries' in body;
      const statements = batch ? body.queries : [body];
      requests.push({
        batch,
        isolation: request.headers.get('neon-batch-isolation-level'),
        statements: statements.length,
      });
      if (hang) {
        hang = false;
        request.signal.addEventListener('abort', () => aborted++);
        return new Promise<Response>(() => {});
      }
      if (failure) {
        const { message, code } = failure;
        failure = null;
        return Response.json({ message, code, severity: 'ERROR' }, { status: 400 });
      }
      try {
        const signal = request.signal;
        const prepared = statements.map((statement) => ({
          text: statement.query,
          params: assertWireParams(statement),
        }));
        if (!batch) {
          const [only] = prepared;
          if (only === undefined) throw new Error('empty request');
          return Response.json(wireResult(await backend.query(only, signal)));
        }
        const results = await backend.transaction(prepared, signal);
        return Response.json({ results: results.map(wireResult) });
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'XX000';
        const message = error instanceof Error ? error.message : 'error';
        return Response.json({ message, code, severity: 'ERROR' }, { status: 400 });
      }
    },
  });
  const saved = { endpoint: neonConfig.fetchEndpoint };
  const endpoint = `http://127.0.0.1:${server.port}/sql`;
  neonConfig.fetchEndpoint = () => endpoint;
  return {
    endpoint,
    connectionString:
      'postgres://shim_user:shim_password@ep-shim-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require',
    requests,
    hangNext: () => {
      hang = true;
    },
    failNext: (error) => {
      failure = error;
    },
    aborted: () => aborted,
    async stop() {
      neonConfig.fetchEndpoint = saved.endpoint;
      await server.stop(true);
    },
  };
}
