const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const redis   = require('redis');
const { Solar } = require('lunar-javascript');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Redis ─────────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL;
let redisClient = null;
let useRedis = false;

if (REDIS_URL) {
  console.log('📡 偵測到 REDIS_URL，正在嘗試初始化 Redis...');
  redisClient = redis.createClient({ url: REDIS_URL });
  redisClient.on('error', (err) => {
    console.error('❌ Redis 錯誤 (降級至本地):', err.message);
    useRedis = false;
  });
  redisClient.connect()
    .then(() => { console.log('🚀 成功連線至 Redis'); useRedis = true; })
    .catch((err) => { console.error('❌ Redis 連線失敗:', err.message); useRedis = false; });
} else {
  console.warn('⚠️ 未偵測到 REDIS_URL，使用本地檔案資料庫');
}

// ── 本地備援資料庫 ────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'key_store.json');
let localStore = new Map();

function loadLocalStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      localStore = new Map(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
      console.log('🌿 成功載入本地資料庫');
    }
  } catch (e) { console.error('本地資料庫載入失敗:', e.message); }
}
function saveLocalStore() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify([...localStore.entries()]), 'utf8'); } catch (e) { }
}
loadLocalStore();

const MAX_QUESTIONS = 10;

// ── Key 狀態管理 ──────────────────────────────────────────────
async function getKeyState(k) {
  if (useRedis && redisClient?.isOpen) {
    try {
      const [reportUsed, qCount] = await Promise.all([
        redisClient.get(`report:${k}`),
        redisClient.get(`questions:${k}`)
      ]);
      return {
        reportUsed: reportUsed === '1',
        questions: parseInt(qCount || '0'),
        remainingQuestions: Math.max(0, MAX_QUESTIONS - parseInt(qCount || '0'))
      };
    } catch (e) { console.error('Redis 讀取失敗，切換至本地'); }
  }
  const b = localStore.get(k) || { reportUsed: false, questions: 0 };
  return {
    reportUsed: b.reportUsed || false,
    questions: b.questions || 0,
    remainingQuestions: Math.max(0, MAX_QUESTIONS - (b.questions || 0))
  };
}

async function markReportUsed(k) {
  if (useRedis && redisClient?.isOpen) {
    try { await redisClient.set(`report:${k}`, '1'); return; } catch (e) { console.error('Redis 寫入失敗'); }
  }
  const b = localStore.get(k) || { reportUsed: false, questions: 0 };
  b.reportUsed = true;
  localStore.set(k, b);
  saveLocalStore();
}

async function incrementQuestion(k) {
  if (useRedis && redisClient?.isOpen) {
    try {
      const newCount = await redisClient.incr(`questions:${k}`);
      return Math.max(0, MAX_QUESTIONS - newCount);
    } catch (e) { console.error('Redis 寫入失敗'); }
  }
  const b = localStore.get(k) || { reportUsed: false, questions: 0 };
  b.questions = (b.questions || 0) + 1;
  localStore.set(k, b);
  saveLocalStore();
  return Math.max(0, MAX_QUESTIONS - b.questions);
}

// ── Middleware ────────────────────────────────────────────────
app.post('/webhook/lemonsqueezy', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const sig    = req.headers['x-signature'];
    const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';
    if (!secret) { console.error('❌ 遺失 LEMONSQUEEZY_WEBHOOK_SECRET'); return res.status(500).end(); }
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(req.body);
    if (!sig || sig !== hmac.digest('hex')) { console.warn('⚠️ Webhook 簽章不符'); return res.status(401).end(); }
    const p = JSON.parse(req.body.toString());
    if (p.meta?.event_name === 'order_created') console.log('✅ 新訂單:', p.data?.id);
    res.json({ ok: true });
  } catch (e) { console.error('Webhook 失敗:', e.message); res.status(500).end(); }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── BaZi Calculator using lunar-javascript ───────────────────
function calcPillars(year, month, day, hour, minute = 0) {
  try {
    const solar = Solar.fromYmdHms(year, month, day, hour, minute, 0);
    const lunar = solar.getLunar();
    const bazi  = lunar.getEightChar();
    return {
      year:  { stem: bazi.getYearGan(),  branch: bazi.getYearZhi()  },
      month: { stem: bazi.getMonthGan(), branch: bazi.getMonthZhi() },
      day:   { stem: bazi.getDayGan(),   branch: bazi.getDayZhi()   },
      hour:  { stem: bazi.getTimeGan(),  branch: bazi.getTimeZhi()  }
    };
  } catch (e) {
    console.error('BaZi calculation error:', e.message);
    throw new Error('Could not calculate pillars');
  }
}

