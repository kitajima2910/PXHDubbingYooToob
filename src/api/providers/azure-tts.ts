import * as sdk from "microsoft-cognitiveservices-speech-sdk";

export interface TtsProvider { synthesize(text: string, voice: string, rate: number, signal: AbortSignal): Promise<Buffer> }

export class AzureTtsProvider implements TtsProvider {
  async synthesize(text: string, voice: string, rate: number, signal: AbortSignal): Promise<Buffer> {
    const key = process.env.AZURE_SPEECH_KEY?.trim();
    const region = process.env.AZURE_SPEECH_REGION?.trim();
    if (!key || !region) throw new Error("Backend chưa cấu hình AZURE_SPEECH_KEY và AZURE_SPEECH_REGION");

    const config = sdk.SpeechConfig.fromSubscription(key, region);
    config.speechSynthesisVoiceName = voice;
    // Convert rate (0.85–1.3) to SSML prosody rate string (e.g. "0.85" → "-15%", "1.3" → "+30%")
    const ratePercent = `${Math.round((rate - 1) * 100)}%`;
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="vi-VN"><voice name="${voice}"><prosody rate="${ratePercent}">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")}</prosody></voice></speak>`;

    const synthesizer = new sdk.SpeechSynthesizer(config);
    signal.addEventListener("abort", () => synthesizer.close(), { once: true });

    try {
      const result = await new Promise<sdk.SpeechSynthesisResult>((resolve, reject) => {
        synthesizer.speakSsmlAsync(ssml,
          (r) => resolve(r),
          (err) => reject(new Error(`Azure TTS: ${err}`)),
        );
      });
      if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
        return Buffer.from(result.audioData);
      }
      const detail = result.reason === sdk.ResultReason.Canceled
        ? sdk.CancellationDetails.fromResult(result).errorDetails
        : `Unexpected result reason: ${result.reason}`;
      throw new Error(`Azure TTS: ${detail || "không tạo được audio"}`);
    } finally {
      synthesizer.close();
    }
  }
}

// Giữ EdgeTtsProvider làm fallback khi Azure không khả dụng
export { EdgeTtsProvider } from "./tts-edge.js";
