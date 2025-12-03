const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { runBooking } = require('./booking-core');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const app = express();
app.use(cors());
app.use(bodyParser.json());

let CONFIG = {
  token: '',
  organisationId: '48c8d621-a469-4645-17ee-08db9da35083', // default taken from original script
  federationId: '30c6ef06-0a88-4ed7-a0ba-23352869c8a1', // default taken from original script
  locationId: '205c6c05-c583-4d1f-b10d-1b3c3ff47bac', // default taken from original script
  reservationTypeId: 85,
  apiBase: 'https://api.foys.io/court-booking/members/api/v1'
};

// Load persisted config if available
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    CONFIG = { ...CONFIG, ...parsed };
    console.log('Loaded saved config from', CONFIG_PATH);
  }
} catch (e) {
  console.warn('Failed to load config.json:', e.message);
}

let job = null;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ config: CONFIG, running: !!job });
});

app.post('/api/config', (req, res) => {
  const body = req.body || {};
  CONFIG = { ...CONFIG, ...body };
  // persist config to disk (beware: contains token)
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2), { encoding: 'utf8' });
  } catch (e) {
    console.warn('Failed to write config.json:', e.message);
  }
  res.json({ ok: true, config: CONFIG });
});

app.post('/api/start', async (req, res) => {
  if (job) return res.status(400).json({ ok: false, reason: 'already-running' });
  const { date, durations, intervalSeconds = 0, windowStart, windowEnd } = req.body || {};
  const parsedDurations = Array.isArray(durations) && durations.length ? durations.map(Number) : [90];

  let lastRunResult = null;
  async function runOnce() {
    try {
      const result = await runBooking(CONFIG, { date, durations: parsedDurations, windowStart, windowEnd });
      lastRunResult = result;
      console.log('runBooking result', result);
      return result;
    } catch (err) {
      console.error('runBooking error', err);
      lastRunResult = { error: err.message };
      return lastRunResult;
    }
  }

  if (!date) {
    // default to today
  }

  // immediate run
  const runResult = await runOnce();

  if (intervalSeconds && intervalSeconds > 0) {
    job = setInterval(runOnce, intervalSeconds * 1000);
  } else {
    job = null;
  }

  res.json({ ok: true, running: !!job, lastRun: runResult });
});

// Proxy endpoint to test booking POSTs using the server CONFIG (keeps token on server)
app.post('/api/proxy-booking', async (req, res) => {
  const payload = req.body;
  if (!CONFIG.token) return res.status(400).json({ ok: false, reason: 'no-token' });
  const axios = require('axios');
  // increase timeout and implement simple retry/backoff in case upstream is slow or flaky
  const MAX_ATTEMPTS = 3;
  const TIMEOUT_MS = 120000; // 120s — increase to allow slow upstreams (may still hit Cloudflare limits)
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const instance = axios.create({
      baseURL: CONFIG.apiBase,
      headers: {
        'Authorization': `Bearer ${CONFIG.token}`,
        'Content-Type': 'application/json',
        'x-organisationid': CONFIG.organisationId,
        'x-federationid': CONFIG.federationId,
        'Origin': 'https://www.padelpowers.com',
        'Referer': `https://www.padelpowers.com/en/booking/court-booking/reservation?locationId=${CONFIG.locationId}`
      },
      timeout: TIMEOUT_MS
    });
    try {
      console.log(`proxy-booking attempt ${attempt} -> POST ${CONFIG.apiBase}/bookings`);
      const r = await instance.post('/bookings', payload);
      return res.json({ ok: true, status: r.status, data: r.data, attempts: attempt });
    } catch (err) {
      lastErr = err;
      // Log richer diagnostics to help debug 502/524 scenarios
      const code = err.code || (err.response && err.response.status) || 'UNKNOWN';
      console.warn(`proxy-booking attempt ${attempt} failed:`, { message: err.message, code, stack: err.stack ? err.stack.split('\n')[0] : undefined });
      // if this was not the last attempt, wait with exponential backoff
      if (attempt < MAX_ATTEMPTS) {
        const backoff = 300 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
    }
  }

  // All attempts failed — provide detailed diagnostics
  try {
    if (lastErr && lastErr.response) {
      return res.status(lastErr.response.status).json({ ok: false, status: lastErr.response.status, data: lastErr.response.data, attempts: MAX_ATTEMPTS });
    }
    return res.status(502).json({ ok: false, reason: 'network-error', error: lastErr ? lastErr.message : 'unknown', attempts: MAX_ATTEMPTS });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: 'network-error', error: String(e), attempts: MAX_ATTEMPTS });
  }
});

