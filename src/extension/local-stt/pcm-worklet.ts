declare const sampleRate: number;

interface WorkletPort { postMessage(message: unknown, transfer?: Transferable[]): void }
declare class AudioWorkletProcessor { readonly port: WorkletPort }
declare function registerProcessor(name: string, processorCtor: typeof AudioWorkletProcessor): void;

const TARGET_RATE = 16_000;
const FRAME_SAMPLES = 1_600; // 100 ms

class PxhPcmProcessor extends AudioWorkletProcessor {
  private readonly ratio = sampleRate / TARGET_RATE;
  private sourcePosition = 0;
  private pending: number[] = [];

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    while (this.sourcePosition < input.length) {
      const index = Math.min(input.length - 1, Math.floor(this.sourcePosition));
      this.pending.push(input[index] ?? 0);
      this.sourcePosition += this.ratio;
    }
    this.sourcePosition -= input.length;
    while (this.pending.length >= FRAME_SAMPLES) {
      const frame = new Float32Array(this.pending.splice(0, FRAME_SAMPLES));
      this.port.postMessage({ type: "pcm", samples: frame }, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor("pxh-pcm-processor", PxhPcmProcessor);

