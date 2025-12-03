// Small helper to decode JWT payload safely.
// Usage: node decode-jwt.js '<FULL_JWT>'

const t = process.argv[2];
if (!t) {
  console.error('Usage: node decode-jwt.js "<FULL_JWT>"');
  process.exit(1);
}
try {
  const parts = t.split('.');
  const payload = parts[1] || '';
  const b = payload.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4;
  const b2 = pad ? b + '='.repeat(4 - pad) : b;
  const s = Buffer.from(b2, 'base64').toString('utf8');
  try {
    const obj = JSON.parse(s);
    console.log(JSON.stringify(obj, null, 2));
  } catch (e) {
    console.log('Decoded payload (not valid JSON):');
    console.log(s);
  }
} catch (err) {
  console.error('Error decoding token:', err.message);
  process.exit(1);
}
