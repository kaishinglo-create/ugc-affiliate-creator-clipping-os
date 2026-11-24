import 'dotenv/config';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { detectHighlights, parseTranscript, transcribeAndHighlight, transcribeAudio } from '../src/transcription.js';

const TIMED_TRANSCRIPT = `00:00:00.000 --> 00:00:04.000
Welcome to the channel.

00:00:05.000 --> 00:00:12.000
This gadget saved me 37 percent on my bill, and here is the proof!

00:00:13.000 --> 00:00:18.000
Would you buy it?`;

it('parses real timestamped transcript lines without inventing segments', () => {
  const segments = parseTranscript(TIMED_TRANSCRIPT);
  expect(segments).toHaveLength(3);
  expect(segments[1]).toEqual({ startMs: 5000, endMs: 13_000, text: 'This gadget saved me 37 percent on my bill, and here is the proof!' });
  expect(parseTranscript('plain transcript')).toEqual([{ startMs: null, endMs: null, text: 'plain transcript' }]);
});

it('detects highlights only from evidence in the transcript', () => {
  const highlights = detectHighlights(TIMED_TRANSCRIPT, { keywords: ['gadget'], minScore: 3 });
  expect(highlights).toHaveLength(1);
  expect(highlights[0].startMs).toBe(5000);
  expect(highlights[0].endMs).toBe(13_000);
  expect(highlights[0].reasons).toEqual(expect.arrayContaining(['keyword:gadget', 'number_or_stat', 'emphasis']));
  expect(detectHighlights('nothing notable here', { minScore: 2 })).toEqual([]);
});

it('reports NOT_CONFIGURED instead of fabricating a transcript', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ugc-transcribe-missing-'));
  try {
    const audio = join(directory, 'audio.wav');
    const model = join(directory, 'model.bin');
    await writeFile(audio, 'RIFF');
    await writeFile(model, 'model');
    await expect(transcribeAudio({
      audioPath: audio,
      outputDir: directory,
      modelPath: model,
      binary: join(directory, 'does-not-exist'),
    })).rejects.toMatchObject({ code: 'NOT_CONFIGURED', message: 'WHISPER_NOT_CONFIGURED' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('uses a real local binary output and derives highlights from that file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ugc-transcribe-double-'));
  try {
    const audio = join(directory, 'audio.wav');
    const model = join(directory, 'model.bin');
    await writeFile(audio, 'RIFF');
    await writeFile(model, 'model');
    // Explicit test double: records argv and writes a real transcript file. It is not speech recognition.
    const binary = join(directory, 'whisper-double');
    await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(directory, 'argv.log'))}, JSON.stringify(args));
const out = args[args.indexOf('-of') + 1];
writeFileSync(out + '.txt', ${JSON.stringify(TIMED_TRANSCRIPT)});
`);
    await chmod(binary, 0o755);
    vi.stubEnv('WHISPER_BIN', binary);
    const result = await transcribeAndHighlight({
      audioPath: audio,
      outputDir: directory,
      modelPath: model,
      binary,
      keywords: ['gadget'],
      minScore: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.segments).toHaveLength(3);
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0].text).toContain('37 percent');
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
