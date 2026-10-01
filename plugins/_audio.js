// Audio helpers for long voice notes. Not a plugin (leading underscore).
// A Gemini Live connection lives about 10 minutes, so a long note is cut into pieces of ~5 minutes, each sent on its own connection.
// Cuts are made in the quietest half second near each target, so words are not split. The wav is read piece by piece, never whole:
// the container has 512 MB of RAM and a one-hour note is ~115 MB of PCM.
export const PCM_BYTES_PER_SEC = 32000;            // 16 kHz, 16-bit, mono
const FRAME_SEC = 0.1;
const FRAME_BYTES = PCM_BYTES_PER_SEC * FRAME_SEC;  // 3200

/** Where the PCM starts in a wav file, from its header bytes (ffmpeg may put a LIST chunk before "data"). */
export function wavLayout(head, fileSize) {
  if (!head || head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a wav file');
  let off = 12;
  while (off + 8 <= head.length) {
    const id = head.toString('ascii', off, off + 4);
    const size = head.readUInt32LE(off + 4);
    if (id === 'data') {
      const dataOffset = off + 8;
      const room = Math.max(0, fileSize - dataOffset);
      const bytes = size === 0xffffffff || size > room ? room : size;   // streamed/truncated files: trust the real file size
      return { dataOffset, dataBytes: bytes - (bytes % 2) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('wav has no data chunk in its header');
}

/** Wrap raw 16 kHz mono PCM in a wav header. */
export function pcmToWav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(PCM_BYTES_PER_SEC, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Loudness (RMS) of every 100 ms frame. Every 4th sample is plenty to find pauses. */
export function frameEnergies(pcm) {
  const n = Math.floor(pcm.length / FRAME_BYTES);
  const out = new Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    let c = 0;
    const base = f * FRAME_BYTES;
    for (let i = base; i + 1 < base + FRAME_BYTES; i += 8) { const v = pcm.readInt16LE(i); sum += v * v; c++; }
    out[f] = Math.sqrt(sum / c);
  }
  return out;
}

/** Loudness of a whole wav data section, read 30 s at a time. */
export async function scanEnergy(fh, dataOffset, dataBytes) {
  const step = 300 * FRAME_BYTES;
  const buf = Buffer.alloc(step);
  const out = [];
  for (let pos = 0; pos < dataBytes; pos += step) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(step, dataBytes - pos), dataOffset + pos);
    if (!bytesRead) break;
    for (const e of frameEnergies(buf.subarray(0, bytesRead))) out.push(e);
  }
  return out;
}

/** Pieces for a long note: [{ start, end }] in seconds. Each cut sits in the quietest half second within `searchSec` of the target. */
export function planSegments(energy, totalSec, { targetSec = 300, searchSec = 20 } = {}) {
  const segs = [];
  const win = Math.round(0.5 / FRAME_SEC);
  let cursor = 0;
  while (totalSec - cursor > targetSec + searchSec) {
    const lo = Math.max(Math.round((cursor + targetSec - searchSec) / FRAME_SEC), Math.round(cursor / FRAME_SEC) + win);
    const hi = Math.min(Math.round((cursor + targetSec + searchSec) / FRAME_SEC), energy.length - win);
    let best = -1;
    let bestE = Infinity;
    for (let f = lo; f <= hi; f++) {
      let e = 0;
      for (let k = 0; k < win; k++) e += energy[f + k];
      if (e < bestE) { bestE = e; best = f; }
    }
    const cut = best < 0 ? cursor + targetSec : (best + win / 2) * FRAME_SEC;
    segs.push({ start: cursor, end: cut });
    cursor = cut;
  }
  segs.push({ start: cursor, end: totalSec });
  return segs;
}

/** Read seconds [startSec, endSec) of the PCM from an open wav file. */
export async function readPcmRange(fh, dataOffset, dataBytes, startSec, endSec) {
  const a = Math.min(dataBytes, Math.floor((startSec * PCM_BYTES_PER_SEC) / 2) * 2);
  const b = Math.min(dataBytes, Math.floor((endSec * PCM_BYTES_PER_SEC) / 2) * 2);
  const buf = Buffer.alloc(Math.max(0, b - a));
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await fh.read(buf, got, buf.length - got, dataOffset + a + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}
