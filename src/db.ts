import pg from 'pg';
import { config } from './config.ts';

// pg castea NUMERIC a string por defecto; para count(*) (int8) también.
// No nos importa aquí, no leemos numéricos grandes.

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // Un error en un cliente idle del pool no debe tumbar el proceso.
  process.stderr.write(
    JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'pg.pool_error', err: String(err) }) + '\n',
  );
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[] | undefined);
}
