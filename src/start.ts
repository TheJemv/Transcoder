// Supervisor: un contenedor, dos procesos (worker + api).
// Si cualquiera de los dos muere, mata al otro y sale != 0 para que
// `restart: unless-stopped` de docker reinicie todo el contenedor.

import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(here, '..', 'node_modules', '.bin', 'tsx');

const targets = [
  { name: 'worker', file: join(here, 'worker', 'index.ts') },
  { name: 'api', file: join(here, 'api', 'index.ts') },
];

let shuttingDown = false;
const children: ChildProcess[] = [];

function logLine(fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...fields }) + '\n');
}

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch { /* noop */ }
  }
  setTimeout(() => process.exit(code), 5000).unref();
}

for (const t of targets) {
  const child = spawn(tsxBin, [t.file], { stdio: 'inherit', env: process.env });
  children.push(child);
  child.on('exit', (exitCode, signal) => {
    logLine({ level: 'error', msg: 'child.exit', name: t.name, code: exitCode, signal });
    shutdown(exitCode ?? 1);
  });
  child.on('error', (err) => {
    logLine({ level: 'error', msg: 'child.spawn_error', name: t.name, err: String(err) });
    shutdown(1);
  });
}

logLine({ level: 'info', msg: 'supervisor.up', children: targets.map((t) => t.name) });

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
