const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const redis   = require('redis');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 建立 Redis 客戶端與防禦連線機制 ──────────────────────────
const REDIS_URL = process.env.REDIS_URL;
let redisClient = null;
let useRedis = false;

if (REDIS_URL) {
  console.log('📡 偵測到 REDIS_URL，正在嘗試初始化 Redis...');
  redisClient = redis.createClient({ url: REDIS_URL });
  
  redisClient.on('error', (err) => {
    console.error('❌ Redis 客戶端錯誤 (將降級使用本地記憶體):', err.message);
    useRedis = false;
  });

  redisClient.connect()
    .then(() => {
      console.log('🚀 成功連線至 Railway Redis 資料庫');
      useRedis = true;
    })
    .catch((err) => {
      console.error('❌ Redis 連線失敗 (將降級使用本地記憶體):', err.message);
      useRedis = false;
    });
} else {
  console.warn('⚠️ 未偵測到 REDIS_URL 環境變數，系統採用本地檔案資料庫模式運作。');
}

// ── 檔案型備用資料庫（當 Redis 斷線或未設定時的備援方案） ──────────
const DATA_FILE = path.join(__dirname, 'budget_store.json');
let localStore = new Map();

function loadLocalStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      localStore = new Map(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    }
  } catch (e) { console.error('備援資料庫載入失敗:', e.message); }
}
function saveLocalStore() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify([...localStore.entries()]), 'utf8'); } catch (e) { }
}
loadLocalStore();

// ── 非同步額度控制機制（動態切換 Redis / 備援磁碟） ──────────
async function getBudget(k) {
  if (useRedis && redisClient?.isOpen) {
    try {
      const raw = await redisClient.get(`budget:${k}`);
      const spent = raw ? parseFloat(raw) : 0;
      return { spent, remaining: +(0.75 - spent).toFixed(4), ok: spent < 0.75 };
    } catch (e) { console.error('Redis 讀取異常，切換至備援機制'); }
  }
  const b = localStore.get(k) || { spent: 0 };
  return { spent: b.spent, remaining: +(0.75 - b.spent).toFixed(4), ok: b.spent < 0.75 };
}

async function addSpend(k, c) {
  if (useRedis && redisClient?.isOpen) {
    try {
      const current = await getBudget(k);
      const newSpent = +(current.spent + c).toFixed(6);
      await redisClient.set(`budget:${k}`, String(newSpent));
      return { spent: newSpent, remaining: +(0.75 - newSpent).toFixed(4), ok: newSpent < 0.75 };
    } catch (e) { console.error('Redis 寫入異常，切換至備援機制'); }
  }
  const b = localStore.get(k) || { spent: 0 };
  b.spent = +(b.spent + c).toFixed(6);
  localStore.set(k, b);
  saveLocalStore();
  return { spent: b.spent, remaining: +(0.75 - b.spent).toFixed(4), ok: b.spent < 0.75 };
}

// ── Webhook 隔離處理（獨立 Raw 解析） ─────────────────────────
app.post('/webhook/lemonsqueezy', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const sig  = req.headers['x-signature'];
    const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';
    
    if (!secret) {
      console.error('❌ 錯誤: 遺失 LEMONSQUEEZY_WEBHOOK_SECRET 環境變數');
      return res.status(500).end();
    }

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(req.body);
    
    if (!sig || sig !== hmac.digest('hex')) {
      console.warn('⚠️ Webhook 簽章不符，拒絕請求');
      return res.status(401).end();
    }

    const p = JSON.parse(req.body.toString());
    if (p.meta?.event_name === 'order_created') {
      console.log('✅ 驗證成功！收到 Lemon Squeezy 新訂單:', p.data?.id);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Webhook 處理失敗:', e.message);
    res.status(500).end();
  }
});

// ── 中間件配置（與 Webhook 路由完全分流） ───────────────────────
app.use(express.json({ limit: '10mb' }));

// 🎯 修正：將靜態檔案目錄精準指向 public/ 資料夾
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Helpers ───────────────────────────────────────────────────
function cost(i, o) { return (i / 1000) * 0.003 + (o / 1000) * 0.015; }

async function claude(system, messages, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('環境變數中找不到 ANTHROPIC_API_KEY');
  console.log('Claude 金鑰檢查長度:', key.length);

  const r = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system, messages },
    { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 120000 }
  );
  return { text: r.data.content[0].text, cost: cost(r.data.usage.input_tokens, r.data.usage.output_tokens) };
}

