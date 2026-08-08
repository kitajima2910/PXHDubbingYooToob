import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export interface TtsProvider { synthesize(text: string, voice: string, rate: number, signal: AbortSignal): Promise<Buffer> }

export class EdgeTtsProvider implements TtsProvider {
  async synthesize(text: string, voice: string, rate: number, signal: AbortSignal): Promise<Buffer> {
    const tts = new MsEdgeTTS();
    signal.addEventListener("abort", () => tts.close(), { once: true });
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, { rate: `${Math.round((rate - 1) * 100)}%` });
    const chunks: Buffer[] = [];
    try { for await (const chunk of audioStream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
    finally { tts.close(); }
  }
}
