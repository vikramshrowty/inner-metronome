/**
 * Lookahead sample-accurate Metronome engine with click synthesis,
 * drop management, and clap timing evaluation.
 */

export type DropMode =
  | 'random_10'
  | 'random_25'
  | 'random_33'
  | 'beats_34_silent'    // 2-Beat Gap: Beats 1 & 2 click, beats 3 & 4 silent
  | 'beats_234_silent'   // 3-Beat Gap: Beat 1 clicks, beats 2, 3 & 4 silent
  | 'bar_alternating'    // 1 Bar Click, 1 Bar Silent (4 beats silent)
  | 'two_bars_silent'    // 2 Bars Click, 2 Bars Silent (8 beats silent)
  | 'bar4_silent'        // 3 Bars Click, 1 Bar Silent
  | 'every4th'           // Beat 4 dropped
  | 'none';

export type DistractorMode =
  | 'none'
  | 'hemiola_3_4'          // 3 pulses across 4 beats (3-over-4 cross-rhythm)
  | 'quintuplet_5_4'       // 5 pulses across 4 beats (5-over-4 polyrhythm)
  | 'triplets_3x'          // 3X Triplet subdivision (eighth-note triplets)
  | 'syncopated_16th_4x'   // 4X 16th-note syncopation ('e' and 'a' offbeats)
  | 'offbeat_eighths'      // 1/4 syncopation: the '&' of every beat
  | 'half_time_upbeat';    // 1/2 base rhythm on the offbeat (half-time upbeat)

export interface DroppedBeatRecord {
  id: number;
  scheduledTime: number; // AudioContext currentTime
  beatNumber: number;    // 1-indexed (1, 2, 3, 4)
  measureNumber: number;
  evaluated: boolean;
  clapTime?: number;
  offsetMs?: number;
  status: 'pending' | 'hit' | 'missed';
}

export interface BeatEvaluation {
  id: number;
  measureNumber: number;
  beatNumber: number;
  offsetMs: number;
  accuracy: 'perfect' | 'good' | 'early' | 'late' | 'missed';
  scheduledTime: number;
  clapTime?: number;
}

export class Metronome {
  private ctx: AudioContext;
  private bpm = 50;
  private beatsPerMeasure = 4;
  private dropMode: DropMode = 'random_10';
  private distractorMode: DistractorMode = 'none';
  private distractorVolume = 0.6; // 0.0 to 1.0

  private isRunning = false;
  private timerId: number | null = null;
  private nextNoteTime = 0;
  private currentBeat = 0;       // 0 to beatsPerMeasure - 1
  private currentMeasure = 1;
  private beatCounter = 0;

  private lookaheadMs = 25;
  private scheduleAheadSec = 0.1;

  private latencyOffsetMs = 60; // Default calibrated offset (\Delta_{out} + \Delta_{in})
  private pendingDroppedBeats: DroppedBeatRecord[] = [];
  private nextRecordId = 1;

  private onBeatCallback?: (beat: number, measure: number, isDropped: boolean) => void;
  private onEvaluationCallback?: (evaluation: BeatEvaluation) => void;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  public setBpm(bpm: number) {
    this.bpm = Math.max(40, Math.min(260, bpm));
  }

  public getBpm(): number {
    return this.bpm;
  }

  public setDropMode(mode: DropMode) {
    this.dropMode = mode;
  }

  public getDropMode(): DropMode {
    return this.dropMode;
  }

  public setDistractorMode(mode: DistractorMode) {
    this.distractorMode = mode;
  }

  public getDistractorMode(): DistractorMode {
    return this.distractorMode;
  }

  public setDistractorVolume(vol: number) {
    this.distractorVolume = Math.max(0, Math.min(1, vol));
  }

  public getDistractorVolume(): number {
    return this.distractorVolume;
  }

  public setLatencyOffsetMs(offsetMs: number) {
    this.latencyOffsetMs = offsetMs;
  }

  public getLatencyOffsetMs(): number {
    return this.latencyOffsetMs;
  }

  public onBeat(cb: (beat: number, measure: number, isDropped: boolean) => void) {
    this.onBeatCallback = cb;
  }

  public onEvaluation(cb: (evaluation: BeatEvaluation) => void) {
    this.onEvaluationCallback = cb;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.currentBeat = 0;
    this.currentMeasure = 1;
    this.beatCounter = 0;
    this.pendingDroppedBeats = [];
    this.nextNoteTime = this.ctx.currentTime + 0.05;

    this.timerId = window.setInterval(() => this.scheduler(), this.lookaheadMs);
  }

