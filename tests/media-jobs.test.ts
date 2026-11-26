import 'dotenv/config';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { workspaceMediaRoot } from '../src/media-workspace.js';

const FFMPEG_DOUBLE = `#!/bin/sh
if [ -n "$FAKE_FFMPEG_SLEEP" ]; then sleep "$FAKE_FFMPEG_SLEEP"; fi
if [ -n "$FAKE_FFMPEG_FAIL" ]; then
  printf 'SECRET_MARKER=ffmpeg-failed /etc/shadow\\n' >&2
  exit 1
fi
last=''
for arg in "$@"; do last="$arg"; done
mkdir -p "$(dirname "$last")" || exit 1
printf 'fake-clip-bytes' > "$last" || exit 1
exit 0
`;

const FFPROBE_DOUBLE = `#!/bin/sh
cat <<'JSON'
{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1280,"height":720,"duration":"12.5","bit_rate":"1000000"}],"format":{"format_name":"mp4","duration":"12.5","size":"1000000","bit_rate":"1100000"}}
JSON
`;

describe('Phase E media jobs, batch export and files', () => {
  let app: any;

  beforeAll(async () => {
    app = await buildServer();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function workspace() {
    const suffix = randomUUID();
    const email = `media-e-${suffix}@x.com`;
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email, password: 'password1234', workspaceName: 'Media E', workspaceSlug: `media-e-${suffix}` },
    });
    expect(signup.statusCode).toBe(201);
    const workspaceId = signup.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    return {
      workspaceId,
      headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId },
    };
  }

  async function installDoubles(directory: string) {
    const ffmpeg = path.join(directory, 'ffmpeg-double');
    const ffprobe = path.join(directory, 'ffprobe-double');
    await writeFile(ffmpeg, FFMPEG_DOUBLE, { mode: 0o755 });
    await writeFile(ffprobe, FFPROBE_DOUBLE, { mode: 0o755 });
    await chmod(ffmpeg, 0o755);
    await chmod(ffprobe, 0o755);
    vi.stubEnv('FFMPEG_BIN', ffmpeg);
    vi.stubEnv('FFPROBE_BIN', ffprobe);
  }

  async function createSource(workspaceId: string) {
    const root = workspaceMediaRoot(workspaceId);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'source.mp4'), 'fake source bytes');
  }

  it('rejects languages outside de|en|auto before touching media', async () => {
    const { headers } = await workspace();
    const res = await app.inject({
      method: 'POST',
      url: '/api/media/transcription/audio',
      headers,
      payload: { audioName: 'missing.wav', language: 'fr' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_INPUT');
  });

  it('exports a batch with per-item results, unique names and redacted errors', async () => {
    const { workspaceId, headers } = await workspace();
    await createSource(workspaceId);
    const directory = workspaceMediaRoot(workspaceId);
    await installDoubles(directory);

    const payload = {
      inputName: 'source.mp4',
      clips: [
        { name: 'clip-a.mp4', start: 0, duration: 3 },
        { name: 'clip-b.mp4', start: 4, duration: 3, vertical: true, width: 720, height: 1280 },
        { name: 'too-long.mp4', start: 10, duration: 10 },
      ],
    };
    const res = await app.inject({ method: 'POST', url: '/api/media/export/batch', headers, payload });
    expect(res.statusCode).toBe(200);
    const batch = res.json().batch;
    expect(batch.total).toBe(3);
    expect(batch.succeeded).toBe(2);
    expect(batch.failed).toBe(1);
    expect(batch.results.map((item: any) => item.name)).toEqual(['clip-a.mp4', 'clip-b.mp4', 'too-long.mp4']);
    expect(batch.results[2]).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'CLIP_OUT_OF_RANGE' } });
    expect(res.body).not.toContain(directory);
    expect(batch.results[0].outputName).toBe('clip-a.mp4');

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/media/export/batch',
      headers,
      payload: { inputName: 'source.mp4', clips: [{ name: 'same.mp4', start: 0, duration: 1 }, { name: 'same.mp4', start: 1, duration: 1 }] },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().code).toBe('DUPLICATE_OUTPUT_NAME');

    vi.stubEnv('FAKE_FFMPEG_FAIL', '1');
    try {
      const failed = await app.inject({
        method: 'POST',
        url: '/api/media/export/batch',
        headers,
        payload: { inputName: 'source.mp4', clips: [{ name: 'failed.mp4', start: 0, duration: 1 }] },
      });
      expect(failed.statusCode).toBe(200);
      expect(failed.json().batch.results[0].ok).toBe(false);
      expect(failed.body).not.toContain('SECRET_MARKER');
      expect(failed.body).not.toContain('/etc/shadow');
    } finally {
      vi.stubEnv('FAKE_FFMPEG_FAIL', '');
      vi.unstubAllEnvs();
    }
  });

  it('enqueues a MEDIA job, advances progress and completes every clip', async () => {
    const { workspaceId, headers } = await workspace();
    await createSource(workspaceId);
    await installDoubles(workspaceMediaRoot(workspaceId));
    try {
      const enqueued = await app.inject({
        method: 'POST',
        url: '/api/media/jobs',
        headers,
        payload: {
          sourceName: 'source.mp4',
          clips: [{ name: 'job-a.mp4', start: 0, duration: 2 }, { name: 'job-b.mp4', start: 3, duration: 2 }],
        },
      });
      expect(enqueued.statusCode).toBe(201);
      expect(enqueued.json().job).toMatchObject({ status: 'QUEUED', category: 'MEDIA', payload: { kind: 'media_clip', stage: 'queued', progress: 0 } });
      const id = enqueued.json().job.id;

      const processed = await app.inject({ method: 'POST', url: `/api/media/jobs/${id}/process`, headers });
      expect(processed.statusCode).toBe(200);
      expect(processed.json().job).toMatchObject({ status: 'SUCCEEDED', payload: { stage: 'complete', progress: 100 } });
      expect(processed.json().job.payload.result.items).toHaveLength(2);

      const status = await app.inject({ method: 'GET', url: `/api/media/jobs/${id}`, headers });
      expect(status.statusCode).toBe(200);
      expect(status.body).not.toContain(workspaceMediaRoot(workspaceId));
      expect(status.json().job.payload.result.items.every((item: any) => item.ok)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('cancels a running job cooperatively and resets stage/progress on retry', async () => {
    const { workspaceId, headers } = await workspace();
    await createSource(workspaceId);
    await installDoubles(workspaceMediaRoot(workspaceId));
    vi.stubEnv('FAKE_FFMPEG_SLEEP', '2');
    try {
      const enqueued = await app.inject({
        method: 'POST',
        url: '/api/media/jobs',
        headers,
        payload: { sourceName: 'source.mp4', clips: [{ name: 'slow.mp4', start: 0, duration: 2 }] },
      });
      expect(enqueued.statusCode).toBe(201);
      const id = enqueued.json().job.id;

      const processing = app.inject({ method: 'POST', url: `/api/media/jobs/${id}/process`, headers });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const cancelled = await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers, payload: { reason: 'operator test' } });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().job.status).toBe('CANCELLED');
      const processed = await processing;
      expect(processed.json().cancelled).toBe(true);
      expect(processed.json().job.status).toBe('CANCELLED');

      vi.stubEnv('FAKE_FFMPEG_SLEEP', '');
      const retried = await app.inject({ method: 'POST', url: `/api/jobs/${id}/retry`, headers });
      expect(retried.statusCode).toBe(200);
      const status = await app.inject({ method: 'GET', url: `/api/media/jobs/${id}`, headers });
      expect(status.json().job).toMatchObject({ status: 'QUEUED', payload: { stage: 'queued', progress: 0 } });
    } finally {
      vi.unstubAllEnvs();
      await withWorkspaceTransaction(workspaceId, (tx: any) => tx.job.deleteMany({ where: { workspaceId } }));
    }
  });

  it('isolates basename-only uploads and previews by workspace and supports ranges', async () => {
    const first = await workspace();
    const second = await workspace();
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/media/upload?name=note.txt',
      headers: { ...first.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('hello world'),
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().upload).toMatchObject({ name: 'note.txt', bytes: 11 });

    const preview = await app.inject({ method: 'GET', url: '/api/media/files/note.txt', headers: first.headers });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toBe('hello world');
    const ranged = await app.inject({ method: 'GET', url: '/api/media/files/note.txt', headers: { ...first.headers, range: 'bytes=0-4' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe('hello');
    expect(ranged.headers['content-range']).toBe('bytes 0-4/11');

    const otherWorkspace = await app.inject({ method: 'GET', url: '/api/media/files/note.txt', headers: second.headers });
    expect(otherWorkspace.statusCode).toBe(404);
    const traversal = await app.inject({ method: 'GET', url: '/api/media/files/%2E%2E%2Fsecret.txt', headers: first.headers });
    expect(traversal.statusCode).toBe(400);

    vi.stubEnv('UGC_MEDIA_MAX_UPLOAD_BYTES', '1024');
    try {
      const tooLarge = await app.inject({
        method: 'POST',
        url: '/api/media/upload',
        headers: first.headers,
        payload: { name: 'large.bin', contentBase64: Buffer.alloc(2048, 7).toString('base64') },
      });
      expect(tooLarge.statusCode).toBe(413);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
