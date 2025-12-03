async function api(path, method = 'GET', body) {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    // If the response was valid JSON and is an object, return it directly for compatibility
    if (parsed !== null && typeof parsed === 'object') {
      // attach meta fields for callers who need them
      parsed.__meta = { ok: res.ok, status: res.status, raw: text };
      return parsed;
    }
    // otherwise return a small wrapper with raw text
    return { __raw: text || null, ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: err.message };
  }
}

function log(msg) {
  const el = document.getElementById('logs');
  el.textContent = `${new Date().toLocaleTimeString()} - ${msg}\n` + el.textContent;
}

// last available slots from last Test search
window.lastAvailableSlots = [];

function sleep(ms) { return new Promise(r=>setTimeout(r, ms)); }

async function bookSlot(inv, start, duration) {
  if (!inv) return { ok:false, error: 'missing-inventory' };
  if (!start) return { ok:false, error: 'missing-start' };
  const dt = new Date(start);
  const endDt = new Date(dt.getTime() + (Number(duration)||60)*60000);
  function fmtLocal(d) { const z=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; }
  const payload = { reservationTypeId: Number(document.getElementById('reservationTypeId').value)||85, startDateTime: fmtLocal(dt), endDateTime: fmtLocal(endDt), reservations: [{ inventoryItemId: Number(inv) }] };
  log('Auto-booking slot: ' + payload.startDateTime + ' inv:' + inv + ' dur:' + duration);
  try {
    const r = await api('/api/proxy-booking', 'POST', payload);
    renderLastResult(r);
    if (r && r.ok && r.data) {
      const guid = (r.data && (r.data.guid || (r.data.reservations && r.data.reservations[0] && r.data.reservations[0].guid)));
      const bookingUrl = guid ? `https://www.padelpowers.com/en/booking/court-booking/booking/${guid}/` : null;
      renderBookingArea({ bookingUrl, timeOutAt: (r.data && r.data.timeOutAt) });
      log('Auto-book response: ' + (r.ok? 'ok' : 'failed'));
    } else {
      log('Auto-book failed: ' + (r && r.status));
    }
    return r;
  } catch (err) {
    log('Auto-book error: '+err.message);
    return { ok:false, error: err.message };
  }
}

async function loadConfig() {
  const r = await api('/api/config');
  if (r && r.config) {
    document.getElementById('token').value = r.config.token || '';
    document.getElementById('organisationId').value = r.config.organisationId || '';
    document.getElementById('federationId').value = r.config.federationId || '';
    document.getElementById('locationId').value = r.config.locationId || '';
    document.getElementById('reservationTypeId').value = r.config.reservationTypeId || '';
    // show running state and config summary
    document.getElementById('runningState').textContent = r.running ? 'running' : 'stopped';
    renderConfigSummary(r.config);
  }
}

document.getElementById('saveConfig').onclick = async () => {
  const payload = {
    token: document.getElementById('token').value.trim(),
    organisationId: document.getElementById('organisationId').value.trim(),
    federationId: document.getElementById('federationId').value.trim(),
    locationId: document.getElementById('locationId').value.trim(),
    reservationTypeId: Number(document.getElementById('reservationTypeId').value) || 85
  };
  const r = await api('/api/config', 'POST', payload);
  if (r.ok) log('Config saved');
  else log('Failed to save config');
  // update UI summary and running status
  if (r && r.config) renderConfigSummary(r.config);
};

document.getElementById('testSearch').onclick = async () => {
  await performTestSearch();
};

