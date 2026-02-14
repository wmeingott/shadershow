// =============================================================================
// Beat Detector
// Energy-based beat detection from audio FFT data
// Analyzes low-frequency bands to estimate BPM
// =============================================================================

class BeatDetector {
  constructor() {
    // Energy history for dynamic threshold (rolling window ~0.7s at 60fps)
    this.energyHistory = [];
    this.energyHistorySize = 43;

    // Beat timestamps circular buffer (last 30 beats)
    this.beatTimes = [];
    this.maxBeats = 30;

    // Threshold multiplier (mean + k * stddev)
    this.thresholdK = 1.4;

    // Minimum time between beats (300ms = 200 BPM max)
    this.minBeatInterval = 300;

    // BPM state
    this.currentBPM = 120;
    this.smoothedBPM = 120;
    this.smoothingAlpha = 0.15; // EMA smoothing factor

    // Clamp range
    this.minBPM = 60;
    this.maxBPM = 200;
  }

  update(frequencyData) {
    // Compute energy of low-frequency bands (bins 0-10, ~0-430 Hz)
    let energy = 0;
    const lowBins = Math.min(11, frequencyData.length);
    for (let i = 0; i < lowBins; i++) {
      energy += frequencyData[i] * frequencyData[i];
    }
    energy = Math.sqrt(energy / lowBins);

    // Add to energy history
    this.energyHistory.push(energy);
    if (this.energyHistory.length > this.energyHistorySize) {
      this.energyHistory.shift();
    }

    // Need enough history for meaningful threshold
    if (this.energyHistory.length < 10) return;

    // Compute mean and stddev of energy history
    let sum = 0;
    for (let i = 0; i < this.energyHistory.length; i++) {
      sum += this.energyHistory[i];
    }
    const mean = sum / this.energyHistory.length;

    let variance = 0;
    for (let i = 0; i < this.energyHistory.length; i++) {
      const diff = this.energyHistory[i] - mean;
      variance += diff * diff;
    }
    const stddev = Math.sqrt(variance / this.energyHistory.length);

    // Dynamic threshold
    const threshold = mean + this.thresholdK * stddev;

    // Detect beat: current energy exceeds threshold
    const now = performance.now();
    if (energy > threshold && energy > 10) {
      // Enforce minimum interval between beats
      const lastBeatTime = this.beatTimes.length > 0 ? this.beatTimes[this.beatTimes.length - 1] : 0;
      if (now - lastBeatTime > this.minBeatInterval) {
        this.beatTimes.push(now);
        if (this.beatTimes.length > this.maxBeats) {
          this.beatTimes.shift();
        }

        // Estimate BPM from inter-beat intervals
        this.estimateBPM();
      }
    }
  }

  estimateBPM() {
    if (this.beatTimes.length < 3) return;

    // Compute inter-beat intervals
    const intervals = [];
    for (let i = 1; i < this.beatTimes.length; i++) {
      intervals.push(this.beatTimes[i] - this.beatTimes[i - 1]);
    }

    // Use median interval for robustness
    intervals.sort((a, b) => a - b);
    const medianInterval = intervals[Math.floor(intervals.length / 2)];

    if (medianInterval > 0) {
      const rawBPM = 60000 / medianInterval;

      // Clamp to reasonable range
      const clampedBPM = Math.max(this.minBPM, Math.min(this.maxBPM, rawBPM));

      // Exponential moving average smoothing
      this.smoothedBPM = this.smoothingAlpha * clampedBPM + (1 - this.smoothingAlpha) * this.smoothedBPM;
      this.currentBPM = this.smoothedBPM;
    }
  }

  getBPM() {
    return this.currentBPM;
  }

  reset() {
    this.energyHistory = [];
    this.beatTimes = [];
    this.currentBPM = 120;
    this.smoothedBPM = 120;
  }
}
