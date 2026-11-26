/**
 * Minimal tirreno sender for a remote host, no dependencies (Node 18+).
 *
 *   TIRRENO_URL=http://umbrel.tailnet-xxxx.ts.net:8585 \
 *   TIRRENO_KEY=<api key> node reporter.mjs alice 203.0.113.50 /login account_login
 *
 * For anything beyond fire-and-forget, use the official tracker instead:
 *   npm install @tirreno/tirreno-tracker
 */

const url = process.env.TIRRENO_URL;
const key = process.env.TIRRENO_KEY;

if (!url || !key) {
  console.error('set TIRRENO_URL and TIRRENO_KEY');
  process.exit(64);
}

const [userName, ipAddress, path, eventType = 'page_view', httpCode = '200'] =
  process.argv.slice(2);

if (!userName || !ipAddress || !path) {
  console.error('usage: node reporter.mjs <userName> <ipAddress> <url> [eventType] [httpCode]');
  process.exit(64);
}

/** tirreno wants UTC as `Y-m-d H:i:s.v`; unparseable values become "now". */
function eventTime(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.` +
         `${p(d.getUTCMilliseconds(), 3)}`;
}

const form = new URLSearchParams({
  userName,
  ipAddress,
  url: path,
  eventTime: eventTime(),
  eventType,
  httpCode,
});

const res = await fetch(`${url.replace(/\/+$/, '')}/sensor/`, {
  method: 'POST',
  headers: {
    'Api-Key': key,
    'Content-Type': 'application/x-www-form-urlencoded',
    // Optional: up to 36 chars, stored with the event (or the rejection).
    'X-Request-Id': crypto.randomUUID(),
  },
  body: form,
});

// 204 = accepted, 200 = rejected (bad key / missing field), 429 = rate limited.
if (res.status !== 204) {
  const reason = res.status === 429
    ? 'rate limited (default 10 req/s per API key)'
    : res.status === 200
      ? 'rejected: unknown Api-Key or missing required field'
      : `unexpected HTTP ${res.status}`;
  console.error(reason);
  process.exit(1);
}
