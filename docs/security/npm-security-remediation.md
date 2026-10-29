# npm Security Remediation Report — UGC Affiliate Creator Clipping OS

## 1. Ausgangsbefund und Advisory-IDs

- Repository: `/home/carryos/ugc-affiliate-creator-clipping-os`
- Branch: `main` @ `4b0dec6c03a2f7a9cdbb88800aff9b034a6d78f1`
- Ausgangs-Baseline (Commit `4b0dec6`, Tag `audit-pre-npm-security-baseline`):
  - `npm audit`: **10 vulnerabilities** (3 moderate, 5 high, 2 critical)
  - `npm audit --omit=dev`: **4 high** severity
- Advisory-IDs und Ursachen:

| ID | Paket | Severity | Betroffene Versionen | Fix |
|---|---|---|---|---|
| GHSA-mrhx-c7xc-m3w5 | zod | high | <4.6.6 | zod@4.6.7 |
| GHSA-ggr8-5vv4-36mx | deepmerge-ts | high | <8.0.0 | via Prisma 7.10.1 (`@prisma/config@7.10.1` → deepmerge-ts 8.0.2) |
| GHSA-5xrq-8626-4rwp | vitest | critical | <3.2.6 | vitest@5.0.5 |
| GHSA-5gmw-xhrv-c9v3 / GHSA-85c8-ppgw-ccpr | tinypool | critical | <=2.1.0 / <2.1.2 | vitest@5.0.5 |
| GHSA-82fw-gwwq-j7x9 / GHSA-qxg6-89mg-rqv8 | @vitest/mocker | moderate | >=2.1.0 <4.1.11 / >=2.1.0-beta.7 <4.1.12 | vitest@5.0.5 |
| GHSA-67mh-4wv8-2f99 | esbuild | moderate | <=0.24.2 | vitest@5.0.5 (esbuild 0.28.2) |
| GHSA-587h-7wmj-h5pm / GHSA-4w7w-66w2-5vf9 / GHSA-v6wh-96g9-6wx3 / GHSA-698v-4r3x-3vcv / GHSA-r825-w8mm-5pxw / GHSA-9jrq-w75r-8gcw / GHSA-rq7h-c2jc-7f22 / GHSA-fx2h-pf6j-xcff | vite | high/moderate/low | <=6.4.3 | vitest@5.0.5 (vite 8.3.5) |
| (via vite) | vite-node | moderate | <=2.2.0-beta.2 | vitest@5.0.5 |

## 2. Behebung

- **Zod**: Upgrade `3.25.76` → `4.6.7` (Fix für GHSA-mrhx-c7xc-m3w5, Breaking-Major).
- **Prisma / deepmerge-ts**: Upgrade `prisma`/`@prisma/client`/`@prisma/engines`/`@prisma/config` von `6.19.3` → `7.10.1` (Fix für GHSA-ggr8-5vv4-36mx, Breaking-Major); daraus folgt `deepmerge-ts` `7.1.5` → `8.0.2`. Neuer Driver-Adapter `@prisma/adapter-pg@7.10.1` erforderlich.
- **Vitest / Vite / esbuild / tinypool / @vitest/mocker / vite-node**: Upgrade `vitest` von `2.1.9` → `5.0.5`, `vite` auf `8.3.5` (peer), `@vitest/mocker@5.0.5`; esbuild auf `0.28.2`.

## 3. Geänderte Pakete (alt → neu)

| Paket | Alt | Neu | Advisory | Breaking |
|---|---|---|---|---|
| zod | 3.25.76 | 4.6.7 | GHSA-mrhx-c7xc-m3w5 | ja |
| prisma | 6.19.3 | 7.10.1 | GHSA-ggr8-5vv4-36mx | ja |
| @prisma/client | 6.19.3 | 7.10.1 | GHSA-ggr8-5vv4-36mx | ja |
| @prisma/engines | 6.19.3 | 7.10.1 | GHSA-ggr8-5vv4-36mx | ja |
| @prisma/config | 6.19.3 | 7.10.1 | GHSA-ggr8-5vv4-36mx | ja |
| deepmerge-ts | 7.1.5 | 8.0.2 | GHSA-ggr8-5vv4-36mx | nein |
| @prisma/adapter-pg | — | 7.10.1 | — | nein (neu) |
| vitest | 2.1.9 | 5.0.5 | mehrere | ja |
| vite | 5.4.21 | 8.3.5 | mehrere | nein |
| @vitest/mocker | 2.1.9 | 5.0.5 | mehrere | ja |
| esbuild | 0.21.5 | 0.28.2 | GHSA-67mh-4wv8-2f99 | nein |

