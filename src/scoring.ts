export interface ScoreInput {
  demand: number;      // 0-100
  competition: number; // 0-100 (higher = more competition, lowers score)
  relevance: number;   // 0-100
  effort: number;      // 0-100 (higher = more effort, lowers score)
  dataQuality: number; // 0-100
}

export function contentOpportunityScore(input: ScoreInput): { score: number; parts: Record<string, number>; explanation: string } {
  const parts = {
    demand: input.demand,
    competition: 100 - input.competition,
    relevance: input.relevance,
    effort: 100 - input.effort,
    dataQuality: input.dataQuality,
  };
  const weights = { demand: 0.3, competition: 0.2, relevance: 0.2, effort: 0.15, dataQuality: 0.15 };
  let score = 0;
  for (const k of Object.keys(weights) as (keyof typeof weights)[]) {
    score += parts[k] * weights[k];
  }
  score = Math.round(score);
  const missing = Object.entries(input).filter(([, v]) => v === 0).map(([k]) => k);
  const explanation = missing.length
    ? `Score ${score}/100. Missing/zero inputs: ${missing.join(', ')}; score may be understated.`
    : `Score ${score}/100 based on demand, competition, relevance, effort, data quality.`;
  return { score, parts, explanation };
}
