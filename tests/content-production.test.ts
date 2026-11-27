import { describe, expect, it } from 'vitest';
import { PRODUCTION_PROFILES, resolveProfile, srtToVtt, suggestCopy, thumbnailArgs } from '../src/content-production.js';

describe('Phase G content production', () => {
  it('exposes the three aspect profiles', () => {
    expect(PRODUCTION_PROFILES.map((profile) => profile.key)).toEqual(['9:16', '16:9', '1:1']);
    expect(resolveProfile('9:16')).toMatchObject({ width: 1080, height: 1920 });
  });

  it('converts SRT timestamps to VTT', () => {
    const vtt = srtToVtt('1\n00:00:01,500 --> 00:00:03,000\nHello');
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('00:00:01.500 --> 00:00:03.000');
  });

  it('labels rule-based copy as non-AI', () => {
    const suggestion = suggestCopy({ topic: 'clipping workflow' });
    expect(suggestion.source).toBe('rule_based');
    expect(suggestion.note).toContain('Rule-based');
  });

  it('builds bounded thumbnail arguments', () => {
    const args = thumbnailArgs('/tmp/in.mp4', '/tmp/out.jpg', -5, resolveProfile('1:1'));
    expect(args).toContain('scale=1080:1080');
    expect(args).toContain('0');
  });
});
