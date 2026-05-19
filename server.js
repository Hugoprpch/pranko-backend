require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const jwt = require('jsonwebtoken');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const resend = new Resend(process.env.RESEND_API_KEY);

// SSE clients map (Mac script): code -> res
const sseClients = {};

// SSE dashboard clients map: code -> Set of res
const dashboardClients = {};

// Notify all dashboard listeners for a code of a status change
function notifyDashboard(code, status) {
  const clients = dashboardClients[code];
  if (!clients) return;
  clients.forEach(res => res.write(`data: ${JSON.stringify({ status })}\n\n`));
}

// ── Middleware ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') return next();
  express.json()(req, res, next);
});

const ALLOWED_ORIGINS = [
  'https://pranko.lol',
  'https://www.pranko.lol',
  'https://app.pranko.lol'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
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

// ── Email templates ──────────────────────────────────────────────────────────
function emailCheatCode(codes, magicLink) {
  const codeList = codes.map(c => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #f0f0f0">
        <span style="font-family:monospace;font-size:28px;font-weight:700;letter-spacing:6px;color:#000">${c}</span>
      </td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08)">
        <tr>
          <td style="background:#FFD000;padding:24px 32px">
            <p style="margin:0;font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#000">pranko.lol</p>
            <h1 style="margin:8px 0 0;font-size:26px;font-weight:800;color:#000;line-height:1.2">Your colleague's Mac<br>is waiting. 🥐</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px">
            <p style="margin:0 0 8px;font-size:14px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.08em">Your code${codes.length > 1 ? 's' : ''}</p>
            <table width="100%" cellpadding="0" cellspacing="0">${codeList}</table>
            <p style="margin:24px 0 8px;font-size:14px;color:#e53e3e;font-weight:600">⚠️ Single-use — do NOT test on your own Mac</p>
            <p style="margin:0 0 28px;font-size:14px;color:#666;line-height:1.5">Each code works once. The script runs silently for 30 minutes, then deletes itself.</p>
            <table cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td align="center">
                  <a href="${magicLink}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:16px 32px;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:0.02em">
                    Access my dashboard →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:24px 0 0;font-size:12px;color:#999;text-align:center;line-height:1.5">
              Keep this email — it's your only way back to your codes.<br>
              Questions? <a href="mailto:hello@pranko.lol" style="color:#999">hello@pranko.lol</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9f9f9;padding:16px 32px;border-top:1px solid #f0f0f0">
            <p style="margin:0;font-size:12px;color:#bbb;text-align:center">pranko.lol — Made with regrettable enthusiasm in Paris</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function emailMagicLink(magicLink) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08)">
        <tr>
          <td style="background:#FFD000;padding:24px 32px">
            <p style="margin:0;font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#000">pranko.lol</p>
            <h1 style="margin:8px 0 0;font-size:26px;font-weight:800;color:#000;line-height:1.2">Back for more? 🥐</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px">
            <p style="margin:0 0 28px;font-size:16px;color:#333;line-height:1.5">Here's your dashboard link. All your codes are waiting.</p>
            <table cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td align="center">
                  <a href="${magicLink}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:16px 32px;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:0.02em">
                    Access my codes →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:24px 0 0;font-size:12px;color:#999;text-align:center;line-height:1.5">
              This link expires in 30 days.<br>
              Questions? <a href="mailto:hello@pranko.lol" style="color:#999">hello@pranko.lol</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9f9f9;padding:16px 32px;border-top:1px solid #f0f0f0">
            <p style="margin:0;font-size:12px;color:#bbb;text-align:center">pranko.lol — Made with regrettable enthusiasm in Paris</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Magic Link ───────────────────────────────────────────────────────────────
function generateMagicLink(email) {
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '30d' });
  return `${process.env.FRONTEND_URL}/dashboard?token=${token}`;
}

async function sendMagicLink(email, codes) {
  const magicLink = generateMagicLink(email);
  await resend.emails.send({
    from: 'Pranko.lol <hello@app.pranko.lol>',
    to: email,
    subject: '🥐 Your cheat code is ready',
    html: emailCheatCode(codes, magicLink)
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
      notifyDashboard(code, 'done');
      console.log(`Auto-destroyed: ${code}`);
    } catch (e) {
      console.error(`Auto-destroy error for ${code}:`, e);
    }
  }, 30 * 60 * 1000);
}