// performTestSearch: reusable search function used by Test Search button and auto-book
async function performTestSearch() {
  // Save current config first
  const cfg = {
    token: document.getElementById('token').value.trim(),
    organisationId: document.getElementById('organisationId').value.trim(),
    federationId: document.getElementById('federationId').value.trim(),
    locationId: document.getElementById('locationId').value.trim(),
    reservationTypeId: Number(document.getElementById('reservationTypeId').value) || 85
  };
  await api('/api/config', 'POST', cfg);
  log('Running test search...');
  // get server config to build public search URL
  const cfgResp = await api('/api/config');
  const apiBase = (cfgResp && cfgResp.config && cfgResp.config.apiBase) ? cfgResp.config.apiBase : '';
  // attempt to convert members -> public base
  let publicBase = apiBase.replace('/members/api/v1', '/public/api/v1');
  if (!publicBase.includes('http')) publicBase = 'https://api.foys.io/court-booking/public/api/v1';

  const durations = Array.from(document.querySelectorAll('.dur:checked')).map(i=>Number(i.value));
  const playingParams = durations.map(d=>`playingTimes[]=${encodeURIComponent(d)}`).join('&');
  const dateParam = (document.getElementById('date').value) ? (document.getElementById('date').value + 'T00:00:00.000Z') : (new Date().toISOString().slice(0,10)+'T00:00:00.000Z');
  const fullUrl = `${publicBase.replace(/\/$/, '')}/locations/search?reservationTypeId=${cfg.reservationTypeId || 85}&locationId=${cfg.locationId}&${playingParams}&date=${encodeURIComponent(dateParam)}`;

  const r = await api('/api/proxy-request', 'POST', { method: 'GET', fullUrl });
  if (r && r.ok) {
    log('Search OK — rendering slots');
    renderLastResult(r);
    try {
      const data = r.data || r;
      renderSlotsFromSearch(data);
      return window.lastAvailableSlots || [];
    } catch (e) {
      log('Failed to parse search response: ' + e.message);
      clearSlots();
      return [];
    }
  } else {
    log('Search returned error');
    renderLastResult(r);
    clearSlots();
    return [];
  }
}

document.getElementById('testBooking').onclick = async () => {
  // Save config first
  const cfg = {
    token: document.getElementById('token').value.trim(),
    organisationId: document.getElementById('organisationId').value.trim(),
    federationId: document.getElementById('federationId').value.trim(),
    locationId: document.getElementById('locationId').value.trim(),
    reservationTypeId: Number(document.getElementById('reservationTypeId').value) || 85
  };
  await api('/api/config', 'POST', cfg);

  // Determine inventoryId and times
  let inventoryId = document.getElementById('testInventoryId').value.trim();
  const start = document.getElementById('testStart').value.trim();
  const end = document.getElementById('testEnd').value.trim();

  if (!inventoryId) {
    // try to extract from lastResult if available
    const last = document.getElementById('lastResult').textContent;
    try {
      const parsed = JSON.parse(last);
      // search for a common shape
      if (parsed && parsed.data && Array.isArray(parsed.data.locations) && parsed.data.locations.length) {
        const loc = parsed.data.locations[0];
        if (loc.inventoryItems && loc.inventoryItems.length) inventoryId = String(loc.inventoryItems[0].id || loc.inventoryItems[0].inventoryItemId || '');
      }
    } catch (e) {}
  }

  if (!inventoryId) {
    inventoryId = prompt('Enter inventoryItemId for test booking (e.g. 737)');
    if (!inventoryId) return log('Test booking cancelled — no inventory id');
  }

  if (!start || !end) {
    // ask user
    const s = inventoryId ? document.getElementById('testStart').value : '';
    const inputStart = start || prompt('Start datetime (YYYY-MM-DDTHH:mm)', new Date().toISOString().slice(0,16));
    const inputEnd = end || prompt('End datetime (YYYY-MM-DDTHH:mm)', new Date(new Date().getTime()+60*60000).toISOString().slice(0,16));
    if (!inputStart || !inputEnd) return log('Test booking cancelled — missing times');
    // use provided
    const payload = { reservationTypeId: cfg.reservationTypeId, startDateTime: inputStart, endDateTime: inputEnd, reservations: [{ inventoryItemId: Number(inventoryId) }] };
    log('Sending test booking...');
    const r = await api('/api/proxy-booking', 'POST', payload);
    renderLastResult(r);
    if (r && r.ok) {
      const guid = (r.data && (r.data.guid || (r.data.reservations && r.data.reservations[0] && r.data.reservations[0].guid)));
      const bookingUrl = guid ? `https://www.padelpowers.com/en/booking/court-booking/booking/${guid}/` : null;
      renderBookingArea({ bookingUrl, timeOutAt: (r.data && r.data.timeOutAt) });
      log('Test booking succeeded');
    } else log('Test booking failed');
    return;
  }

  const payload = { reservationTypeId: cfg.reservationTypeId, startDateTime: start, endDateTime: end, reservations: [{ inventoryItemId: Number(inventoryId) }] };
  log('Sending test booking...');
  const r2 = await api('/api/proxy-booking', 'POST', payload);
  renderLastResult(r2);
  if (r2 && r2.ok) {
    const guid = (r2.data && (r2.data.guid || (r2.data.reservations && r2.data.reservations[0] && r2.data.reservations[0].guid)));
    const bookingUrl = guid ? `https://www.padelpowers.com/en/booking/court-booking/booking/${guid}/` : null;
    renderBookingArea({ bookingUrl, timeOutAt: (r2.data && r2.data.timeOutAt) });
    log('Test booking succeeded');
  } else log('Test booking failed');
};

