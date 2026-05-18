require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const jwt = require('jsonwebtoken');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const resend = new Resend(process.env.RESEND_API_KEY);

// SSE clients map: code -> res
const sseClients = {};

// ── Middleware ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') return next();
  express.json()(req, res, next);
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Sounds enum ─────────────────────────────────────────────────────────────
const VALID_SOUNDS = ['croissant', 'fart', 'coincoin', 'bruh', 'chipmunk', 'windowsxp', 'sadtrombone', 'nokia'];

// ── DB init ──────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS codes (
      id SERIAL PRIMARY KEY,
      code VARCHAR(10) UNIQUE NOT NULL,
      status VARCHAR(20) DEFAULT 'waiting',
      pack_size INTEGER NOT NULL,
      email VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      launched_at TIMESTAMPTZ,
      terminated_at TIMESTAMPTZ
    )
  `);
  console.log('DB ready');
}

// ── Code generator ───────────────────────────────────────────────────────────
function generateCode() {
  const letters = 'ABCDEFGHJKLMNPQRTUVWXYZ';
  const digits = '234678';
  let code = '';
  for (let i = 0; i < 2; i++) code += letters[Math.floor(Math.random() * letters.length)];
  for (let i = 0; i < 3; i++) code += digits[Math.floor(Math.random() * digits.length)];
  return code;
}

async function createUniqueCode(packSize, email) {
  let code, inserted = false;
  while (!inserted) {
    code = generateCode();
    try {
      await pool.query(
        'INSERT INTO codes (code, pack_size, email) VALUES ($1, $2, $3)',
        [code, packSize, email]
      );
      inserted = true;
    } catch (e) {
      if (!e.message.includes('unique')) throw e;
    }
  }
  return code;
}

// ── Magic Link ───────────────────────────────────────────────────────────────
function generateMagicLink(email) {
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '30d' });
  return `${process.env.FRONTEND_URL}/dashboard?token=${token}`;
}

async function sendMagicLink(email, codes) {
  const magicLink = generateMagicLink(email);
  const codeList = codes.map(c => `<li style="font-size:20px;font-weight:bold;letter-spacing:2px">${c}</li>`).join('');

  await resend.emails.send({
    from: 'Pranko.lol <hello@pranko.lol>',
    to: email,
    subject: '🥐 Your cheat code is ready',
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:auto;padding:32px">
        <h1 style="font-size:24px">🥐 Your colleague's PC is waiting.</h1>
        <p>Your code${codes.length > 1 ? 's' : ''}:</p>
        <ul style="background:#f5f5f5;padding:20px 32px;border-radius:8px">${codeList}</ul>
        <p style="color:red;font-weight:bold">⚠️ Single-use code — do NOT test it on your own Mac</p>
        <a href="${magicLink}" style="display:inline-block;background:#000;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:16px;margin-top:16px">
          Access my codes →
        </a>
      </div>
    `
  });
}

// ── Auto-destroy for a specific code ────────────────────────────────────────
async function scheduleAutoDestroy(code) {
  setTimeout(async () => {
    try {
      const result = await pool.query("SELECT status FROM codes WHERE code = $1", [code]);
      if (!result.rows[0] || result.rows[0].status === 'done') return;

      const client = sseClients[code];
      if (client) {
        client.write(`data: {"action":"stop"}\n\n`);
        delete sseClients[code];
      }
      await pool.query(
        "UPDATE codes SET status = 'done', terminated_at = NOW() WHERE code = $1",
        [code]
      );
      console.log(`Auto-destroyed: ${code}`);
    } catch (e) {
      console.error(`Auto-destroy error for ${code}:`, e);
    }
  }, 30 * 60 * 1000); // 30 minutes from first launch
}

// ── Shell script generator ───────────────────────────────────────────────────
function generateScript(code) {
  const soundVars = VALID_SOUNDS.map(s =>
    `${s.toUpperCase()}_URL="${process.env.R2_BASE_URL}/${s}.mp3"`
  ).join('\n');

  const downloadCmds = VALID_SOUNDS.map(s =>
    `curl -sf "$${s.toUpperCase()}_URL" -o "$TMP_DIR/${s}.mp3" &`
  ).join('\n');

  return `#!/bin/bash
# pranko.lol — ${code}

${soundVars}

SIGNAL_URL="${process.env.BASE_URL}/events/${code}"
TMP_DIR="/tmp/pranko_${code}"
mkdir -p "$TMP_DIR"

# Download sounds in background
${downloadCmds}
wait

cleanup() {
  rm -rf "$TMP_DIR"
  open "${process.env.FRONTEND_URL}/gg"
  exit 0
}

# Listen for signals via SSE
curl -sf -N "$SIGNAL_URL" | while IFS= read -r line; do
  if echo "$line" | grep -q '"action":"play"'; then
    SOUND=$(echo "$line" | sed 's/.*"sound":"\\([^"]*\\)".*/\\1/')
    if [ -f "$TMP_DIR/$SOUND.mp3" ]; then
      afplay "$TMP_DIR/$SOUND.mp3" &
    fi
  elif echo "$line" | grep -q '"action":"say"'; then
    TEXT=$(echo "$line" | sed 's/.*"text":"\\([^"]*\\)".*/\\1/')
    say "$TEXT" &
  elif echo "$line" | grep -q '"action":"stop"'; then
    cleanup
  fi
done

cleanup
`;
}