  public stop() {
    this.isRunning = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  public processClap(clapTimestamp: number) {
    if (!this.isRunning || this.pendingDroppedBeats.length === 0) return;

    const beatDurationSec = 60 / this.bpm;
    const toleranceSec = beatDurationSec * 0.45; // Match window: +/- 45% of beat interval

    // Correct detected clap timestamp by subtracting total calibrated loop latency
    const calibratedClapTime = clapTimestamp - this.latencyOffsetMs / 1000;

    // Find closest pending dropped beat
    let closestRecord: DroppedBeatRecord | null = null;
    let minDiffSec = Infinity;

    for (const record of this.pendingDroppedBeats) {
      if (record.evaluated) continue;
      const diff = calibratedClapTime - record.scheduledTime;
      if (Math.abs(diff) < toleranceSec && Math.abs(diff) < minDiffSec) {
        minDiffSec = Math.abs(diff);
        closestRecord = record;
      }
    }

    if (closestRecord) {
      closestRecord.evaluated = true;
      closestRecord.clapTime = calibratedClapTime;
      const errorMs = Math.round((calibratedClapTime - closestRecord.scheduledTime) * 1000);
      closestRecord.offsetMs = errorMs;
      closestRecord.status = 'hit';

      let accuracy: BeatEvaluation['accuracy'] = 'good';
      if (Math.abs(errorMs) <= 15) {
        accuracy = 'perfect';
      } else if (Math.abs(errorMs) <= 35) {
        accuracy = 'good';
      } else if (errorMs < -35) {
        accuracy = 'early';
      } else {
        accuracy = 'late';
      }

      if (this.onEvaluationCallback) {
        this.onEvaluationCallback({
          id: closestRecord.id,
          measureNumber: closestRecord.measureNumber,
          beatNumber: closestRecord.beatNumber,
          offsetMs: errorMs,
          accuracy,
          scheduledTime: closestRecord.scheduledTime,
          clapTime: calibratedClapTime,
        });
      }
    }
  }

  private scheduler() {
    const beatDurationSec = 60 / this.bpm;

    // Check for expired pending dropped beats (user missed the beat entirely)
    const nowTime = this.ctx.currentTime;
    for (const record of this.pendingDroppedBeats) {
      if (!record.evaluated) {
        const deadline = record.scheduledTime + beatDurationSec * 0.48;
        if (nowTime > deadline) {
          record.evaluated = true;
          record.status = 'missed';
          if (this.onEvaluationCallback) {
            this.onEvaluationCallback({
              id: record.id,
              measureNumber: record.measureNumber,
              beatNumber: record.beatNumber,
              offsetMs: 0,
              accuracy: 'missed',
              scheduledTime: record.scheduledTime,
            });
          }
        }
      }
    }
    // Clean evaluated records older than 2 seconds
    this.pendingDroppedBeats = this.pendingDroppedBeats.filter(
      (r) => !r.evaluated || nowTime - r.scheduledTime < 2.0
    );

    // Schedule forward
    while (this.nextNoteTime < this.ctx.currentTime + this.scheduleAheadSec) {
      this.scheduleNote(this.currentBeat, this.currentMeasure, this.nextNoteTime);
      this.advanceBeat();
    }
  }

  private shouldDropBeat(beat: number, measure: number, totalBeats: number): boolean {
    if (this.dropMode === 'none') return false;

    // First measure always audible to establish tempo
    if (measure === 1) return false;

    if (this.dropMode === 'beats_34_silent') {
      // 2-Beat Gap: Beats 1 & 2 audible, Beats 3 & 4 silent (clap beats 3 and 4)
      return beat >= 2;
    }

    if (this.dropMode === 'beats_234_silent') {
      // 3-Beat Gap: Beat 1 audible, Beats 2, 3 & 4 silent (clap beats 2, 3, and 4)
      return beat >= 1;
    }

    if (this.dropMode === 'bar_alternating') {
      // 1 Bar Click, 1 Bar Silent (Odd measures click, Even measures silent)
      return measure % 2 === 0;
    }

    if (this.dropMode === 'two_bars_silent') {
      // 2 Bars Click, 2 Bars Silent (bars 1-2 click, 3-4 silent, 5-6 click, 7-8 silent)
      const mInCycle = ((measure - 1) % 4) + 1;
      return mInCycle >= 3;
    }

    if (this.dropMode === 'bar4_silent') {
      // Bar 4 (measure 4, 8, 12, etc.) is completely silent
      return measure % 4 === 0;
    }

    if (this.dropMode === 'every4th') {
      return totalBeats % 4 === 0;
    }

    if (this.dropMode === 'random_10') {
      return Math.random() < 0.10;
    }

    if (this.dropMode === 'random_33') {
      return Math.random() < 0.33;
    }

    // Default random_25:
    return Math.random() < 0.25;
  }

  private scheduleNote(beat: number, measure: number, time: number) {
    const isDropped = this.shouldDropBeat(beat, measure, this.beatCounter);

    if (isDropped) {
      // Record dropped beat for clap evaluation
      const record: DroppedBeatRecord = {
        id: this.nextRecordId++,
        scheduledTime: time,
        beatNumber: beat + 1,
        measureNumber: measure,
        evaluated: false,
        status: 'pending',
      };
      this.pendingDroppedBeats.push(record);
    } else {
      // Synthesize clean metronome click
      const isAccent = beat === 0;
      this.playClick(time, isAccent);
    }

    // Schedule secondary distractor / counter-rhythm sound (always plays regardless of primary drop)
    this.scheduleDistractor(beat, measure, time);

    // Schedule UI notification timed with the audio clock
    const delayMs = Math.max(0, (time - this.ctx.currentTime) * 1000);
    setTimeout(() => {
      if (this.isRunning && this.onBeatCallback) {
        this.onBeatCallback(beat + 1, measure, isDropped);
      }
    }, delayMs);
  }

  private scheduleDistractor(beat: number, _measure: number, time: number) {
    if (this.distractorMode === 'none' || this.distractorVolume <= 0) return;

    const beatSec = 60.0 / this.bpm;
    const measureSec = this.beatsPerMeasure * beatSec;

    // 1. Measure-wide metric polyrhythms (scheduled on the downbeat of the bar)
    if (beat === 0) {
      if (this.distractorMode === 'hemiola_3_4') {
        // 3 evenly spaced pulses across the 4-beat bar (3 over 4 cross-rhythm)
        const pulseInterval = measureSec / 3;
        for (let k = 0; k < 3; k++) {
          const pulseTime = time + k * pulseInterval;
          this.playDistractorClick(pulseTime, k === 0);
        }
      } else if (this.distractorMode === 'quintuplet_5_4') {
        // 5 evenly spaced pulses across the 4-beat bar (5 over 4 polyrhythm)
        const pulseInterval = measureSec / 5;
        for (let k = 0; k < 5; k++) {
          const pulseTime = time + k * pulseInterval;
          this.playDistractorClick(pulseTime, k === 0);
        }
      } else if (this.distractorMode === 'half_time_upbeat') {
        // 1/2 base rhythm on the offbeat (half-note pulse shifted by half beat: sounds at beats 1.5 and 3.5)
        this.playDistractorClick(time + 1.5 * beatSec, false);
        this.playDistractorClick(time + 3.5 * beatSec, false);
      }
    }

    // 2. Per-beat metric subdivisions (scheduled for each beat)
    if (this.distractorMode === 'triplets_3x') {
      // 3X Triplet subdivision: 3 pulses per beat.
      // Distractor sounds on the offbeat triplet partials (1/3 and 2/3 of beat)
      const tripletInterval = beatSec / 3;
      this.playDistractorClick(time + tripletInterval, false);
      this.playDistractorClick(time + 2 * tripletInterval, false);
    } else if (this.distractorMode === 'syncopated_16th_4x') {
      // 4X 16th-note syncopation: sounds on the offbeat 16ths ('e' and 'a')
      const sixteenth = beatSec / 4;
      this.playDistractorClick(time + sixteenth, false);
      this.playDistractorClick(time + 3 * sixteenth, false);
    } else if (this.distractorMode === 'offbeat_eighths') {
      // 1/4 or upbeat syncopation: sounds on the eighth-note '&' (halfway through beat)
      this.playDistractorClick(time + beatSec / 2, false);
    }
  }

  private playDistractorClick(time: number, isAccent: boolean) {
    if (this.distractorVolume <= 0) return;

    // Distinct timbre: Warm, rounded low-frequency woodblock / clave (520Hz down to 260Hz)
    // Auditory stream segregation: distinctly lower pitch than primary click.
    // Acoustic isolation: strictly below the 1200Hz mic high-pass filter, preventing false triggers.
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    const startFreq = isAccent ? 640 : 500;
    const endFreq = isAccent ? 320 : 250;
    const duration = 0.026;

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(endFreq, time + duration);

    const baseGain = isAccent ? 0.60 : 0.45;
    const targetGain = baseGain * this.distractorVolume;
    gain.gain.setValueAtTime(targetGain, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(time);
    osc.stop(time + duration);
  }

  private advanceBeat() {
    const secondsPerBeat = 60.0 / this.bpm;
    this.nextNoteTime += secondsPerBeat;
    this.beatCounter++;
    this.currentBeat++;
    if (this.currentBeat >= this.beatsPerMeasure) {
      this.currentBeat = 0;
      this.currentMeasure++;
    }
  }

  private playClick(time: number, isAccent: boolean) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    const startFreq = isAccent ? 2400 : 1600;
    const endFreq = isAccent ? 1200 : 800;
    const duration = isAccent ? 0.022 : 0.018;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(endFreq, time + duration);

    gain.gain.setValueAtTime(0.85, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(time);
    osc.stop(time + duration);
  }
}