document.getElementById('allDur').addEventListener('change', (e)=>{
  const checked = e.target.checked;
  document.querySelectorAll('.dur').forEach(d=>d.checked = checked);
});

document.getElementById('clearLogs').onclick = () => {
  document.getElementById('logs').textContent = '';
};

document.getElementById('start').onclick = async () => {
  // First, ensure server has the latest config from the form
  const cfg = {
    token: document.getElementById('token').value.trim(),
    organisationId: document.getElementById('organisationId').value.trim(),
    federationId: document.getElementById('federationId').value.trim(),
    locationId: document.getElementById('locationId').value.trim(),
    reservationTypeId: Number(document.getElementById('reservationTypeId').value) || 85
  };
  const saveRes = await api('/api/config', 'POST', cfg);
  if (saveRes && saveRes.ok) {
    renderConfigSummary(saveRes.config);
    log('Config saved before start');
  } else {
    log('Warning: failed to save config before start');
  }

  const durations = Array.from(document.querySelectorAll('.dur:checked')).map(i=>Number(i.value));
  const body = {
    date: document.getElementById('date').value || undefined,
    durations,
    intervalSeconds: Number(document.getElementById('intervalSeconds').value) || 0,
    windowStart: document.getElementById('windowStart').value,
    windowEnd: document.getElementById('windowEnd').value
  };
  const r = await api('/api/start', 'POST', body);
  if (r.ok) {
    log('Started job. Running: ' + (r.running ? 'yes' : 'no'));
    document.getElementById('runningState').textContent = r.running ? 'running' : 'stopped';
    if (r.lastRun) renderLastResult(r.lastRun);
  } else log('Failed to start: ' + JSON.stringify(r));
};

document.getElementById('stop').onclick = async () => {
  const r = await api('/api/stop', 'POST');
  if (r.ok) log('Stopped job');
  else log('Stop returned: ' + JSON.stringify(r));
  document.getElementById('runningState').textContent = 'stopped';
};

function renderConfigSummary(cfg) {
  const s = document.getElementById('configSummary');
  if (!cfg) return s.textContent = '';
  const parts = [];
  if (cfg.organisationId) parts.push(`org: ${cfg.organisationId}`);
  if (cfg.federationId) parts.push(`federation: ${cfg.federationId}`);
  if (cfg.locationId) parts.push(`location: ${cfg.locationId}`);
  if (cfg.reservationTypeId) parts.push(`type: ${cfg.reservationTypeId}`);
  s.textContent = parts.join(' • ');
}

function renderLastResult(obj) {
  const el = document.getElementById('lastResult');
  try {
    el.textContent = JSON.stringify(obj, null, 2);
  } catch (e) {
    el.textContent = String(obj);
  }
}

function clearSlots() {
  const container = document.getElementById('slots');
  if (container) container.innerHTML = '(run Test search to see slots)';
}

function copyToClipboard(text) {
  if (!navigator.clipboard) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove();
    return;
  }
  navigator.clipboard.writeText(text).catch(()=>{});
}

