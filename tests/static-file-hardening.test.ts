import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePublicFile } from '../lib/static-files.js';

describe('static file symlink hardening', () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await mkdtemp('/tmp/opencode/ugc-static-test-');
    outside = await mkdtemp('/tmp/opencode/ugc-static-outside-');
    await writeFile(join(root, 'index.html'), 'ok');
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await mkdir(join(outside, 'nested'));
    await writeFile(join(outside, 'nested', 'file.txt'), 'outside');
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    await symlink(join(root, 'index.html'), join(root, 'inside.txt'));
    await symlink(join(outside, 'nested'), join(root, 'nested-link'));
    await symlink(root, `${root}-link`);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(`${root}-link`, { recursive: true, force: true });
  });

  it('serves real in-tree files', async () => {
    await expect(resolvePublicFile(root, 'index.html')).resolves.toEqual({ ok: true, path: join(root, 'index.html') });
    await expect(resolvePublicFile(root, 'assets/app.js')).resolves.toEqual({ ok: true, path: join(root, 'assets', 'app.js') });
    await expect(resolvePublicFile(`${root}-link`, 'index.html')).resolves.toEqual({ ok: true, path: join(root, 'index.html') });
  });

  it('rejects traversal outside the public root', async () => {
    await expect(resolvePublicFile(root, `../${outside.split('/').pop()}/secret.txt`)).resolves.toEqual({ ok: false, reason: 'FORBIDDEN' });
    await expect(resolvePublicFile(root, 'nested-link/file.txt')).resolves.toEqual({ ok: false, reason: 'FORBIDDEN' });
  });

  it('rejects symlinks even when the target is inside the public root', async () => {
    await expect(resolvePublicFile(root, 'escape.txt')).resolves.toEqual({ ok: false, reason: 'FORBIDDEN' });
    await expect(resolvePublicFile(root, 'inside.txt')).resolves.toEqual({ ok: false, reason: 'FORBIDDEN' });
  });

  it('distinguishes missing files and directories', async () => {
    await expect(resolvePublicFile(root, 'missing.txt')).resolves.toEqual({ ok: false, reason: 'NOT_FOUND' });
    await expect(resolvePublicFile(root, 'assets')).resolves.toEqual({ ok: false, reason: 'NOT_FOUND' });
    await expect(resolvePublicFile(root, '\0')).resolves.toEqual({ ok: false, reason: 'INVALID_PATH' });
  });
});
