/**
 * Phase I database verification: explicit Phase-H -> Phase-I upgrade,
 * FORCE RLS, workspace isolation, restart persistence and backup/restore.
 * Uses a temporary PostgreSQL cluster; production data is never changed.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = process.env.PHASE_I_DB_VERIFY_DIR || '/tmp/opencode/phase-i-db-verify';
const bin = '/usr/lib/postgresql/17/bin';
const port = Number(process.env.PHASE_I_DB_VERIFY_PORT || 39779);
const socket = join(base, 'sock');
const pgdata = join(base, 'pgdata');
const db = 'phase_i_upgrade';
const report = { startedAt: new Date().toISOString(), checks: [] };
let started = false;

function run(command, args, input) {
  const r = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${command} failed: ${(r.stderr || r.stdout || '').slice(-800)}`);
  return r.stdout;
}
function sqlAdmin(statement) {
  return run(`${bin}/psql`, ['-h', '127.0.0.1', '-p', String(port), '-U', 'ugc_os_app', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tAc', statement]).trim();
}
function sql(statement) {
  return run(`${bin}/psql`, ['-h', '127.0.0.1', '-p', String(port), '-U', 'ugc_os_app', '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAc', statement]).trim();
}
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  if (!ok) throw new Error(`PHASE_I_DB_VERIFY_FAILED: ${name}`);
}
async function migrations(filter) {
  const dir = join(root, 'prisma', 'migrations');
  for (const name of readdirSync(dir).filter((entry) => /^\d/.test(entry)).sort().filter(filter)) {
    const file = join(dir, name, 'migration.sql');
    if (existsSync(file)) sql(readFileSync(file, 'utf8'));
  }
}

try {
  mkdirSync(socket, { recursive: true });
  if (!existsSync(join(pgdata, 'PG_VERSION'))) {
    run(`${bin}/initdb`, ['-D', pgdata, '-U', 'ugc_os_app', '-A', 'trust', '--no-instructions']);
  }
  run(`${bin}/pg_ctl`, ['-D', pgdata, '-l', join(base, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1 -k ${socket}`, 'start']);
  started = true;
  try { sqlAdmin('DROP DATABASE IF EXISTS phase_i_restore WITH (FORCE)'); } catch { /* none */ }
  try { sqlAdmin('DROP DATABASE IF EXISTS phase_i_upgrade WITH (FORCE)'); } catch { /* none */ }
  run(`${bin}/psql`, ['-h', '127.0.0.1', '-p', String(port), '-U', 'ugc_os_app', '-d', 'postgres', '-c', `CREATE DATABASE ${db}`]);

  // 1. Upgrade path: every migration up to Phase H, then Phase I.
  await migrations((name) => !name.startsWith('2026112801'));
  const before = sql("select column_name from information_schema.columns where table_name = 'Incident' order by 1").split('\n');
  check('phase_h_incident_schema', ['id', 'title', 'severity', 'signature', 'details'].every((c) => before.includes(c)), before.join(','));
  check('phase_i_columns_absent_before_upgrade', !before.includes('fingerprint') && !before.includes('evidence'), 'additive migration pending');
  await migrations((name) => name.startsWith('2026112801'));
  const after = sql("select column_name from information_schema.columns where table_name = 'Incident' order by 1").split('\n');
  check('phase_i_columns_added', ['fingerprint', 'kind', 'evidence', 'diagnosis', 'detectedAt'].every((c) => after.includes(c)), after.join(','));
  const tables = sql("select tablename from pg_tables where schemaname = 'public' and tablename in ('RecoveryRun','ImprovementTask','SandboxRun') order by 1").split('\n');
  check('phase_i_tables', tables.length === 3, tables.join(','));
  const forced = sql("select count(*) from pg_class where relname in ('RecoveryRun','ImprovementTask','SandboxRun') and relforcerowsecurity").trim();
  check('force_rls', forced === '3', `forced=${forced}`);
  const partial = sql("select count(*) from pg_indexes where indexname = 'Incident_open_fingerprint'").trim();
  check('dedup_index', partial === '1', `index=${partial}`);

  // 2. Workspace isolation under FORCE RLS.
  sql("INSERT INTO \"Workspace\" (id,name,slug,\"updatedAt\") VALUES ('ws-a','A','a',now()),('ws-b','B','b',now())");
  sql("INSERT INTO \"Incident\" (id,\"workspaceId\",title,fingerprint,kind,severity,\"detectedAt\",\"updatedAt\") VALUES ('i-a','ws-a','A','fp-a','INC-PH-01','warning',now(),now())");
  sql("INSERT INTO \"Incident\" (id,\"workspaceId\",title,fingerprint,kind,severity,\"detectedAt\",\"updatedAt\") VALUES ('i-b','ws-b','B','fp-b','INC-PH-02','warning',now(),now())");
  // The temp-cluster bootstrap role is a superuser (RLS bypassed), so verify
  // isolation through a dedicated non-superuser role.
  sql("DROP ROLE IF EXISTS rls_check");
  sql("CREATE ROLE rls_check LOGIN");
  sql('GRANT USAGE ON SCHEMA public TO rls_check');
  sql('GRANT SELECT ON "Incident" TO rls_check');
  const seenA = sql("BEGIN; SET ROLE rls_check; select set_config('app.current_workspace_id','ws-a',true); select id from \"Incident\"; COMMIT;");
  check('workspace_isolation', seenA.includes('i-a') && !seenA.includes('i-b'), seenA.replace(/\n/g, ','));

  // 3. Persistence across restart.
  run(`${bin}/pg_ctl`, ['-D', pgdata, 'stop', '-m', 'fast']);
  run(`${bin}/pg_ctl`, ['-D', pgdata, '-l', join(base, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1 -k ${socket}`, 'start']);
  const afterRestart = sql('select count(*) from "Incident"').trim();
  check('persistence_after_restart', afterRestart === '2', `rows=${afterRestart}`);

  // 4. Schema backup/restore including new tables.
  run(`${bin}/psql`, ['-h', '127.0.0.1', '-p', String(port), '-U', 'ugc_os_app', '-d', 'postgres', '-c', 'CREATE DATABASE phase_i_restore']);
  const dump = join(base, 'phase-i.dump');
  run('pg_dump', ['-Fc', '-s', '-h', '127.0.0.1', '-p', String(port), '-U', 'ugc_os_app', '-d', db, '-f', dump]);
  run('pg_restore', ['-h', '127.0.0.1', '-p', String(port), '-U', 'ugc_os_app', '-d', 'phase_i_restore', '--no-owner', '--no-privileges', dump]);
  const restored = run(`${bin}/psql`, ['-h', '127.0.0.1', '-p', String(port), '-U', 'ugc_os_app', '-d', 'phase_i_restore', '-tAc',
    "select tablename from pg_tables where schemaname='public' and tablename in ('Incident','RecoveryRun','ImprovementTask','SandboxRun') order by 1"]).trim().split('\n');
  check('backup_restore_new_tables', restored.length === 4, restored.join(','));

  report.outcome = 'passed';
} catch (error) {
  report.outcome = 'failed';
  report.error = String(error?.message ?? error);
  process.exitCode = 1;
} finally {
  if (started) run(`${bin}/pg_ctl`, ['-D', pgdata, 'stop', '-m', 'fast']);
  report.finishedAt = new Date().toISOString();
  const dir = join(root, 'docs', 'testing', 'evidence', 'phase-i');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'db-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outcome: report.outcome, checks: report.checks, error: report.error }, null, 2));
}