function renderBookingArea(obj) {
  const el = document.getElementById('bookingArea');
  if (!el) return;
  if (!obj) return el.innerHTML = '(no booking yet)';
  if (obj.bookingUrl) {
    const timeOut = obj.timeOutAt || (obj.response && obj.response.data && obj.response.data.timeOutAt) || (obj.data && obj.data.timeOutAt);
    let html = `<div class="booking-link">Booking created — <a href="${obj.bookingUrl}" target="_blank">Open booking page</a> <button id="copyBookingLink" class="copy-btn">Copy link</button></div>`;
    if (timeOut) {
      const t = new Date(timeOut).getTime();
      const now = Date.now();
      const remaining = Math.max(0, Math.floor((t - now) / 1000));
      html += `<div>Payment timeout in <strong id="countdown">${remaining}</strong> seconds</div>`;
      el.innerHTML = html;
      const cdEl = document.getElementById('countdown');
      if (cdEl) {
        let rem = remaining;
        const iv = setInterval(()=>{
          rem -= 1;
          if (rem <= 0) { cdEl.textContent = '0'; clearInterval(iv); return; }
          cdEl.textContent = String(rem);
        }, 1000);
      }
    } else {
      el.innerHTML = html;
    }

    // setup copy button
    const copyBtn = document.getElementById('copyBookingLink');
    if (copyBtn) copyBtn.onclick = ()=>{ copyToClipboard(obj.bookingUrl); log('Booking link copied'); };

    // auto-open if requested
    try {
      const auto = document.getElementById('autoOpen');
      if (auto && auto.checked) window.open(obj.bookingUrl, '_blank');
    } catch (e) {}
    // start polling booking status by GUID if present
    try {
      const guid = (obj.bookingUrl && obj.bookingUrl.split('/').filter(Boolean).pop()) || null;
      if (guid) startBookingStatusPoll(guid);
    } catch (e) {}
  } else {
    el.textContent = JSON.stringify(obj, null, 2);
  }
}

let _bookingPoll = null;
function startBookingStatusPoll(guid) {
  stopBookingStatusPoll();
  if (!guid) return;
  const statusEl = document.getElementById('bookingArea');
  async function poll() {
    try {
      const r = await api(`/api/booking-status?guid=${encodeURIComponent(guid)}`);
      if (r && r.ok && r.data) {
        // display simplified status
        const st = (r.data && (r.data.status || r.data.bookingStatus || r.data.state)) || (r.data.reservations && r.data.reservations[0] && r.data.reservations[0].status) || 'unknown';
        statusEl.querySelectorAll('.booking-status-note').forEach(n=>n.remove());
        const note = document.createElement('div'); note.className = 'booking-status-note'; note.textContent = `Booking status: ${st}`;
        statusEl.appendChild(note);
        // stop polling if no longer pending
        if (String(st).toLowerCase() !== 'pending') { stopBookingStatusPoll(); }
      } else {
        // show error
        statusEl.querySelectorAll('.booking-status-note').forEach(n=>n.remove());
        const note = document.createElement('div'); note.className = 'booking-status-note'; note.textContent = `Booking status: unknown or error`;
        statusEl.appendChild(note);
      }
    } catch (e) {
      console.warn('poll error', e);
    }
  }
  // run immediately then every 8s
  poll();
  _bookingPoll = setInterval(poll, 8000);
}
function stopBookingStatusPoll() { if (_bookingPoll) { clearInterval(_bookingPoll); _bookingPoll = null; } }

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' })[c] || c); }

