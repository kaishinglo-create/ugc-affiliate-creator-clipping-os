import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { workspaceMediaRoot } from '../src/media-workspace.js';

const workspaceIds: string[] = [];
let app: any;

// Named test doubles for ffmpeg/ffprobe; production uses the real binaries.
const FFMPEG_DOUBLE = `#!/bin/sh
case " $* " in
  *showinfo*)
    printf 'frame=1 pts_time:1.20 pos=0\\n' >&2
    printf 'frame=2 pts_time:4.80 pos=0\\n' >&2
    exit 0
    ;;
esac
last=''
for arg in "$@"; do last="$arg"; done
mkdir -p "$(dirname "$last")" || exit 1
printf 'rendered-authorized-clip' > "$last"
exit 0
`;

const FFPROBE_DOUBLE = `#!/bin/sh
cat <<'JSON'
{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1080,"height":1920,"duration":"12.5"},{"index":1,"codec_type":"audio","codec_name":"aac"}],"format":{"format_name":"mp4","duration":"12.5","size":"1000000"}}
JSON
`;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (app) await app.close();
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.$disconnect();
});

describe('Phase G autonomous agent pipeline', () => {
  it('queues a PHASE_G_PIPELINE job and the engine produces real artifacts and a pending release', async () => {
    app = await buildServer();
    const suffix = randomUUID();
    const email = `pipeline-${suffix}@x.com`;
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email, password: 'password1234', workspaceName: 'Pipeline', workspaceSlug: `pipeline-${suffix}` },
    });
    expect(signup.statusCode).toBe(201);
    const workspaceId = signup.json().workspace.id;
    workspaceIds.push(workspaceId);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const headers = { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId };
    const root = workspaceMediaRoot(workspaceId);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'source.mp4'), 'authorized source bytes');
    const ffmpeg = path.join(root, 'ffmpeg-pipeline');
    const ffprobe = path.join(root, 'ffprobe-pipeline');
    await writeFile(ffmpeg, FFMPEG_DOUBLE, { mode: 0o755 });
    await writeFile(ffprobe, FFPROBE_DOUBLE, { mode: 0o755 });
    vi.stubEnv('FFMPEG_BIN', ffmpeg);
    vi.stubEnv('FFPROBE_BIN', ffprobe);

    const queued = await app.inject({
      method: 'POST',
      url: '/api/phase-g/pipeline',
      headers,
      payload: {
        sourceName: 'source.mp4',
        outputPrefix: 'studio',
        profile: '9:16',
        rightsStatus: 'AUTHORIZED',
        topic: 'creator workflow',
        highlights: [{ startMs: 1_100, endMs: 5_000, text: 'hook', score: 0.9 }],
      },
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json().job.payload.stage).toBe('queued');
    const jobId = queued.json().job.id;

    const tick = await app.inject({ method: 'POST', url: '/api/engine/tick', headers, payload: {} });
    expect(tick.statusCode).toBe(200);

    const status = await app.inject({ method: 'GET', url: `/api/phase-g/pipeline/${jobId}`, headers });
    expect(status.statusCode).toBe(200);
    expect(status.json().job.status).toBe('SUCCEEDED');
    const result = status.json().job.payload.result;
    expect(result).toMatchObject({ clipName: 'studio-9x16.mp4', profile: '9:16', qualityPassed: true });
    expect(result.sceneTimestamps).toEqual([1.2, 4.8]);
    expect(result.approvalId).toBeTruthy();

    const reports: any[] = await withWorkspaceTransaction<any[]>(workspaceId, (tx: any) => tx.qualityReport.findMany({ where: { workspaceId } }));
    expect(reports).toHaveLength(1);
    expect(reports[0].passed).toBe(true);
    const approvals: any[] = await withWorkspaceTransaction<any[]>(workspaceId, (tx: any) => tx.approval.findMany({ where: { workspaceId, entityType: 'media_clip' } }));
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe('pending');
  });
});
