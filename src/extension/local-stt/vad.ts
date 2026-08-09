export function pcmRms(samples: Float32Array): number {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / Math.max(1, samples.length));
}

export function shouldFlushSpeech(durationMs: number, silenceMs: number, minimumMs = 500, endSilenceMs = 600, maximumMs = 8_000): boolean {
  return (silenceMs >= endSilenceMs && durationMs >= minimumMs) || durationMs >= maximumMs;
}

