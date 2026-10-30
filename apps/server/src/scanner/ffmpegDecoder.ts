import { spawn } from 'node:child_process';
import type { DecodedAudio } from '@bpmix/core';

const SAMPLE_RATE = 44100;
const CHANNELS = 2;

/**
 * Decodes any ffmpeg-readable file to 44.1kHz stereo float PCM - the same
 * shape the clients' own decoders hand to core's analysis code, so the
 * loudness numbers stay comparable. Memory is the decoded size (~85MB for a
 * 5-minute track), which is why analysis runs in a worker, one track at a time.
 */
export function decodeWithFfmpeg(absolutePath: string, signal?: AbortSignal): Promise<DecodedAudio> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      'ffmpeg',
      ['-v', 'error', '-nostdin', '-i', absolutePath, '-vn', '-f', 'f32le', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'pipe'], signal },
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`));
        return;
      }
      const bytes = Buffer.concat(chunks);
      const frames = Math.floor(bytes.byteLength / (4 * CHANNELS));
      if (frames === 0) {
        reject(new Error('ffmpeg decoded no audio'));
        return;
      }
      const interleaved = new Float32Array(bytes.buffer, bytes.byteOffset, frames * CHANNELS);
      const channelData = Array.from({ length: CHANNELS }, (_, c) => {
        const channel = new Float32Array(frames);
        for (let i = 0; i < frames; i++) channel[i] = interleaved[i * CHANNELS + c]!;
        return channel;
      });
      resolve({ sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS, channelData, durationSeconds: frames / SAMPLE_RATE });
    });
  });
}
