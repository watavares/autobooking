const axios = require('axios');

function isoDateStart(dateStr) {
  return `${dateStr}T00:00:00.000Z`;
}

function parseISOToLocal(dateTimeStr) {
  if (!dateTimeStr) return null;
  let s = dateTimeStr;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s = s + ':00';
  return new Date(s);
}

function isWithinWindow(startDateObj, windowStartStr, windowEndStr, durationMinutes) {
  if (!startDateObj) return false;
  const [wsH, wsM] = windowStartStr.split(':').map(Number);
  const [weH, weM] = windowEndStr.split(':').map(Number);
  const year = startDateObj.getFullYear();
  const month = startDateObj.getMonth();
  const day = startDateObj.getDate();
  const windowStart = new Date(year, month, day, wsH, wsM, 0);
  const windowEnd = new Date(year, month, day, weH, weM, 0);
  const endIf = new Date(startDateObj.getTime() + durationMinutes * 60000);
  return startDateObj >= windowStart && endIf <= windowEnd;
}

function extractSlotsFromSearch(searchJson) {
  const candidates = [];
  function pushIfSlot(slot) {
    if (!slot) return;
    if (slot.inventoryItemId || slot.inventory_item_id || (slot.inventoryItem && slot.inventoryItem.id)) {
      candidates.push(slot);
      return;
    }
  }
  const tryPaths = [
    searchJson,
    searchJson && searchJson.slots,
    searchJson && searchJson.availableSlots,
    searchJson && searchJson.available_slots,
    searchJson && searchJson.results,
    searchJson && searchJson.data,
    searchJson && searchJson.inventoryItems,
    searchJson && searchJson.items,
    searchJson && searchJson.timeSlots,
    searchJson && searchJson.available
  ];
  for (const p of tryPaths) {
    if (!p) continue;
    if (Array.isArray(p)) {
      for (const s of p) pushIfSlot(s);
    } else if (typeof p === 'object') {
      for (const key of Object.keys(p)) {
        if (Array.isArray(p[key])) for (const s of p[key]) pushIfSlot(s);
      }
    }
  }
  if (candidates.length === 0) {
    const visited = new Set();
    function deepSearch(obj) {
      if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
      visited.add(obj);
      if (Array.isArray(obj)) for (const el of obj) deepSearch(el);
      else {
        const keys = Object.keys(obj);
        if ((keys.includes('start') || keys.some(k=>/start/i.test(k))) &&
            (keys.includes('inventoryItemId') || keys.some(k=>/inventory/i.test(k) && /id/i.test(k)))) {
          candidates.push(obj);
        } else {
          for (const k of keys) deepSearch(obj[k]);
        }
      }
    }
    deepSearch(searchJson);
  }
  const normalized = candidates.map(c => ({
    raw: c,
    inventoryItemId: c.inventoryItemId ?? c.inventory_item_id ?? (c.inventoryItem && (c.inventoryItem.id ?? c.inventoryItem.inventoryItemId)),
    start: c.start ?? c.startDateTime ?? c.time ?? c.slotStart ?? c.start_time ?? (c.from ?? null)
  })).filter(s => s.inventoryItemId && s.start);
  return normalized;
}

async function searchAvailability(axiosInstance, dateStr, duration) {
  const dateParam = isoDateStart(dateStr);
  // Use the public search endpoint (the site uses /public/api/v1/locations/search)
  // If the configured baseURL points to /members/api/v1, replace it with /public/api/v1
  const base = (axiosInstance.defaults && axiosInstance.defaults.baseURL) ? axiosInstance.defaults.baseURL : (axiosInstance._baseURL || 'https://api.foys.io/court-booking/members/api/v1');
  const publicBase = base.replace('/members/api/v1', '/public/api/v1').replace(/\/$/, '');
  const url = `${publicBase}/locations/search?reservationTypeId=${axiosInstance._reservationTypeId}&locationId=${axiosInstance._locationId}&playingTimes[]=${duration}&date=${encodeURIComponent(dateParam)}`;
  // axiosInstance may have headers and token configured; issuing absolute URL will still use those headers
  const res = await axiosInstance.get(url);
  return res.data;
}

