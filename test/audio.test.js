import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const a = await import(fileURLToPath(new URL('../plugins/_audio.js', import.meta.url)));

const chunk = (id, size) => { const b = Buffer.alloc(8); b.write(id, 0, 'ascii'); b.writeUInt32LE(size, 4); return b; };
const SR = 32000;
/** PCM: `sec` seconds of a loud square-ish wave, with optional quiet gaps [[fromSec, toSec], ...]. */
function pcmWithGaps(sec, gaps = []) {
  const buf = Buffer.alloc(sec * SR);
  for (let i = 0; i < buf.length; i += 2) {
    const t = i / SR;
    buf.writeInt16LE(gaps.some(([x, y]) => t >= x && t < y) ? 0 : (i % 4 ? 9000 : -9000), i);
  }
  return buf;
}

test('wavLayout: plain header, LIST chunk before data, streamed (0xffffffff) and truncated files', () => {
  const pcm = Buffer.alloc(1000);
  const plain = a.pcmToWav(pcm);
  assert.deepEqual(a.wavLayout(plain.subarray(0, 4096), plain.length), { dataOffset: 44, dataBytes: 1000 });

  const riff = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'ascii')]);
  const fmt = Buffer.concat([chunk('fmt ', 16), Buffer.alloc(16)]);
  const list = Buffer.concat([chunk('LIST', 34), Buffer.alloc(34)]);
  const withList = Buffer.concat([riff, fmt, list, chunk('data', 1000), pcm]);
  assert.deepEqual(a.wavLayout(withList, withList.length), { dataOffset: 12 + 24 + 42 + 8, dataBytes: 1000 });

  const streamed = Buffer.concat([riff, fmt, chunk('data', 0xffffffff), pcm]);
  assert.equal(a.wavLayout(streamed, streamed.length).dataBytes, 1000);
  const truncated = Buffer.concat([riff, fmt, chunk('data', 5000), pcm]);       // header promises more than the file holds
  assert.equal(a.wavLayout(truncated, truncated.length).dataBytes, 1000);
  assert.throws(() => a.wavLayout(Buffer.from('not a wav file at all'), 20), /not a wav/);
  assert.throws(() => a.wavLayout(Buffer.concat([riff, fmt]), 100), /no data chunk/);
});

test('pcmToWav: is a valid 16 kHz mono 16-bit wav', () => {
  const w = a.pcmToWav(Buffer.alloc(64000));
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt16LE(22), 1);
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.readUInt32LE(40), 64000);
  assert.equal(w.length, 64044);
});

test('frameEnergies: loud frames are loud, silent frames are zero, 10 frames per second', () => {
  const e = a.frameEnergies(pcmWithGaps(3, [[1, 2]]));
  assert.equal(e.length, 30);
  assert.ok(e[5] > 5000 && e[25] > 5000);
  assert.equal(e[15], 0);
});

test('planSegments: a short note is one piece', () => {
  assert.deepEqual(a.planSegments([], 120), [{ start: 0, end: 120 }]);
  assert.deepEqual(a.planSegments([], 319, { targetSec: 300, searchSec: 20 }), [{ start: 0, end: 319 }]);
});

test('planSegments: cuts land in the pauses, pieces are contiguous, cover everything, and stay short', () => {
  // 1000 s of talking with pauses at 297-298 s, 601-602 s and a decoy pause far from any target at 150 s
  const gaps = [[297, 298], [601, 602], [150, 151]];
  const energy = a.frameEnergies(pcmWithGaps(1000, gaps));
  const segs = a.planSegments(energy, 1000, { targetSec: 300, searchSec: 20 });
  assert.equal(segs.length, 4);
  assert.equal(segs[0].start, 0);
  assert.equal(segs.at(-1).end, 1000);
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].start, segs[i - 1].end);   // nothing lost, nothing repeated
  assert.ok(segs[0].end > 297 && segs[0].end < 298);       // cut inside the first pause
  assert.ok(segs[1].end > 601 && segs[1].end < 602);       // and the second
  assert.ok(segs.every((s) => s.end - s.start <= 320.5));  // never longer than target + search
});

test('planSegments: with no pause at all it still cuts, close to the target', () => {
  const energy = a.frameEnergies(pcmWithGaps(700));
  const segs = a.planSegments(energy, 700, { targetSec: 300, searchSec: 20 });
  assert.ok(segs.length >= 2 && segs.every((s) => s.end - s.start <= 321));
  assert.equal(segs.at(-1).end, 700);
});

test('scanEnergy + readPcmRange read a wav file piece by piece', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aud-'));
  const pcm = pcmWithGaps(65, [[31, 32]]);
  const file = path.join(dir, 'x.wav');
  await fs.writeFile(file, a.pcmToWav(pcm));
  const fh = await fs.open(file, 'r');
  try {
    const { dataOffset, dataBytes } = a.wavLayout(Buffer.from(await fs.readFile(file)).subarray(0, 4096), (await fh.stat()).size);
    assert.equal(dataBytes, pcm.length);
    const e = await a.scanEnergy(fh, dataOffset, dataBytes);      // 65 s > 30 s read size: crosses read boundaries
    assert.equal(e.length, 650);
    assert.equal(e[315], 0);
    assert.ok(e[100] > 5000 && e[600] > 5000);
    const piece = await a.readPcmRange(fh, dataOffset, dataBytes, 10, 12);
    assert.equal(piece.length, 2 * SR);
    assert.ok(piece.equals(pcm.subarray(10 * SR, 12 * SR)));
    const tail = await a.readPcmRange(fh, dataOffset, dataBytes, 60, 999);   // past the end: clipped, not an error
    assert.equal(tail.length, 5 * SR);
  } finally { await fh.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
