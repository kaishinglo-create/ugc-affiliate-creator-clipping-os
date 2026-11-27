/**
 * Phase H database verification: fresh install, Phase-G -> Phase-H upgrade,
 * backup/restore and RLS/constraint checks. Uses a temporary PostgreSQL
 * cluster; no production data is changed and no secret is printed.
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = process.env.PHASE_H_DB_VERIFY_DIR || '/tmp/opencode/phase-h-db-verify';
const bin = '/usr/lib/postgresql/17/bin';
const port = Number(process.env.PHASE_H_DB_VERIFY_PORT || 39778);
const socket = join(base, 'sock');
const pgdata = join(base, 'pgdata');
const url = new URL(process.env.DATABASE_URL || '');
const source = {
  host: url.hostname, port: url.port || '5432', user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)),
};
const report = { startedAt: new Date().toISOString(), checks: [] };
let started = false;

function run(command, args, env = {}, input) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr?.slice(-800) || result.stdout?.slice(-800)}`);
  }
  return result.stdout;
}
function targetDb(db) {
  return { host: '127.0.0.1', port: String(port), user: 'ugc_os_app', database: db };
}
function psql(db, sql, env = {}) {
  const c = targetDb(db);
  return run(`${bin}/psql`, ['-h', c.host, '-p', c.port, '-U', c.user, '-d', c.database, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], env);
}
function applyMigrations(db, filter) {
  const dir = join(root, 'prisma', 'migrations');
  const names = readdirSync(dir).filter((name) => /^\d/.test(name)).sort().filter(filter);
  for (const name of names) {
    const file = join(dir, name, 'migration.sql');
    if (existsSync(file)) psql(db, readFileSync(file, 'utf8'));
  }
  return names;
}
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  if (!ok) throw new Error(`DB_VERIFY_FAILED: ${name}`);
}

try {
  mkdirSync(socket, { recursive: true });
  if (!existsSync(join(pgdata, 'PG_VERSION'))) {
    run(`${bin}/initdb`, ['-D', pgdata, '-U', 'ugc_os_app', '-A', 'trust', '--no-instructions']);
  }
  run(`${bin}/pg_ctl`, ['-D', pgdata, '-l', join(base, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1 -k ${socket}`, 'start']);
  started = true;
  for (const db of ['h5_upgrade', 'h5_restore']) {
    try { psql('postgres', `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); } catch { /* no connections */ }
    psql('postgres', `CREATE DATABASE ${db}`);
  }

  // 1. Upgrade path: all pre-Phase-H migrations, then Phase H.
  const phaseG = applyMigrations('h5_upgrade', (name) => !name.startsWith('2026112712') && !name.startsWith('2026112713') && !name.startsWith('2026112714'));
  const phaseH = applyMigrations('h5_upgrade', (name) => name.startsWith('2026112712') || name.startsWith('2026112713') || name.startsWith('2026112714'));
  check('phase_g_to_phase_h_upgrade', phaseG.length > 0 && phaseH.length === 3, `${phaseG.length} + ${phaseH.length} migrations`);
  const cols = psql('h5_upgrade', `select column_name from information_schema.columns where table_name='AffiliateLink' order by 1`).trim().split('\n');
  check('affiliate_link_columns', ['token', 'offerId', 'destinationUrl', 'commissionBps', 'disclosureText'].every((c) => cols.includes(c)), cols.join(','));
  const rls = psql('h5_upgrade', `select relname||':'||relforcerowsecurity from pg_class where relname in ('AffiliateLink','PublishingAccount','PublishingSchedule') and relforcerowsecurity order by 1`).trim().split('\n');
  check('force_rls_on_new_tables', rls.length === 3, rls.join(','));
  const constraints = psql('h5_upgrade', `select conname from pg_constraint where conname like 'AffiliateConversion_%' or conname like 'AffiliateLink_%' or conname like 'QualityReport_checksum%'`).trim().split('\n');
  check('check_constraints_present', constraints.length >= 4, constraints.join(','));

  // 2. CHECK constraint actually rejects a negative commission.
  const rejected = spawnSync(`${bin}/psql`, ['-h', '127.0.0.1', '-p', String(port), '-U', 'ugc_os_app', '-d', 'h5_upgrade', '-tAc',
    `insert into "AffiliateConversion" (id,"workspaceId","amountCents","commissionCents","convertedAt") values ('neg','ws',100,-1,now())`], { encoding: 'utf8' });
  check('negative_commission_rejected', rejected.status !== 0, rejected.stderr?.trim().split('\n')[0] || 'accepted');

  // 3. Backup/restore of the live development database.
  const dump = join(base, 'source.dump');
  // The application role is a non-superuser and FORCE RLS also applies to the
  // table owner. A data dump therefore requires a BYPASSRLS role in production;
  // this local test verifies the portable schema backup/restore path.
  run('pg_dump', ['-Fc', '-s', '-h', source.host, '-p', source.port, '-U', source.user, '-d', source.database, '-f', dump], { PGPASSWORD: source.password });
  run('pg_restore', ['-h', '127.0.0.1', '-p', String(port), '-U', 'ugc_os_app', '-d', 'h5_restore', '--no-owner', '--no-privileges', dump]);
  check('restored_schema_has_phase_h', psql('h5_restore', `select to_regclass('public."PublishingSchedule"')`).trim() !== '', 'PublishingSchedule present');
  check('restored_constraints', psql('h5_restore', `select count(*) from pg_constraint where conname like 'AffiliateConversion_%nonnegative'`).trim() !== '0', 'CHECK constraints restored');
  report.dataBackupNote = 'A full data dump requires a BYPASSRLS/superuser role; the local app role is non-superuser with FORCE RLS.';

  report.outcome = 'passed';
} catch (error) {
  report.outcome = 'failed';
  report.error = String(error?.message ?? error);
  process.exitCode = 1;
} finally {
  if (started) run(`${bin}/pg_ctl`, ['-D', pgdata, 'stop', '-m', 'fast']);
  report.finishedAt = new Date().toISOString();
  const dir = join(root, 'docs', 'testing', 'evidence', 'phase-h');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'db-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outcome: report.outcome, checks: report.checks, error: report.error }, null, 2));
}
