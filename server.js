const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const multer  = require('multer');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Budget store: licenseKey -> { spent: 0 } ─────────────────
const store = new Map();

// ── Helpers ───────────────────────────────────────────────────
function cost(i, o) { return (i / 1000) * 0.003 + (o / 1000) * 0.015; }

async function claude(system, messages, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  console.log('Claude key length:', key ? key.length : 0);

  const r = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system, messages },
    { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 120000 }
  );
  return { text: r.data.content[0].text, cost: cost(r.data.usage.input_tokens, r.data.usage.output_tokens) };
}

// ── License Key validation via Lemon Squeezy ─────────────────
async function validateLS(licenseKey) {
  try {
    const r = await axios.post(
      'https://api.lemonsqueezy.com/v1/licenses/validate',
      { license_key: licenseKey.trim() },
      { headers: { 'Authorization': `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    return r.data.valid === true;
  } catch (e) {
    console.error('LS validate error:', e.response?.status, e.response?.data);
    return false;
  }
}

async function activateLS(licenseKey) {
  try {
    await axios.post(
      'https://api.lemonsqueezy.com/v1/licenses/activate',
      { license_key: licenseKey.trim(), instance_name: 'ESP' },
      { headers: { 'Authorization': `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 10000 }
    );
  } catch (e) { /* already activated is ok */ }
}

function getBudget(k) {
  const b = store.get(k) || { spent: 0 };
  return { spent: b.spent, remaining: +(0.75 - b.spent).toFixed(4), ok: b.spent < 0.75 };
}

function addSpend(k, c) {
  const b = store.get(k) || { spent: 0 };
  b.spent = +(b.spent + c).toFixed(6);
  store.set(k, b);
  return getBudget(k);
}

// ── System Prompt ─────────────────────────────────────────────
const SYSTEM = `You are a warm, wise Eastern life navigation guide for Eastern Soul Path.
"I help you read the map, but you choose the road."

TONE: Warm, grounding, non-scary. Like a trusted friend with ancient wisdom.
Never say: bad luck, cursed, dangerous, doomed, worst year, disaster.
Instead use: tension pattern, extra mindful, supportive cycle, mindful period.

For full reading, use these sections:
## 🌿 Your Life Structure
## 💼 Career & Wealth Journey
## ❤️ Love & Relationships
## 🌊 Your Life Cycles
## 📅 The Next 10 Years

Life cycles: give theme + description + 🟢 Supportive / 🟡 Mindful / 🔴 Extra Mindful
Next 10 years: each year with theme and indicator.
End warmly, invite follow-up questions.
Respond in English.`;

function chartContext(pillars, gender, birthYear) {
  const M = { '甲':'Wood+','乙':'Wood-','丙':'Fire+','丁':'Fire-','戊':'Earth+','己':'Earth-','庚':'Metal+','辛':'Metal-','壬':'Water+','癸':'Water-','子':'Rat','丑':'Ox','寅':'Tiger','卯':'Rabbit','辰':'Dragon','巳':'Snake','午':'Horse','未':'Goat','申':'Monkey','酉':'Rooster','戌':'Dog','亥':'Pig' };
  const e = s => `${s}(${M[s]||s})`;
  return `Gender: ${gender} | Birth Year: ${birthYear} | Age: ~${new Date().getFullYear()-birthYear}
Pillars — Hour: ${e(pillars.hour.stem)}/${e(pillars.hour.branch)} | Day: ${e(pillars.day.stem)}/${e(pillars.day.branch)} | Month: ${e(pillars.month.stem)}/${e(pillars.month.branch)} | Year: ${e(pillars.year.stem)}/${e(pillars.year.branch)}`;
}

// ── BaZi Calculator ───────────────────────────────────────────
const S = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
const B = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];

function calcPillars(year, month, day, hour) {
  const yAdj = (month < 2 || (month === 2 && day < 4)) ? year - 1 : year;
  const yP = { stem: S[((yAdj-4)%10+10)%10], branch: B[((yAdj-4)%12+12)%12] };
  const td = [6,4,6,5,6,6,7,8,8,8,7,7];
  const mi = (((day < td[month-1] ? month-2 : month-1) % 12) + 12) % 12;
  const mP = { stem: S[([2,4,6,8,0,2,4,6,8,0][((yAdj-4)%10+10)%10] + mi) % 10], branch: B[mi] };
  const diff = Math.floor((new Date(year,month-1,day) - new Date(1900,0,1)) / 86400000);
  const dP = { stem: S[((diff%10)+10)%10], branch: B[(((diff+10)%12)+12)%12] };
  const bi = Math.floor((hour+1)/2) % 12;
  const hP = { stem: S[([0,2,4,6,8,0,2,4,6,8][S.indexOf(dP.stem)] + bi) % 10], branch: B[bi] };
  return { year: yP, month: mP, day: dP, hour: hP };
}

