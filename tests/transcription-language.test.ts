import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeTranscriptionLanguage,
  runWhisper,
  transcribeAudio,
  whisperThreadCount,
} from '../src/transcription.js';

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ugc-language-'));
  directories.push(directory);
  return directory;
}

async function fixture(directory: string): Promise<{ audio: string; english: string; multilingual: string; binary: string; argvLog: string }> {
  const audio = path.join(directory, 'audio.wav');
  const english = path.join(directory, 'ggml-tiny.en.bin');
  const multilingual = path.join(directory, 'ggml-tiny.bin');
  const binary = path.join(directory, 'whisper-double');
  const argvLog = path.join(directory, 'argv.log');
  await Promise.all([
    writeFile(audio, 'RIFF placeholder'),
    writeFile(english, 'english weights placeholder'),
    writeFile(multilingual, 'multilingual weights placeholder'),
  ]);
  await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args));
const out = args[args.indexOf('-of') + 1];
writeFileSync(out + '.txt', 'Deutschland ist ein Land.');
writeFileSync(out + '.srt', '1\\n00:00:00,000 --> 00:00:02,000\\nDeutschland ist ein Land.\\n');
`);
  await chmod(binary, 0o755);
  return { audio, english, multilingual, binary, argvLog };
}

describe('transcription language allowlist and model selection', () => {
  it('accepts only de, en and auto', () => {
    expect(normalizeTranscriptionLanguage('de')).toBe('de');
    expect(normalizeTranscriptionLanguage(' EN ')).toBe('en');
    expect(normalizeTranscriptionLanguage('auto')).toBe('auto');
    expect(normalizeTranscriptionLanguage(undefined)).toBeUndefined();
    for (const rejected of ['fr', 'de-DE', 1, '', 'english']) {
      expect(() => normalizeTranscriptionLanguage(rejected)).toThrow('INVALID_INPUT');
      try {
        normalizeTranscriptionLanguage(rejected);
      } catch (error: any) {
        expect(error.details.reason).toMatch(/language must be one of/);
      }
    }
  });

  it('fails closed for German when no multilingual model is configured', async () => {
    const directory = await tempDir();
    const { audio, english, binary } = await fixture(directory);
    vi.stubEnv('WHISPER_MODEL', english);
    vi.stubEnv('WHISPER_MODEL_MULTILINGUAL', '');
    await expect(transcribeAudio({ audioPath: audio, outputDir: directory, binary, language: 'de' }))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED', message: 'WHISPER_MULTILINGUAL_MODEL_NOT_CONFIGURED' });
  });

  it('refuses to use English-only weights for German even when explicitly supplied', async () => {
    const directory = await tempDir();
    const { audio, english, binary } = await fixture(directory);
    await expect(transcribeAudio({ audioPath: audio, outputDir: directory, binary, language: 'de', modelPath: english }))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED', message: 'WHISPER_MULTILINGUAL_MODEL_REQUIRED' });
  });

  it('selects the multilingual model and passes the allowlisted language flag', async () => {
    const directory = await tempDir();
    const { audio, english, multilingual, binary, argvLog } = await fixture(directory);
    vi.stubEnv('WHISPER_MODEL', english);
    vi.stubEnv('WHISPER_MODEL_MULTILINGUAL', multilingual);
    const result = await transcribeAudio({ audioPath: audio, outputDir: directory, binary, language: 'de' });
    expect(result.text).toContain('Deutschland');
    const argv = JSON.parse(await readFile(argvLog, 'utf8')) as string[];
    expect(argv).toContain('de');
    expect(argv[argv.indexOf('-m') + 1]).toBe(multilingual);

    const auto = await transcribeAudio({ audioPath: audio, outputDir: directory, binary, language: 'auto' });
    expect(auto.ok).toBe(true);
    const autoArgv = JSON.parse(await readFile(argvLog, 'utf8')) as string[];
    expect(autoArgv).toContain('auto');
    expect(autoArgv[autoArgv.indexOf('-m') + 1]).toBe(multilingual);
  });

  it('clamps whisper threads to two unless the operator raises the cap', async () => {
    const directory = await tempDir();
    const { audio, english, binary, argvLog } = await fixture(directory);
    vi.stubEnv('WHISPER_THREADS', '8');
    vi.stubEnv('WHISPER_THREADS_MAX', '');
    expect(whisperThreadCount()).toBe(2);
    await transcribeAudio({ audioPath: audio, outputDir: directory, binary, modelPath: english, language: 'en' });
    let argv = JSON.parse(await readFile(argvLog, 'utf8')) as string[];
    expect(argv[argv.indexOf('-t') + 1]).toBe('2');

    vi.stubEnv('WHISPER_THREADS_MAX', '4');
    expect(whisperThreadCount()).toBe(4);
    await transcribeAudio({ audioPath: audio, outputDir: directory, binary, modelPath: english, language: 'en' });
    argv = JSON.parse(await readFile(argvLog, 'utf8')) as string[];
    expect(argv[argv.indexOf('-t') + 1]).toBe('4');
  });

  it('runWhisper kills a live child on abort and settles promptly', async () => {
    const directory = await tempDir();
    const sleeper = path.join(directory, 'sleeper');
    await writeFile(sleeper, '#!/bin/sh\nprintf "started" >&2\nsleep 5\n');
    await chmod(sleeper, 0o755);
    const controller = new AbortController();
    const started = Date.now();
    const pending = runWhisper(sleeper, [], 10_000, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: 'TRANSCRIBE_FAILED', message: 'TRANSCRIBE_ABORTED' });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

// Cleanup is deferred so failures still leave reproducible fixtures for inspection.
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
