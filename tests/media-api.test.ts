import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';
import { workspaceMediaRoot } from '../src/media-workspace.js';

describe('workspace media API', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  async function workspaceHeaders() {
    const suffix = randomUUID();
    const email = `media-${suffix.slice(0, 12)}@x.com`;
    const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'Media', workspaceSlug: `media-${suffix}` } });
    expect(signup.statusCode).toBe(201);
    const workspaceId = signup.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    return { workspaceId, headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId } };
  }

  it('writes a real SRT file inside the workspace temp root and rejects traversal', async () => {
    const { workspaceId, headers } = await workspaceHeaders();
    const res = await app.inject({
      method: 'POST', url: '/api/media/subtitles', headers,
      payload: { name: 'captions.srt', cues: [{ start: 0, end: 2.5, text: 'Hello world' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().subtitles.cues).toBe(1);
    const content = await readFile(res.json().subtitles.path, 'utf8');
    expect(content).toBe('1\n00:00:00,000 --> 00:00:02,500\nHello world\n');
    expect(res.json().subtitles.path).toContain(workspaceId);

    const traversal = await app.inject({
      method: 'POST', url: '/api/media/subtitles', headers,
      payload: { name: '../escape.srt', cues: [] },
    });
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json().code).toBe('INVALID_MEDIA_NAME');
  }, 60_000);

  it('returns explicit NOT_CONFIGURED for export when ffmpeg is absent', async () => {
    const { workspaceId, headers } = await workspaceHeaders();
    const root = workspaceMediaRoot(workspaceId);
    await mkdir(root, { recursive: true });
    await writeFile(`${root}/source.mp4`, 'source placeholder for pipeline error classification');
    vi.stubEnv('FFMPEG_BIN', '/nonexistent/ffmpeg');
    vi.stubEnv('FFPROBE_BIN', '/nonexistent/ffprobe');
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/media/export', headers,
        payload: { inputName: 'source.mp4', outputName: 'clip.mp4', start: 0, duration: 5 },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: { code: 'NOT_CONFIGURED' } });
      expect(res.json().result.ok).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it('derives highlights from supplied text and rejects missing audio honestly', async () => {
    const { headers } = await workspaceHeaders();
    const transcript = '00:00:00.000 --> 00:00:05.000\nThis product saved me 30 percent, and here is the proof!';
    const highlights = await app.inject({
      method: 'POST', url: '/api/media/transcription/highlights', headers,
      payload: { text: transcript, keywords: ['product'], minScore: 2 },
    });
    expect(highlights.statusCode).toBe(200);
    expect(highlights.json().highlights).toHaveLength(1);
    expect(highlights.json().highlights[0].startMs).toBe(0);

    const audio = await app.inject({
      method: 'POST', url: '/api/media/transcription/audio', headers,
      payload: { audioName: 'missing.wav' },
    });
    expect(audio.statusCode).toBe(400);
    expect(audio.json().code).toBe('MEDIA_NOT_FOUND');
  }, 60_000);
});
