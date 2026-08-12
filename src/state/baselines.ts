export interface BaselineResult {
  is_established: boolean;
  stats?: {
    median: number;
    iqr: number;
    p25: number;
    p75: number;
    count: number;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function calculateBaseline(
  observations: number[],
  options: { minObs: number },
): BaselineResult {
  if (observations.length < options.minObs) {
    return { is_established: false };
  }

  const sorted = [...observations].sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 1
      ? sorted[Math.floor(sorted.length / 2)]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  const p25 = percentile(sorted, 25);
  const p75 = percentile(sorted, 75);

  return {
    is_established: true,
    stats: {
      median,
      iqr: p75 - p25,
      p25,
      p75,
      count: observations.length,
    },
  };
}

export function calculateBaselinesByDow(
  observationsByDow: Map<number, number[]>,
  options: { minObs: number },
): Map<number, BaselineResult> {
  const results = new Map<number, BaselineResult>();
  for (const [dow, obs] of observationsByDow) {
    results.set(dow, calculateBaseline(obs, options));
  }
  return results;
}
