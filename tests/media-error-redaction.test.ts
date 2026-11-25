import { describe, expect, it } from 'vitest';
import { mediaErrorBody } from '../src/media-workspace.js';

describe('media error redaction', () => {
  it('does not return absolute paths or captured stderr to callers', () => {
    const error = Object.assign(new Error('FFMPEG_FAILED'), {
      code: 'FFMPEG_FAILED',
      details: {
        binary: 'ffmpeg',
        path: '/tmp/ugc-media/secret-workspace/clip.mp4',
        exitCode: 1,
        stderr: 'ffmpeg: /etc/shadow permission denied\nsecret-token-value',
      },
    });

    const body = mediaErrorBody(error);
    expect(body).toEqual({
      error: 'FFMPEG_FAILED',
      code: 'FFMPEG_FAILED',
      details: { binary: 'ffmpeg', exitCode: 1 },
    });
    expect(JSON.stringify(body)).not.toContain('/tmp/ugc-media');
    expect(JSON.stringify(body)).not.toContain('/etc/shadow');
    expect(JSON.stringify(body)).not.toContain('secret-token-value');
    expect(JSON.stringify(body)).not.toContain('permission denied');
  });

  it('keeps a stable classification when no safe details exist', () => {
    const body = mediaErrorBody({ code: 'NOT_CONFIGURED', details: { path: '/etc/passwd' } });
    expect(body).toEqual({ error: 'MEDIA_PIPELINE_FAILED', code: 'NOT_CONFIGURED' });
  });
});