// Raw replay endpoint: useful to replay an exact browser-style request (headers + body + fullUrl)
app.post('/api/proxy-booking-raw', async (req, res) => {
  const { fullUrl, headers: headersOverride, data } = req.body || {};
  if (!fullUrl) return res.status(400).json({ ok: false, reason: 'missing-fullUrl' });
  if (!CONFIG.token) return res.status(400).json({ ok: false, reason: 'no-token' });
  const axios = require('axios');
  const https = require('https');

  // Build headers merging saved token and provided overrides
  const defaultHeaders = {
    'Authorization': `Bearer ${CONFIG.token}`,
    'Content-Type': 'application/json',
    'x-organisationid': CONFIG.organisationId,
    'x-federationid': CONFIG.federationId
  };
  const headers = Object.assign({}, defaultHeaders, headersOverride || {});

  try {
    // Use a short connection lifetime and allow larger timeouts for slow upstreams
    const agent = new https.Agent({ keepAlive: false });
    const resp = await axios.request({ url: fullUrl, method: 'post', headers, data: data || {}, timeout: 180000, httpsAgent: agent, maxContentLength: Infinity, maxBodyLength: Infinity });
    return res.json({ ok: true, status: resp.status, data: resp.data });
  } catch (err) {
    console.warn('proxy-booking-raw failed:', err && err.message ? err.message : err);
    if (err.response) return res.status(err.response.status).json({ ok: false, status: err.response.status, data: err.response.data });
    return res.status(502).json({ ok: false, reason: 'network-error', error: err.message });
  }
});