// ── Routes ────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    anthropic_key: !!process.env.ANTHROPIC_API_KEY,
    ls_key: !!process.env.LEMONSQUEEZY_API_KEY,
    key_length: process.env.ANTHROPIC_API_KEY?.length || 0
  });
});

// Calculate pillars
app.post('/api/pillars', (req, res) => {
  try {
    const { year, month, day, hour } = req.body;
    res.json({ ok: true, pillars: calcPillars(+year, +month, +day, +(hour||12)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Validate key
app.post('/api/key', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'No key' });
  const valid = await validateLS(key);
  if (!valid) return res.status(401).json({ error: 'Invalid license key — please check and try again' });
  await activateLS(key);
  const b = getBudget(key);
  res.json({ ok: true, remaining: b.remaining });
});

// Full report
app.post('/api/report', async (req, res) => {
  const { key, pillars, gender, birthYear } = req.body;
  if (!key || !pillars || !gender || !birthYear) return res.status(400).json({ error: 'Missing fields' });
  const b = getBudget(key);
  if (!b.ok) return res.status(402).json({ error: 'Credit used up. Get a new reading at easternsoulfpath.com' });

  try {
    const cy = new Date().getFullYear();
    const prompt = `${chartContext(pillars, gender, +birthYear)}

Give a complete Eastern Soul Path life navigation reading with all 5 sections:
## 🌿 Your Life Structure — Day master traits, natural strengths, life pattern (3-4 sentences)
## 💼 Career & Wealth Journey — timing, peak windows, aligned work type (4-5 sentences)
## ❤️ Love & Relationships — patterns, commitment timing, ideal partner (4-5 sentences with ages)
## 🌊 Your Life Cycles — ALL cycles birth to ~80s, each with: age range, theme, 2-3 sentences, 🟢/🟡/🔴
## 📅 The Next 10 Years (${cy}–${cy+9}) — each year: year · age · theme · 🟢/🟡/🔴
Close warmly and invite questions.`;

    const result = await claude(SYSTEM, [{ role: 'user', content: prompt }], 4000);
    const budget = addSpend(key, result.cost);
    res.json({ ok: true, report: result.text, remaining: budget.remaining });
  } catch (e) {
    console.error('Report error:', e.response?.status, e.message);
    res.status(500).json({ error: 'Generation failed: ' + e.message });
  }
});

// Ask question
app.post('/api/ask', async (req, res) => {
  const { key, question, pillars, gender, birthYear, history } = req.body;
  if (!key || !question) return res.status(400).json({ error: 'Missing fields' });
  const b = getBudget(key);
  if (!b.ok) return res.status(402).json({ error: 'Credit used up. Get a new reading at easternsoulfpath.com' });

  try {
    const ctx = pillars ? `\n\nCHART: ${chartContext(pillars, gender, +birthYear)}` : '';
    const messages = [...(history||[]).slice(-10), { role:'user', content: question }];
    const result = await claude(SYSTEM + ctx, messages, 1200);
    const budget = addSpend(key, result.cost);
    res.json({ ok: true, answer: result.text, remaining: budget.remaining });
  } catch (e) {
    console.error('Ask error:', e.response?.status, e.message);
    res.status(500).json({ error: 'Failed: ' + e.message });
  }
});

// Image reading
app.post('/api/image', upload.single('image'), async (req, res) => {
  const { key } = req.body;
  if (!key || !req.file) return res.status(400).json({ error: 'Missing key or image' });
  const b = getBudget(key);
  if (!b.ok) return res.status(402).json({ error: 'Credit used up' });

  try {
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-20250514', max_tokens: 300, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: req.file.mimetype, data: req.file.buffer.toString('base64') } },
        { type: 'text', text: 'Extract BaZi four pillars. Return JSON only: {"hour":{"stem":"X","branch":"X"},"day":{"stem":"X","branch":"X"},"month":{"stem":"X","branch":"X"},"year":{"stem":"X","branch":"X"}} Stems: 甲乙丙丁戊己庚辛壬癸 Branches: 子丑寅卯辰巳午未申酉戌亥' }
      ]}] },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 }
    );
    const text = r.data.content[0].text;
    const pillars = JSON.parse(text.replace(/```json\n?/g,'').replace(/```/g,'').trim());
    const c = cost(r.data.usage.input_tokens, r.data.usage.output_tokens);
    const budget = addSpend(key, c);
    res.json({ ok: true, pillars, remaining: budget.remaining });
  } catch (e) {
    res.status(500).json({ error: 'Image read failed: ' + e.message });
  }
});

// Webhook
app.post('/webhook/lemonsqueezy', (req, res) => {
  try {
    const sig  = req.headers['x-signature'];
    const hmac = crypto.createHmac('sha256', process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '');
    hmac.update(req.body);
    if (sig && sig !== hmac.digest('hex')) return res.status(401).end();
    const p = JSON.parse(req.body.toString());
    if (p.meta?.event_name === 'order_created') console.log('✅ New order:', p.data?.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).end(); }
});

app.listen(PORT, () => console.log(`🌿 ESP running on :${PORT}`));