// ── Claude API ────────────────────────────────────────────────
async function claude(system, messages, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('環境變數中找不到 ANTHROPIC_API_KEY');
  console.log('Claude 金鑰長度:', key.length);
  const r = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system, messages },
    { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 120000 }
  );
  return { text: r.data.content[0].text };
}

// ── Lemon Squeezy ─────────────────────────────────────────────
async function validateLS(licenseKey) {
  try {
    const r = await axios.post(
      'https://api.lemonsqueezy.com/v1/licenses/validate',
      { license_key: licenseKey.trim() },
      { headers: { 'Authorization': `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    return r.data.valid === true;
  } catch (e) {
    console.error('LS 驗證失敗:', e.response?.status, e.response?.data);
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
  } catch (e) {
    if (e.response?.status !== 400 && e.response?.status !== 422) {
      console.warn('LS 激活警告:', e.response?.status, e.response?.data?.error || e.message);
    }
  }
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

// ── Routes ────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    anthropic_key: !!process.env.ANTHROPIC_API_KEY,
    ls_key: !!process.env.LEMONSQUEEZY_API_KEY,
    key_length: process.env.ANTHROPIC_API_KEY?.length || 0,
    redis_connected: redisClient ? redisClient.isOpen : false
  });
});

app.post('/api/pillars', (req, res) => {
  try {
    const { year, month, day, hour, minute } = req.body;
    const pillars = calcPillars(+year, +month, +day, +(hour||12), +(minute||0));
    res.json({ ok: true, pillars });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Validate key
app.post('/api/key', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'No key' });

  const valid = await validateLS(key);
  if (!valid) return res.status(401).json({ error: 'Invalid license key — please check and try again' });

  activateLS(key).catch(e => console.warn('背景激活失敗:', e.message));

  const state = await getKeyState(key);
  res.json({
    ok: true,
    reportUsed: state.reportUsed,
    remainingQuestions: state.remainingQuestions
  });
});

// Generate report — 1 per key
app.post('/api/report', async (req, res) => {
  const { key, pillars, gender, birthYear } = req.body;
  if (!key || !pillars || !gender || !birthYear) return res.status(400).json({ error: 'Missing fields' });

  const state = await getKeyState(key);
  if (state.reportUsed) return res.status(402).json({ error: 'Report already used. Each key includes 1 reading.' });

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
    await markReportUsed(key);
    res.json({ ok: true, report: result.text, remainingQuestions: state.remainingQuestions });
  } catch (e) {
    console.error('Report error:', e.message);
    res.status(500).json({ error: 'Generation failed: ' + (e.response?.data?.error?.message || e.message) });
  }
});

// Ask question — max 10 per key
app.post('/api/ask', async (req, res) => {
  const { key, question, pillars, gender, birthYear, history } = req.body;
  if (!key || !question) return res.status(400).json({ error: 'Missing fields' });

  const state = await getKeyState(key);
  if (state.questions >= MAX_QUESTIONS) {
    return res.status(402).json({ error: `You've used all ${MAX_QUESTIONS} questions. Get a new reading at easternsoulfpath.com` });
  }

  try {
    const ctx = pillars ? `\n\nCHART: ${chartContext(pillars, gender, +birthYear)}` : '';
    const messages = [...(history||[]).slice(-12), { role:'user', content: question }];
    const result = await claude(SYSTEM + ctx, messages, 1200);
    const remaining = await incrementQuestion(key);
    res.json({ ok: true, answer: result.text, remainingQuestions: remaining });
  } catch (e) {
    console.error('Ask error:', e.message);
    res.status(500).json({ error: 'Failed: ' + e.message });
  }
});

// Image reading
app.post('/api/image', upload.single('image'), async (req, res) => {
  const { key } = req.body;
  if (!key || !req.file) return res.status(400).json({ error: 'Missing key or image' });

  const state = await getKeyState(key);
  if (state.reportUsed) return res.status(402).json({ error: 'Report already used' });

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
    res.json({ ok: true, pillars });
  } catch (e) {
    res.status(500).json({ error: 'Image read failed: ' + e.message });
  }
});

app.listen(PORT, () => console.log(`🌿 ESP 服務已成功執行於埠號 :${PORT}`));