async function validateLS(licenseKey) {
  try {
    const r = await axios.post(
      'https://api.lemonsqueezy.com/v1/licenses/validate',
      { license_key: licenseKey.trim() },
      { headers: { 'Authorization': `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    return r.data.valid === true;
  } catch (e) {
    console.error('LS 驗證 API 失敗:', e.response?.status, e.response?.data);
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
      console.warn('LS 激活警告 (可忽略):', e.response?.status, e.response?.data?.error || e.message);
    }
  }
}

// ── System Prompt & BaZi 演算 ─────────────────────────────────
const SYSTEM = `You are a warm, wise Eastern life navigation guide for Eastern Soul Path.
"I help you read the map, but you choose the road."
TONE: Warm, grounding, non-scary. Like a trusted friend with ancient wisdom.
Never say: bad luck, cursed, dangerous, doomed, worst year, disaster.
Instead use: tension pattern, extra mindful, supportive cycle, mindful period.
Respond in English.`;

function chartContext(pillars, gender, birthYear) {
  const M = { '甲':'Wood+','乙':'Wood-','丙':'Fire+','丁':'Fire-','戊':'Earth+','己':'Earth-','庚':'Metal+','辛':'Metal-','壬':'Water+','癸':'Water-','子':'Rat','丑':'Ox','寅':'Tiger','卯':'Rabbit','辰':'Dragon','巳':'Snake','午':'Horse','未':'Goat','申':'Monkey','酉':'Rooster','戌':'Dog','亥':'Pig' };
  const e = s => `${s}(${M[s]||s})`;
  return `Gender: ${gender} | Birth Year: ${birthYear} | Age: ~${new Date().getFullYear()-birthYear}
Pillars — Hour: ${e(pillars.hour.stem)}/${e(pillars.hour.branch)} | Day: ${e(pillars.day.stem)}/${e(pillars.day.branch)} | Month: ${e(pillars.month.stem)}/${e(pillars.month.branch)} | Year: ${e(pillars.year.stem)}/${e(pillars.year.branch)}`;
}

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

// ── 路由控制（全面支援 async/await） ────────────────────────────

// 🎯 修正：強制將首頁根路由導向 public 資料夾內的 index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
    const { year, month, day, hour } = req.body;
    res.json({ ok: true, pillars: calcPillars(+year, +month, +day, +(hour||12)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/key', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'No key' });

  const valid = await validateLS(key);
  if (!valid) return res.status(401).json({ error: 'Invalid license key — please check and try again' });

  activateLS(key).catch(e => console.warn('背景激活失敗:', e.message));

  const b = await getBudget(key);
  res.json({ ok: true, remaining: b.remaining });
});

app.post('/api/report', async (req, res) => {
  const { key, pillars, gender, birthYear } = req.body;
  if (!key || !pillars || !gender || !birthYear) return res.status(400).json({ error: 'Missing fields' });
  
  const b = await getBudget(key);
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
    const budget = await addSpend(key, result.cost);
    res.json({ ok: true, report: result.text, remaining: budget.remaining });
  } catch (e) {
    console.error('Report error:', e.message);
    res.status(500).json({ error: 'Generation failed: ' + (e.response?.data?.error?.message || e.message) });
  }
});

app.post('/api/ask', async (req, res) => {
  const { key, question, pillars, gender, birthYear, history } = req.body;
  if (!key || !question) return res.status(400).json({ error: 'Missing fields' });
  
  const b = await getBudget(key);
  if (!b.ok) return res.status(402).json({ error: 'Credit used up. Get a new reading at easternsoulfpath.com' });

  try {
    const ctx = pillars ? `\n\nCHART: ${chartContext(pillars, gender, +birthYear)}` : '';
    const messages = [...(history||[]).slice(-10), { role:'user', content: question }];
    const result = await claude(SYSTEM + ctx, messages, 1200);
    const budget = await addSpend(key, result.cost);
    res.json({ ok: true, answer: result.text, remaining: budget.remaining });
  } catch (e) {
    console.error('Ask error:', e.message);
    res.status(500).json({ error: 'Failed: ' + e.message });
  }
});

app.post('/api/image', upload.single('image'), async (req, res) => {
  const { key } = req.body;
  if (!key || !req.file) return res.status(400).json({ error: 'Missing key or image' });
  
  const b = await getBudget(key);
  if (!b.ok) return res.status(402).json({ error: 'Credit used up' });

  try {
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-20250514', max_tokens: 300, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: req.file.mimetype, data: req.file.buffer.toString('base64') } },
        { type: 'text', text: 'Extract BaZi four pillars. Return JSON only: {"hour":{"stem":"X","branch":"X"},"day":{"stem":"X","branch":"X"},"month":{"stem":"X","branch":"X"},"year":{"stem":"X","branch":"X"}}' }
      ]}] },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 }
    );
    const text = r.data.content[0].text;
    const pillars = JSON.parse(text.replace(/```json\n?/g,'').replace(/
```/g,'').trim());
    const c = cost(r.data.usage.input_tokens, r.data.usage.output_tokens);
    const budget = await addSpend(key, c);
    res.json({ ok: true, pillars, remaining: budget.remaining });
  } catch (e) {
    res.status(500).json({ error: 'Image read failed: ' + e.message });
  }
});

app.listen(PORT, () => console.log(`🌿 ESP 全端服務已成功執行於埠號 :${PORT}`));
