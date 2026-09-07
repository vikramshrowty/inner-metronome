/**
 * Real-time transient clap detector using high-pass filtering, short-time energy,
 * dynamic noise floor adaptation, and refractory debounce.
 */

export interface ClapEvent {
  timestamp: number; // Web Audio currentTime
  energy: number;
}

export class ClapDetector {
  private ctx: AudioContext;
  private stream: MediaStream;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private muteGain: GainNode | null = null;

  private isListening = false;
  private noiseFloor = 0.008;
  private lastClapTime = 0;
  private debounceMs = 120;
  private sensitivityMultiplier = 4.5;
  private minAbsoluteThreshold = 0.025;

  private onClapCallback: ((event: ClapEvent) => void) | null = null;
  private onLevelCallback: ((level: number) => void) | null = null;

  constructor(ctx: AudioContext, stream: MediaStream) {
    this.ctx = ctx;
    this.stream = stream;
  }

  public setSensitivity(multiplier: number, minThresh = 0.02) {
    this.sensitivityMultiplier = multiplier;
    this.minAbsoluteThreshold = minThresh;
  }

  public onClap(callback: (event: ClapEvent) => void) {
    this.onClapCallback = callback;
  }

  public onLevel(callback: (level: number) => void) {
    this.onLevelCallback = callback;
  }

  public start() {
    if (this.isListening) return;

    this.micSource = this.ctx.createMediaStreamSource(this.stream);

    // High-pass filter at 1200 Hz to isolate clap snap from vocal fundamentals, AC rumble, and table thumps
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'highpass';
    this.filter.frequency.value = 1200;
    this.filter.Q.value = 1.0;

    // Buffer size 512 samples (~10.6ms at 48kHz) gives tight time resolution
    this.processor = this.ctx.createScriptProcessor(512, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (!this.isListening) return;

      const input = e.inputBuffer.getChannelData(0);
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < input.length; i++) {
        const val = input[i];
        const absVal = Math.abs(val);
        if (absVal > peak) peak = absVal;
        sumSq += val * val;
      }
      const rms = Math.sqrt(sumSq / input.length);

      if (this.onLevelCallback) {
        this.onLevelCallback(peak);
      }

      // Exponential moving average for baseline ambient noise floor
      this.noiseFloor = this.noiseFloor * 0.992 + rms * 0.008;

      const threshold = Math.max(
        this.minAbsoluteThreshold,
        this.noiseFloor * this.sensitivityMultiplier
      );

      const nowAudioTime = this.ctx.currentTime;
      const timeSinceLastClapMs = (nowAudioTime - this.lastClapTime) * 1000;

      // Check for sharp transient exceeding dynamic threshold
      if (rms > threshold && timeSinceLastClapMs > this.debounceMs) {
        this.lastClapTime = nowAudioTime;
        if (this.onClapCallback) {
          this.onClapCallback({
            timestamp: nowAudioTime,
            energy: rms,
          });
        }
      }
    };

    this.muteGain = this.ctx.createGain();
    this.muteGain.gain.value = 0;

    this.micSource.connect(this.filter);
    this.filter.connect(this.processor);
    this.processor.connect(this.muteGain);
    this.muteGain.connect(this.ctx.destination);

    this.isListening = true;
  }

  public stop() {
    this.isListening = false;
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.filter) {
      this.filter.disconnect();
      this.filter = null;
    }
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.muteGain) {
      this.muteGain.disconnect();
      this.muteGain = null;
    }
  }
}
