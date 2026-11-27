/**
 * Phase G content production helpers: aspect profiles, VTT subtitles and
 * rule-based copy suggestions explicitly labelled as heuristics.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ProductionProfile {
  key: '9:16' | '16:9' | '1:1';
  width: number;
  height: number;
  label: string;
}

export const PRODUCTION_PROFILES: ProductionProfile[] = [
  { key: '9:16', width: 1080, height: 1920, label: 'Vertical short-form' },
  { key: '16:9', width: 1920, height: 1080, label: 'Horizontal' },
  { key: '1:1', width: 1080, height: 1080, label: 'Square' },
];

export function resolveProfile(key: string): ProductionProfile {
  const profile = PRODUCTION_PROFILES.find((item) => item.key === key);
  if (!profile) throw new Error('UNKNOWN_PRODUCTION_PROFILE');
  return profile;
}

/** Resolve a profile key only when supplied; invalid keys are rejected. */
export function profileDimensions(key: unknown): { width: number; height: number } | null {
  if (key === undefined || key === null || key === '') return null;
  const profile = resolveProfile(String(key));
  return { width: profile.width, height: profile.height };
}

export function srtToVtt(srt: string): string {
  const normalized = srt.replace(/\r/g, '').replace(/^\uFEFF/, '');
  return `WEBVTT\n\n${normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').trim()}\n`;
}

export async function writeVtt(targetPath: string, srt: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, srtToVtt(srt), 'utf8');
}

/** FFmpeg thumbnail arguments derived only from validated profile dimensions. */
export function thumbnailArgs(source: string, output: string, atSeconds: number, profile: ProductionProfile): string[] {
  const at = Math.max(0, Math.min(3600, Number(atSeconds) || 1));
  return ['-y', '-ss', String(at), '-i', source, '-frames:v', '1', '-vf', `scale=${profile.width}:${profile.height}`, output];
}

export interface CopySuggestion {
  source: 'rule_based';
  title: string;
  description: string;
  hooks: string[];
  hashtags: string[];
  note: string;
}

/** Deterministic, clearly labelled rule-based suggestions; no AI claimed. */
export function suggestCopy(input: { title?: string; topic?: string; platform?: string }): CopySuggestion {
  const topic = String(input.topic ?? '').trim() || String(input.title ?? '').trim() || 'creator workflow';
  const safeTopic = topic.slice(0, 120);
  return {
    source: 'rule_based',
    title: `${safeTopic} — kurzer Überblick`,
    description: `Regelbasiert erzeugter Vorschlag zu ${safeTopic}. Keine KI-Analyse und keine zugesicherten Fakten.`,
    hooks: [`${safeTopic} in unter einer Minute`, `Warum ${safeTopic} gerade relevant ist`],
    hashtags: ['#ugc', '#creator', '#clips'],
    note: 'Rule-based suggestion; verify facts and rights before use.',
  };
}