async function tryBookSlot(axiosInstance, slot, duration) {
  const inventoryItemId = slot.inventoryItemId ?? slot.inventory_item_id ?? (slot.inventoryItem && slot.inventoryItem.id);
  const startStr = slot.start ?? slot.startDateTime ?? slot.time ?? slot.slotStart ?? slot.start_time;
  if (!inventoryItemId || !startStr) return { ok: false, reason: 'missing-fields' };
  const startDate = parseISOToLocal(startStr);
  if (!startDate) return { ok: false, reason: 'bad-date' };
  const endDate = new Date(startDate.getTime() + duration * 60000);
  const fmt = d => { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };
  const body = {
    reservationTypeId: axiosInstance._reservationTypeId,
    startDateTime: fmt(startDate),
    endDateTime: fmt(endDate),
    reservations: [{ inventoryItemId: Number(inventoryItemId) }]
  };
  try {
    const r = await axiosInstance.post('/bookings', body);
    // Construct a user-facing booking URL (the web app exposes bookings at this path)
    const bookingGuid = (r.data && (r.data.guid || r.data.bookingId || r.data.id)) || null;
    const bookingUrl = bookingGuid ? `https://www.padelpowers.com/en/booking/court-booking/booking/${bookingGuid}` : null;
    return { ok: true, status: r.status, data: r.data, bookingUrl };
  } catch (err) {
    if (err.response) return { ok: false, status: err.response.status, data: err.response.data };
    else return { ok: false, reason: 'network', error: err.message };
  }
}

function makeAxiosInstance(config) {
  const axiosInstance = axios.create({
    baseURL: config.apiBase || 'https://api.foys.io/court-booking/members/api/v1',
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      'x-organisationid': config.organisationId,
      'x-federationid': config.federationId,
      'Origin': 'https://www.padelpowers.com',
      'Referer': `https://www.padelpowers.com/en/booking/court-booking/reservation?locationId=${config.locationId}`
    },
    timeout: config.timeout || 10000
  });
  axiosInstance._reservationTypeId = config.reservationTypeId;
  axiosInstance._locationId = config.locationId;
  return axiosInstance;
}

async function runBooking(config, opts = {}) {
  if (!config || !config.token) throw new Error('CONFIG.token required');
  const axiosInstance = makeAxiosInstance(config);
  const dateStr = opts.date || (new Date().toISOString().slice(0,10));
  const durations = opts.durations && opts.durations.length ? opts.durations : [90];
  const windowStart = opts.windowStart || '18:30';
  const windowEnd = opts.windowEnd || '22:00';
  const results = [];

  for (const duration of durations) {
    try {
      const searchJson = await searchAvailability(axiosInstance, dateStr, duration);
      // If upstream returned an error-shaped response, propagate it into results
      if (searchJson && searchJson.ok === false) {
        results.push({ duration, status: searchJson.status, data: searchJson.data });
        continue;
      }
      const slots = extractSlotsFromSearch(searchJson);
      const candidateSlots = slots.filter(s => {
        const dt = parseISOToLocal(s.start);
        return isWithinWindow(dt, windowStart, windowEnd, duration);
      });
      results.push({ duration, found: slots.length, candidates: candidateSlots.length });
      for (const s of candidateSlots) {
        const res = await tryBookSlot(axiosInstance, s, duration);
        if (res.ok) {
          return { booked: true, duration, slot: s, response: res, bookingUrl: res.bookingUrl };
        }
      }
    } catch (err) {
      // Provide richer error info when available from axios
      if (err && err.response) {
        results.push({ duration, status: err.response.status, data: err.response.data });
      } else {
        results.push({ duration, error: err.message });
      }
    }
  }
  return { booked: false, details: results };
}

module.exports = { runBooking };