// Try several header/body variants to see if upstream accepts a different shape (useful when Cloudflare or origin expects browser headers)
app.post('/api/proxy-booking-try-variants', async (req, res) => {
  const payload = req.body.payload || req.body;
  if (!CONFIG.token) return res.status(400).json({ ok: false, reason: 'no-token' });
  const axios = require('axios');
  const https = require('https');

  const baseHeaders = {
    'Authorization': `Bearer ${CONFIG.token}`,
    'Content-Type': 'application/json',
    'x-organisationid': CONFIG.organisationId,
    'x-federationid': CONFIG.federationId
  };

  const variants = [
    Object.assign({}, baseHeaders, { 'Origin': 'https://www.padelpowers.com', 'Referer': `https://www.padelpowers.com/` }),
    Object.assign({}, baseHeaders, { 'Origin': 'https://www.padelpowers.com' }),
    Object.assign({}, baseHeaders, { 'Referer': `https://www.padelpowers.com/` }),
    Object.assign({}, baseHeaders, { 'Connection': 'close' }),
    Object.assign({}, baseHeaders, { 'Accept-Encoding': 'identity' }),
    Object.assign({}, baseHeaders) // minimal
  ];

  const results = [];
  for (const h of variants) {
    try {
      const agent = new https.Agent({ keepAlive: false });
      console.log('proxy-booking-try-variants -> trying headers', Object.keys(h));
      const r = await axios.request({ url: `${CONFIG.apiBase}/bookings`, method: 'post', headers: h, data: payload, timeout: 120000, httpsAgent: agent });
      return res.json({ ok: true, triedHeaders: Object.keys(h), status: r.status, data: r.data });
    } catch (err) {
      results.push({ headers: Object.keys(h), error: err && err.message ? err.message : String(err), code: err.code || (err.response && err.response.status) });
      // short delay between variants
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return res.status(502).json({ ok: false, reason: 'all-variants-failed', attempts: results });
});

// Proxy endpoint to test search calls using the server CONFIG
app.post('/api/proxy-search', async (req, res) => {
  const { date, duration } = req.body || {};
  if (!CONFIG.token) return res.status(400).json({ ok: false, reason: 'no-token' });
  const axios = require('axios');
  const instance = axios.create({
    baseURL: CONFIG.apiBase,
    headers: {
      'Authorization': `Bearer ${CONFIG.token}`,
      'Content-Type': 'application/json',
      'x-organisationid': CONFIG.organisationId,
      'x-federationid': CONFIG.federationId,
      'Origin': 'https://www.padelpowers.com',
      'Referer': `https://www.padelpowers.com/en/booking/court-booking/reservation?locationId=${CONFIG.locationId}`
    },
    timeout: 15000
  });

  try {
    const dur = duration || 90;
    // format date as YYYY-MM-DDT00:00:00.000Z like the original script
    const dateParam = (date && date.length === 10) ? `${date}T00:00:00.000Z` : (new Date().toISOString().slice(0,10) + 'T00:00:00.000Z');

    // Try several query variants to be robust against API expectations
    const candidates = [
      `/search?reservationTypeId=${CONFIG.reservationTypeId}&locationId=${CONFIG.locationId}&playingTimes[]=${dur}&date=${encodeURIComponent(dateParam)}`,
      `/search?reservationTypeId=${CONFIG.reservationTypeId}&locationId=${CONFIG.locationId}&playingTimes=${dur}&date=${encodeURIComponent(dateParam)}`,
      `/search?reservationTypeId=${CONFIG.reservationTypeId}&locationId=${CONFIG.locationId}&date=${encodeURIComponent(dateParam)}`,
      `/availability?reservationTypeId=${CONFIG.reservationTypeId}&locationId=${CONFIG.locationId}&playingTimes[]=${dur}&date=${encodeURIComponent(dateParam)}`,
      `/availability?reservationTypeId=${CONFIG.reservationTypeId}&locationId=${CONFIG.locationId}&playingTimes=${dur}&date=${encodeURIComponent(dateParam)}`
    ];

    let lastErr = null;
    for (const url of candidates) {
      try {
        const r = await instance.get(url);
        return res.json({ ok: true, tried: url, status: r.status, data: r.data });
      } catch (err) {
        lastErr = err;
        // continue to next candidate
      }
    }
    // if we reach here, none worked
    if (lastErr && lastErr.response) {
      return res.status(lastErr.response.status).json({ ok: false, status: lastErr.response.status, data: lastErr.response.data });
    }
    return res.status(500).json({ ok: false, reason: 'no-variants-worked', error: lastErr ? lastErr.message : 'unknown' });
  } catch (err) {
    if (err.response) {
      return res.status(err.response.status).json({ ok: false, status: err.response.status, data: err.response.data });
    }
    return res.status(500).json({ ok: false, reason: 'network-error', error: err.message });
  }
});

// Generic proxy to test arbitrary upstream requests using saved CONFIG
app.post('/api/proxy-request', async (req, res) => {
  const { method = 'GET', path: reqPath, fullUrl, params, data, headers: headersOverride } = req.body || {};
  if (!reqPath && !fullUrl) return res.status(400).json({ ok: false, reason: 'missing-path-or-fullUrl' });
  if (!CONFIG.token) return res.status(400).json({ ok: false, reason: 'no-token' });
  const axios = require('axios');

  // Build default headers from CONFIG
  const defaultHeaders = {
    'Authorization': `Bearer ${CONFIG.token}`,
    'Content-Type': 'application/json',
    'x-organisationid': CONFIG.organisationId,
    'x-federationid': CONFIG.federationId,
    'Origin': 'https://www.padelpowers.com',
    'Referer': `https://www.padelpowers.com/en/booking/court-booking/reservation?locationId=${CONFIG.locationId}`
  };

  // Merge override headers if provided (headersOverride keys take precedence)
  const mergedHeaders = Object.assign({}, defaultHeaders, headersOverride || {});

  // If fullUrl is provided, request it verbatim (useful when browser uses a different base path)
  if (fullUrl) {
    try {
      const r = await axios.request({ url: fullUrl, method: method.toLowerCase(), headers: mergedHeaders, params, data, timeout: 15000 });
      return res.json({ ok: true, tried: fullUrl, status: r.status, data: r.data });
    } catch (err) {
      if (err.response) {
        return res.status(err.response.status).json({ ok: false, status: err.response.status, data: err.response.data });
      }
      return res.status(500).json({ ok: false, reason: 'network-error', error: err.message });
    }
  }

  // Otherwise, use configured apiBase and try a few variants of the provided path
  const instance = axios.create({ baseURL: CONFIG.apiBase, headers: mergedHeaders, timeout: 15000 });

  const variants = [];
  try {
    variants.push(reqPath);
    variants.push(encodeURI(reqPath));
    variants.push(reqPath.replace(/playingTimes\[]/g, 'playingTimes'));
    variants.push(reqPath.replace(/playingTimes\[]/g, 'playingTimes%5B%5D'));
    variants.push(reqPath.replace('/search', '/availability'));
    variants.push(reqPath.replace('/search', '/availability/search'));
  } catch (e) {
    variants.push(reqPath);
  }

  let lastErr = null;
  for (const v of variants) {
    try {
      const r = await instance.request({ url: v, method: method.toLowerCase(), params, data });
      return res.json({ ok: true, tried: v, status: r.status, data: r.data });
    } catch (err) {
      lastErr = err;
    }
  }

  if (lastErr && lastErr.response) {
    return res.status(lastErr.response.status).json({ ok: false, status: lastErr.response.status, data: lastErr.response.data, tried: variants });
  }
  return res.status(500).json({ ok: false, reason: 'no-variants-worked', error: lastErr ? lastErr.message : 'unknown', tried: variants });

});

app.post('/api/stop', (req, res) => {
  if (job) {
    clearInterval(job);
    job = null;
    return res.json({ ok: true });
  }
  res.json({ ok: false, reason: 'not-running' });
});

// Proxy GET booking status by booking GUID
app.get('/api/booking-status', async (req, res) => {
  const guid = req.query.guid;
  if (!guid) return res.status(400).json({ ok: false, reason: 'missing-guid' });
  if (!CONFIG.token) return res.status(400).json({ ok: false, reason: 'no-token' });
  const axios = require('axios');
  try {
    const instance = axios.create({ baseURL: CONFIG.apiBase, headers: {
      'Authorization': `Bearer ${CONFIG.token}`,
      'Content-Type': 'application/json',
      'x-organisationid': CONFIG.organisationId,
      'x-federationid': CONFIG.federationId,
      'Origin': 'https://www.padelpowers.com',
      'Referer': `https://www.padelpowers.com/en/booking/court-booking/reservation?locationId=${CONFIG.locationId}`
    }, timeout: 15000 });
    // GET /bookings/{guid}
    const r = await instance.get(`/bookings/${encodeURIComponent(guid)}`);
    return res.json({ ok: true, status: r.status, data: r.data });
  } catch (err) {
    if (err.response) {
      return res.status(err.response.status).json({ ok: false, status: err.response.status, data: err.response.data });
    }
    return res.status(500).json({ ok: false, reason: 'network-error', error: err.message });
  }
});


// Diagnostic endpoint: DNS, TCP connect and quick HEAD/GET to apiBase
app.get('/api/diag', async (req, res) => {
  const url = require('url');
  const dns = require('dns');
  const net = require('net');
  const axios = require('axios');
  const result = { config: { apiBase: CONFIG.apiBase }, dns: null, tcp: null, http: null };
  try {
    const parsed = new URL(CONFIG.apiBase);
    const host = parsed.hostname;
    // DNS lookup
    try {
      const lookup = await new Promise((resolve, reject) => dns.lookup(host, { all: true }, (err, addrs) => err ? reject(err) : resolve(addrs)));
      result.dns = { ok: true, addresses: lookup };
    } catch (e) {
      result.dns = { ok: false, error: String(e) };
    }
    // TCP connect to port 443 (timeout 5s)
    try {
      const tcpOk = await new Promise((resolve, reject) => {
        const socket = net.connect({ host, port: 443 }, () => { socket.end(); resolve(true); });
        socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('tcp timeout')); });
        socket.on('error', (err) => reject(err));
      });
      result.tcp = { ok: !!tcpOk };
    } catch (e) {
      result.tcp = { ok: false, error: String(e) };
    }

    // quick HTTP probe (HEAD) with short timeout
    try {
      const probe = await axios.request({ method: 'HEAD', url: CONFIG.apiBase, timeout: 5000, validateStatus: () => true });
      result.http = { ok: true, status: probe.status, headers: probe.headers };
    } catch (e) {
      // include axios' error message
      result.http = { ok: false, error: String(e) };
    }
    return res.json({ ok: true, diag: result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Autobooking server listening on http://localhost:${PORT}`));
