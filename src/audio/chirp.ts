/**
 * Chirp synthesis and matched-filter cross-correlation for loopback latency measurement.
 */

export interface CalibrationResult {
  latencyMs: number;
  confidence: 'high' | 'medium' | 'low';
  trials: number[];
  snr: number;
}

export function generateChirp(
  sampleRate: number,
  duration = 0.04, // 40ms
  f0 = 1000,       // 1000 Hz
  f1 = 4500        // 4500 Hz
): Float32Array {
  const N = Math.floor(sampleRate * duration);
  const chirp = new Float32Array(N);
  const k = Math.log(f1 / f0) / duration;

  for (let i = 0; i < N; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * f0 * ((Math.exp(k * t) - 1) / k);
    // Hann window to prevent spectral splatter / click transients
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
    chirp[i] = Math.sin(phase) * win;
  }
  return chirp;
}

export function computeCrossCorrelationPeak(
  recorded: Float32Array,
  chirp: Float32Array,
  searchSamples: number
): { delaySamples: number; snr: number; maxVal: number } {
  const N = chirp.length;
  let maxCorr = -Infinity;
  let bestDelay = 0;
  let sumCorr = 0;
  let count = 0;

  // Step by 2 in inner loop for speed while retaining sample resolution in candidate window
  for (let d = 0; d < searchSamples && d + N <= recorded.length; d++) {
    let sum = 0;
    for (let j = 0; j < N; j += 2) {
      sum += recorded[d + j] * chirp[j];
    }
    const absSum = Math.abs(sum);
    if (absSum > maxCorr) {
      maxCorr = absSum;
      bestDelay = d;
    }
    sumCorr += absSum;
    count++;
  }

  // Refine locally (+/- 3 samples) with single-sample step for maximum precision
  const refineStart = Math.max(0, bestDelay - 3);
  const refineEnd = Math.min(searchSamples, bestDelay + 4);
  for (let d = refineStart; d < refineEnd && d + N <= recorded.length; d++) {
    let sum = 0;
    for (let j = 0; j < N; j++) {
      sum += recorded[d + j] * chirp[j];
    }
    const absSum = Math.abs(sum);
    if (absSum > maxCorr) {
      maxCorr = absSum;
      bestDelay = d;
    }
  }

  const avgCorr = count > 0 ? sumCorr / count : 1e-6;
  const snr = maxCorr / (avgCorr + 1e-6);

  return { delaySamples: bestDelay, snr, maxVal: maxCorr };
}

export class AcousticCalibrator {
  private ctx: AudioContext;
  private stream: MediaStream;
  private chirpTemplate: Float32Array;
  private chirpBuffer: AudioBuffer;

  constructor(ctx: AudioContext, stream: MediaStream) {
    this.ctx = ctx;
    this.stream = stream;
    this.chirpTemplate = generateChirp(ctx.sampleRate, 0.04, 1000, 4500);
    this.chirpBuffer = ctx.createBuffer(1, this.chirpTemplate.length, ctx.sampleRate);
    const chan = this.chirpBuffer.getChannelData(0);
    chan.set(this.chirpTemplate);
  }

  /**
   * Runs N trials, emits a chirp in each, records mic response, and computes median loopback latency.
   */
  async calibrate(
    numTrials = 3,
    onProgress?: (trial: number, total: number) => void
  ): Promise<CalibrationResult> {
    const trials: number[] = [];
    const snrs: number[] = [];

    for (let i = 0; i < numTrials; i++) {
      if (onProgress) {
        onProgress(i + 1, numTrials);
      }
      const trialResult = await this.runSingleTrial();
      trials.push(trialResult.latencyMs);
      snrs.push(trialResult.snr);
      // Brief pause between trials for acoustic decay
      await new Promise((res) => setTimeout(res, 250));
    }

    // Sort to obtain median
    const sorted = [...trials].sort((a, b) => a - b);
    const medianLatency = sorted[Math.floor(sorted.length / 2)];
    const avgSnr = snrs.reduce((a, b) => a + b, 0) / snrs.length;

    // Check consistency between trials
    const maxDiff = Math.max(...trials) - Math.min(...trials);
    let confidence: 'high' | 'medium' | 'low' = 'high';
    if (avgSnr < 2.5 || maxDiff > 35) {
      confidence = 'low';
    } else if (maxDiff > 18 || avgSnr < 4.0) {
      confidence = 'medium';
    }

    return {
      latencyMs: Math.round(medianLatency),
      confidence,
      trials: trials.map((t) => Math.round(t)),
      snr: parseFloat(avgSnr.toFixed(2)),
    };
  }

  private async runSingleTrial(): Promise<{ latencyMs: number; snr: number }> {
    const sampleRate = this.ctx.sampleRate;
    const recordDurationSec = 0.55;
    const totalSamples = Math.floor(sampleRate * recordDurationSec);
    const recordedBuffer = new Float32Array(totalSamples);
    let samplesRecorded = 0;

    const micSource = this.ctx.createMediaStreamSource(this.stream);
    
    // Use ScriptProcessor as simple guaranteed recorder for calibration window
    const processor = this.ctx.createScriptProcessor(2048, 1, 1);
    
    const recordingPromise = new Promise<{ latencyMs: number; snr: number }>((resolve) => {
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const remaining = totalSamples - samplesRecorded;
        if (remaining > 0) {
          const toCopy = Math.min(remaining, inputData.length);
          recordedBuffer.set(inputData.subarray(0, toCopy), samplesRecorded);
          samplesRecorded += toCopy;
        }

        if (samplesRecorded >= totalSamples) {
          processor.disconnect();
          micSource.disconnect();

          // Search candidate delay up to 400ms
          const searchSamples = Math.floor(sampleRate * 0.4);
          const { delaySamples, snr } = computeCrossCorrelationPeak(
            recordedBuffer,
            this.chirpTemplate,
            searchSamples
          );

          const latencyMs = (delaySamples / sampleRate) * 1000;
          resolve({ latencyMs, snr });
        }
      };
    });

    micSource.connect(processor);
    // Connect processor to destination with 0 gain to prevent feedback whistle while keeping processing active
    const muteGain = this.ctx.createGain();
    muteGain.gain.value = 0;
    processor.connect(muteGain);
    muteGain.connect(this.ctx.destination);

    // Play chirp through main speakers
    const chirpSource = this.ctx.createBufferSource();
    chirpSource.buffer = this.chirpBuffer;
    
    const chirpGain = this.ctx.createGain();
    chirpGain.gain.value = 0.8;
    chirpSource.connect(chirpGain);
    chirpGain.connect(this.ctx.destination);

    // Small delay to let mic buffer start collecting
    await new Promise((r) => setTimeout(r, 40));
    chirpSource.start();

    return recordingPromise;
  }
}