## 4. Geänderte Dateien

- `package.json` (Dependency-Versionen, `allowScripts`)
- `package-lock.json`
- `prisma/schema.prisma` (Datasource `url` entfernt)
- `prisma.config.ts` (neu; Datasource-URL via `env("DATABASE_URL")`)
- `lib/db.ts` (PrismaClient mit `PrismaPg`-Adapter)
- `src/index.ts` (Zod-4-Schema-Migration)
- `tests/validation.test.ts` (neu; Regressionstests für Validierungen)

## 5. Erforderliche Prisma-/Zod-Migrationen

- **Prisma 6 → 7 (Breaking):**
  - Datasource-URL aus `prisma/schema.prisma` entfernt; Migrationen/CLI via `prisma.config.ts` (`datasource.url = env("DATABASE_URL")`).
  - `PrismaClient`-Instanz um Driver-Adapter erweitert: `new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' })` → `new PrismaClient({ adapter })`.
  - Client neu generiert (`prisma generate`, v7.10.1).
  - Keine neuen Migrationsdateien erforderlich; bestehende 30 Migrationen blieben bislang unangetastet (Status: up to date).
- **Zod 3 → 4 (Breaking):**
  - `z.string().trim().toLowerCase().email().max(254)` → `z.string().trim().toLowerCase().max(254).pipe(z.email())`
  - `z.string().trim().toLowerCase().email()` → `z.string().trim().toLowerCase().pipe(z.email())`
  - `safeParse`-Workflow und Fehlersemantik (`success`/`data`) unverändert.

## 6. Quality Gates — Ergebnisse

| Prüfung | Befehl | Ergebnis | Exit-Code |
|---|---|---|---|
| Dependency tree | `npm ls --all` | OK (nur optional UNMET `pg-native`, unkritisch) | 0 |
| Audit (gesamt) | `npm audit` | **found 0 vulnerabilities** | 0 |
| Audit (prod only) | `npm audit --omit=dev` | **found 0 vulnerabilities** | 0 |
| Lint | `npm run lint` | 0 errors / 0 warnings | 0 |
| Typecheck | `npm run typecheck` | OK | 0 |
| Tests | `npm test` | **20 files / 38 tests bestanden** (davon 3 neue Validierungs-Regressionstests) | 0 |
| Build | `npm run build` | OK | 0 |
| Prisma validate | `npx prisma validate` | Schema valid | 0 |
| Prisma generate | `npx prisma generate` | Client v7.10.1 generiert | 0 |
| Prisma migrate status | `npx prisma migrate status` | 30 migrations, up to date | 0 |

## 7. npm-Audit-Ergebnisse

- Vorher: `npm audit` → 10 vulnerabilities (3 moderate, 5 high, 2 critical); `--omit=dev` → 4 high.
- Nachher: `npm audit` → **0 vulnerabilities**; `npm audit --omit=dev` → **0 vulnerabilities**.

## 8. Verbleibende Schwachstellen

- **Keine offenen Schwachstellen mehr gemeldet** (Produkt- und Entwicklungsumfang). Ursache: kontrollierte Major-Upgrades auf die fixespezifischen Zielversionen (zod 4.6.7, prisma 7.10.1 inkl. Adapter, vitest 5.0.5 inkl. vite 8.3.5).

## 9. Rollback-Anleitung

- Ausgangs-Tag: `audit-pre-npm-security-baseline` (HEAD `4b0dec6`).
- Referenzen: `git checkout audit-pre-npm-security-baseline`, vorherige `package.json`-/`package-lock.json`-Versionen wiederherstellen, ggf. `prisma.config.ts`/`lib/db.ts`/`src/index.ts` auf Ausgangsstand zurücksetzen und `npm ci` ausführen.

## 10. Noch notwendige manuelle Schritte

- GitHub-Actions-Run nach Upgrade (CI war zu Beginn durch GitHub-Billing-Lock blockiert → nicht ausführbar).
- Deployment-/Infrastruktur-Validierung.

## 11. Nicht ausgeführte Prüfungen

- E2E-Tests: **NICHT AUSGEFÜHRT** (kein E2E-Setup im Repository vorhanden).
- CI-Execution: **NICHT AUSGEFÜHRT** (GitHub Actions Job-Start durch Account-Billing-Lock blockiert; lokale Checks grün).