// ── ENDPOINTS ────────────────────────────────────────────────────────────────

// GET /:code — injection point, returns shell script
app.get('/:code([A-Z]{2}[0-9]{3})', async (req, res) => {
  const { code } = req.params;
  try {
    const result = await pool.query('SELECT * FROM codes WHERE code = $1', [code]);
    if (result.rows.length === 0 || result.rows[0].status !== 'waiting') {
      return res.type('text/plain').send('#!/bin/bash\necho "Invalid code." >&2\nexit 0');
    }
    await pool.query(
      'UPDATE codes SET status = $1, activated_at = NOW() WHERE code = $2',
      ['active', code]
    );
    res.type('text/plain').send(generateScript(code));
  } catch (e) {
    console.error(e);
    res.type('text/plain').send('#!/bin/bash\nexit 0');
  }
});

// GET /events/:code — SSE stream (dormance)
app.get('/events/:code', (req, res) => {
  const { code } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients[code] = res;

  // Heartbeat every 25s to prevent Render from closing idle connections
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    delete sseClients[code];
  });
});

// POST /launch/:code — send play or say signal
app.post('/launch/:code', async (req, res) => {
  const { code } = req.params;
  const { sound, text } = req.body;

  const client = sseClients[code];
  if (!client) return res.status(404).json({ error: 'Script not connected' });

  // On first launch: mark as launched and schedule auto-destroy
  const result = await pool.query('SELECT status FROM codes WHERE code = $1', [code]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Code not found' });

  if (result.rows[0].status === 'active') {
    await pool.query(
      "UPDATE codes SET status = 'launched', launched_at = NOW() WHERE code = $1",
      [code]
    );
    scheduleAutoDestroy(code);
  }

  if (sound) {
    if (!VALID_SOUNDS.includes(sound)) return res.status(400).json({ error: 'Invalid sound' });
    client.write(`data: {"action":"play","sound":"${sound}"}\n\n`);
  } else if (text) {
    // Sanitize: alphanumeric + basic punctuation only, max 200 chars
    const clean = text
      .replace(/[^a-zA-Z0-9àâäéèêëîïôùûüçÀÂÄÉÈÊËÎÏÔÙÛÜÇ .,!?'"-]/g, '')
      .slice(0, 200);
    client.write(`data: {"action":"say","text":"${clean}"}\n\n`);
  } else {
    return res.status(400).json({ error: 'Missing sound or text' });
  }

  res.json({ ok: true });
});

// POST /stop/:code — kill switch
app.post('/stop/:code', async (req, res) => {
  const { code } = req.params;
  const client = sseClients[code];
  if (client) {
    client.write(`data: {"action":"stop"}\n\n`);
    delete sseClients[code];
  }
  await pool.query(
    "UPDATE codes SET status = 'done', terminated_at = NOW() WHERE code = $1",
    [code]
  );
  res.json({ ok: true });
});

// GET /status/:code — dashboard polling
app.get('/status/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const result = await pool.query(
      'SELECT status, activated_at, launched_at, terminated_at FROM codes WHERE code = $1',
      [code]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const row = result.rows[0];
    res.json({
      status: row.status,
      connected: !!sseClients[code],
      activatedAt: row.activated_at,
      launchedAt: row.launched_at,
      terminatedAt: row.terminated_at
    });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /dashboard — validate magic link token, return codes
app.get('/dashboard', async (req, res) => {
  const { token } = req.query;
  try {
    const { email } = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      'SELECT code, status, pack_size, activated_at, launched_at FROM codes WHERE email = $1 ORDER BY created_at DESC',
      [email]
    );
    res.json({ email, codes: result.rows });
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// GET /gg — redirect to frontend reveal page
app.get('/gg', (req, res) => {
  res.redirect(process.env.FRONTEND_URL + '/gg');
});

// POST /webhook — Stripe
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    return res.status(400).send(`Webhook error: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email;
    const packSize = parseInt(session.metadata?.packSize) || 2;

    try {
      const codes = [];
      for (let i = 0; i < packSize; i++) {
        const code = await createUniqueCode(packSize, email);
        codes.push(code);
      }
      await sendMagicLink(email, codes);
      console.log(`Created ${packSize} codes for ${email}`);
    } catch (e) {
      console.error('Error creating codes:', e);
    }
  }

  res.json({ received: true });
});

// ── Start ────────────────────────────────────────────────────────────────────
// POST /create-checkout-session — Stripe Checkout
app.post('/create-checkout-session', async (req, res) => {
  const { priceId, packSize } = req.body;

  const VALID_PRICE_IDS = [
    process.env.STRIPE_PRICE_X2,
    process.env.STRIPE_PRICE_X5
  ];

  if (!VALID_PRICE_IDS.includes(priceId)) {
    return res.status(400).json({ error: 'Invalid price ID' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { packSize: String(packSize) },
      customer_email: undefined,
      success_url: `${process.env.FRONTEND_URL}/success`,
      cancel_url: `${process.env.FRONTEND_URL}`,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe session error:', e);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Pranko backend running on port ${PORT}`));
});
