import { AudioReader, RingBuffer } from 'ringbuf.js';

class Processor extends AudioWorkletProcessor {
  interleaved: Float32Array;
  o: { index: number; value: number; };
  _audio_reader: AudioReader;

  static get parameterDescriptors() {
    return [];
  }

  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    this.interleaved = new Float32Array(128 * 2);
    this.o = { index: 0, value: 0 };
    const { audioQueue } = options.processorOptions;
    this._audio_reader = new AudioReader(
      new RingBuffer(audioQueue, Float32Array)
    );
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    // read 128 frames from the queue, deinterleave, and write to output
    // buffers.
    this._audio_reader.dequeue(this.interleaved);
    // console.log(this.interleaved)

    for (let i = 0; i < this.interleaved.length / 2; i++) {
      for (let channel = 0; channel < 2; channel++) {
        outputs[0][channel][i] = this.interleaved[2 * i + channel];
      }
    }
    
    // for (let i = 0; i < 128; i++) {
    //   outputs[0][0][i] = this.interleaved[i];
    // }

    return true;
  }
}

registerProcessor('processor', Processor);