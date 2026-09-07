class AudioRecorderProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // Transfer copy of samples to main thread
      this.port.postMessage({
        type: 'data',
        samples: input[0].slice()
      });
    }
    return true;
  }
}

registerProcessor('audio-recorder-processor', AudioRecorderProcessor);