// ── Shell script generator ───────────────────────────────────────────────────
function generateScript(code) {
  const downloadCmds = VALID_SOUNDS.map(s =>
    `curl -sf "${process.env.R2_BASE_URL}/${s}.mp3" -o "$TMP_DIR/${s}.mp3" &`
  ).join('\n');

  const workerScript = `#!/bin/bash
TMP_DIR="/tmp/pranko_${code}"
SIGNAL_URL="${process.env.BASE_URL}/events/${code}"

cleanup() {
  rm -rf "\$TMP_DIR"
  open "https://pranko.lol/gg"
  exit 0
}

curl -sf -N "\$SIGNAL_URL" | while IFS= read -r line; do
  if echo "\$line" | grep -q '"action":"play"'; then
    SOUND=\$(echo "\$line" | sed 's/.*"sound":"\\([^"]*\\)".*/\\1/')
    [ -f "\$TMP_DIR/\$SOUND.mp3" ] && afplay "\$TMP_DIR/\$SOUND.mp3" &
  elif echo "\$line" | grep -q '"action":"say"'; then
    TEXT=\$(echo "\$line" | sed 's/.*"text":"\\([^"]*\\)".*/\\1/')
    say "\$TEXT" &
  elif echo "\$line" | grep -q '"action":"stop"'; then
    cleanup
  fi
done
rm -rf "$TMP_DIR"
exit 0
`;

  return `#!/bin/bash
# pranko.lol — ${code}
TMP_DIR="/tmp/pranko_${code}"
mkdir -p "\$TMP_DIR"

# Write worker script
cat > "\$TMP_DIR/worker.sh" << 'PRANKO_EOF'
${workerScript}PRANKO_EOF

chmod +x "\$TMP_DIR/worker.sh"

# Download sounds in background
${downloadCmds}
wait

# Launch worker detached from terminal
nohup "\$TMP_DIR/worker.sh" > "\$TMP_DIR/pranko.log" 2>&1 &

# Close terminal window
osascript -e 'tell application "Terminal" to close front window' & exit
`;
}

// ── ENDPOINTS ────────────────────────────────────────────────────────────────

// Script injection — transitions waiting -> active
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
    notifyDashboard(code, 'active');
    res.type('text/plain').send(generateScript(code));
  } catch (e) {
    console.error(e);
    res.type('text/plain').send('#!/bin/bash\nexit 0');
  }
});

// SSE for Mac script
app.get('/events/:code', (req, res) => {
  const { code } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients[code] = res;
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    delete sseClients[code];
  });
});

// SSE for dashboard — real-time status updates, no polling needed
app.get('/watch/:code', (req, res) => {
  const { code } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  if (!dashboardClients[code]) dashboardClients[code] = new Set();
  dashboardClients[code].add(res);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    dashboardClients[code].delete(res);
    if (dashboardClients[code].size === 0) delete dashboardClients[code];
  });
});

// Launch sound or TTS — transitions active -> launched
app.post('/launch/:code', async (req, res) => {
  const { code } = req.params;
  const { sound, text } = req.body;
  const client = sseClients[code];
  if (!client) return res.status(404).json({ error: 'Script not connected' });
  const result = await pool.query('SELECT status FROM codes WHERE code = $1', [code]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Code not found' });
  if (result.rows[0].status === 'active') {
    await pool.query(
      "UPDATE codes SET status = 'launched', launched_at = NOW() WHERE code = $1",
      [code]
    );
    notifyDashboard(code, 'launched');
    scheduleAutoDestroy(code);
  }
  if (sound) {
    if (!VALID_SOUNDS.includes(sound)) return res.status(400).json({ error: 'Invalid sound' });
    client.write(`data: {"action":"play","sound":"${sound}"}\n\n`);
  } else if (text) {
    const clean = text
      .replace(/[^a-zA-Z0-9àâäéèêëîïôùûüçÀÂÄÉÈÊËÎÏÔÙÛÜÇ .,!?'"-]/g, '')
      .slice(0, 200);
    client.write(`data: {"action":"say","text":"${clean}"}\n\n`);
  } else {
    return res.status(400).json({ error: 'Missing sound or text' });
  }
  res.json({ ok: true });
});

// Stop — transitions any -> done
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
  notifyDashboard(code, 'done');
  res.json({ ok: true });
});

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

app.get('/gg', (req, res) => {
  res.redirect('https://pranko.lol/gg');
});

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

app.post('/resend-magic-link', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const result = await pool.query(
      'SELECT email FROM codes WHERE email = $1 LIMIT 1',
      [email]
    );
    if (result.rows.length === 0) {
      return res.json({ ok: true });
    }
    const magicLink = generateMagicLink(email);
    await resend.emails.send({
      from: 'Pranko.lol <hello@app.pranko.lol>',
      to: email,
      subject: '🥐 Your dashboard link',
      html: emailMagicLink(magicLink)
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Resend magic link error:', e);
    res.status(500).json({ error: 'Failed to send link' });
  }
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Pranko backend running on port ${PORT}`));
});