function buildSlotHtml(inv, times, locationName) {
  const lines = [];
  lines.push(`<div class="slot-inv">`);
  const availClass = (inv && inv.available) ? 'available' : 'unavailable';
  const badge = (inv && typeof inv.available !== 'undefined') ? `<span class="availability ${inv.available? 'available':'unavailable'}">${inv.available? 'Available':'Unavailable'}</span>` : '';
  lines.push(`<div class="inv-title">${escapeHtml(inv.name || `#${inv.id}`)} ${badge}</div>`);
  lines.push(`<div class="badge-id">id: ${escapeHtml(inv.id || 'unknown')}</div>`);
  if (!times || times.length === 0) lines.push(`<div class="no-times">no available times</div>`);
  else {
    lines.push('<ul class="times">');
    times.forEach(t => {
      const startLocal = (t.start || '').replace('Z','');
      const dur = t.duration || 60;
      const dataInv = inv.id ? inv.id : '';
      lines.push(`<li>${escapeHtml(startLocal)} <small>(${dur}m)</small> <button class="book-btn" data-inv="${dataInv}" data-start="${escapeHtml(t.start)}" data-duration="${escapeHtml(dur)}">Book</button></li>`);
    });
    lines.push('</ul>');
  }
  lines.push('</div>');
  return lines.join('\n');
}

function renderSlotsFromSearch(searchJson) {
  const container = document.getElementById('slots');
  if (!container) return;
  container.innerHTML = '';
  const root = (searchJson && searchJson.data) ? searchJson.data : searchJson;

  // Collect inventory items (id -> metadata) if present
  const inventories = new Map();
  function collectInventories(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(collectInventories);
    const maybeId = o.id || o.inventoryItemId || o.inventory_item_id;
    if (maybeId && (o.name || o.inventoryItems || o.timeSlots || o.availableStartTimes)) {
      const available = (o.isAvailable === true || o.available === true || o.is_available === true) ? true : (o.isAvailable === false || o.available === false || o.is_available === false) ? false : undefined;
      inventories.set(String(maybeId), { id: String(maybeId), name: o.name || o.displayName || (o.inventoryItem && o.inventoryItem.name) || '', available });
    }
    for (const k of Object.keys(o)) collectInventories(o[k]);
  }
  collectInventories(root);

  // Deep-scan for slot-like objects (have start/startTime/startDateTime and maybe duration)
  const slots = [];
  const seen = new Set();
  function deepFindSlots(o, parentInvId, parentAvailable) {
    if (!o || typeof o !== 'object') return;
    if (seen.has(o)) return; seen.add(o);
    if (Array.isArray(o)) return o.forEach(el=>deepFindSlots(el, parentInvId, parentAvailable));

    // infer inventory id from object properties
    const invId = o.inventoryItemId || o.inventory_item_id || (o.inventoryItem && (o.inventoryItem.id || o.inventoryItem.inventoryItemId)) || parentInvId;
    // determine availability at this node
    const nodeAvailable = (o.isAvailable === true || o.available === true || o.is_available === true) ? true : (o.isAvailable === false || o.available === false || o.is_available === false) ? false : undefined;
    const inheritedAvailable = (invId && inventories.has(String(invId)) && inventories.get(String(invId)).available === true) ? true : parentAvailable;
    const effectiveAvailable = nodeAvailable !== undefined ? nodeAvailable : (inheritedAvailable !== undefined ? inheritedAvailable : undefined);

    const start = o.start || o.startDateTime || o.startTime || o.time || o.from || o.slotStart;
    const duration = o.duration || o.minutes || (o.endDateTime && start ? (new Date(o.endDateTime).getTime() - new Date(start).getTime())/60000 : undefined) || 60;
    // Only include slots that are explicitly available (or whose inventory is explicitly available)
    if (start && (effectiveAvailable === true)) {
      slots.push({ start, duration: Math.round(duration||60), inventoryId: invId ? String(invId) : null, raw: o });
    }
    // continue traversal, passing along inventory id and availability when found
    for (const k of Object.keys(o)) deepFindSlots(o[k], invId || parentInvId, effectiveAvailable);
  }
  deepFindSlots(root, null);

  if (!slots.length) return container.innerHTML = '(no slots found)';

  // Group slots by inventoryId (or 'unknown')
  const groups = new Map();
  for (const s of slots) {
    const key = s.inventoryId || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const parts = [];
  for (const [invKey, times] of groups.entries()) {
    const invMeta = inventories.get(invKey) || { id: invKey === 'unknown' ? 'unknown' : invKey, name: invKey === 'unknown' ? 'Unknown inventory' : (inventories.get(invKey) && inventories.get(invKey).name) || `#${invKey}`, available: undefined };
    // Normalize times to {start,duration}
    const norm = times.map(t=>({ start: (t.start && String(t.start)), duration: t.duration || 60 }));
    parts.push(buildSlotHtml({ id: invMeta.id, name: invMeta.name }, norm, ''));
  }

  container.innerHTML = `<div class="slot-grid">${parts.join('\n')}</div>`;

  // if we found exactly one available inventory, auto-fill the quick inventory input for easier booking
  try {
    const availableInvs = Array.from(inventories.values()).filter(i => i.available === true);
    if (availableInvs.length === 1) {
      const el = document.getElementById('testInventoryId');
      if (el) el.value = availableInvs[0].id;
    }
  } catch (e) {}
  // publish a flat list of available slots for other actions (auto-book)
  try {
    window.lastAvailableSlots = slots.map(s=>({ inventoryId: s.inventoryId, start: s.start, duration: s.duration }));
  } catch (e) { window.lastAvailableSlots = []; }
}

// delegate booking button clicks
document.addEventListener('click', async (ev)=>{
  const btn = ev.target.closest && ev.target.closest('.book-btn') ? ev.target.closest('.book-btn') : (ev.target.classList && ev.target.classList.contains('book-btn') ? ev.target : null);
  if (!btn) return;
  const invAttr = btn.getAttribute('data-inv');
  let inv = (invAttr && invAttr !== '') ? Number(invAttr) : null;
  const start = btn.getAttribute('data-start');
  const duration = Number(btn.getAttribute('data-duration')) || 90;
  if (!inv) {
    // fallback to quick input field
    const quick = (document.getElementById('testInventoryId') && document.getElementById('testInventoryId').value.trim()) || '';
    if (quick) inv = Number(quick);
    else {
      const answer = prompt('Inventory id not found in search result. Enter inventoryItemId (e.g. 737)');
      if (!answer) return log('Booking cancelled — no inventory id');
      inv = Number(answer);
    }
  }
  if (!start) return log('Invalid slot start time');
  const dt = new Date(start);
  const endDt = new Date(dt.getTime() + duration*60000);
  function fmtLocal(d) { const z=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; }
  const payload = { reservationTypeId: Number(document.getElementById('reservationTypeId').value)||85, startDateTime: fmtLocal(dt), endDateTime: fmtLocal(endDt), reservations: [{ inventoryItemId: inv }] };
  log('Booking slot: ' + payload.startDateTime + ' inv:' + inv + ' dur:' + duration);
  api('/api/proxy-booking', 'POST', payload).then(r=>{
    renderLastResult(r);
    if (r && r.ok && r.data) {
      const resp = r.data;
      const guid = (resp && (resp.guid || (resp.reservations && resp.reservations[0] && resp.reservations[0].guid)));
      const bookingUrl = guid ? `https://www.padelpowers.com/en/booking/court-booking/booking/${guid}/` : null;
      renderBookingArea({ bookingUrl, timeOutAt: (resp && resp.timeOutAt) || (r.data && r.data.timeOutAt) });
      log('Booking response: ok (status ' + r.status + ')');
    } else {
      // Log details for debugging
      try {
        log('Booking failed — status: ' + String(r && r.status) + ' body: ' + (r && r.data ? JSON.stringify(r.data) : String(r && r.__rawText || r && r.error || 'empty')));
      } catch (e) {
        log('Booking failed — could not stringify response');
      }
    }
  }).catch(err=>{ log('Booking error: '+err.message); });
});

// Auto-book all available slots found in last Test search
async function autoBookAll() {
  const slots = window.lastAvailableSlots || [];
  // if no slots from last search, run a fresh Test search automatically
  let toBook = slots && slots.length ? slots : (await performTestSearch());
  if (!toBook || !toBook.length) return log('No available slots to auto-book');
  if (!confirm(`Auto-book ${toBook.length} slot(s)? This will attempt to create bookings sequentially.`)) return;
  for (let i=0;i<toBook.length;i++) {
    const s = toBook[i];
    // determine inventory id: use slot inventory if present, otherwise fall back to quick Inventory input
    let invId = s.inventoryId || null;
    if (!invId) {
      const quick = (document.getElementById('testInventoryId') && document.getElementById('testInventoryId').value.trim()) || '';
      if (quick) invId = quick;
    }
    if (!invId) { log(`Skipping slot ${s.start} — missing inventory id`); continue; }
    await bookSlot(invId, s.start, s.duration);
    // small delay between bookings to avoid overwhelming the API
    await sleep(600);
  }
  log('Auto-book process completed');
}

try { const btn = document.getElementById('autoBookAll'); if (btn) btn.onclick = autoBookAll; } catch (e) {}

async function pollStatus() {
  try {
    const r = await api('/api/config');
    if (r) {
      document.getElementById('runningState').textContent = r.running ? 'running' : 'stopped';
    }
  } catch (e) {
    console.warn('pollStatus error', e);
  }
}

loadConfig().catch(e=>console.error(e));
setInterval(pollStatus, 5000);
