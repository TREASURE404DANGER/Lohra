import fs from 'node:fs';
import path from 'node:path';

// Healthy = heartbeat is fresh and the link is not stuck. Exit 0 healthy, 1 unhealthy.
try {
  const h = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR || './data', 'health.json'), 'utf8'));
  const now = Date.now();
  if (now - h.at > 60_000) throw new Error('stale heartbeat');
  if (h.state === 'awaiting-manual') throw new Error('pairing needs manual action');
  if (!['open', 'awaiting-pairing'].includes(h.state) && now - h.since > 15 * 60_000) throw new Error(`stuck in ${h.state}`);
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
