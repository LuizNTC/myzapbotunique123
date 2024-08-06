const express = require('express');
const { create, Whatsapp } = require('venom-bot');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');
const axios = require('axios');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const mercadopago = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;
let wss;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const apiKey = "AIzaSyBbNTFE9gMdzBHtW5yfPV6SLeLmHbyG8_I"; // Adicione sua chave de API aqui
const requestQueue = [];
let isProcessingQueue = false;
const sessions = {};

console.log('Initializing server...');

// Configuração do MercadoPago
mercadopago.configurations = {
  access_token: 'APP_USR-1051520557198491-080611-741663b12c0895c6b8f9f252eee04bbf-268303205'
};

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'", "'unsafe-inline'", "https://stackpath.bootstrapcdn.com", "https://cdnjs.cloudflare.com"],
        "img-src": ["'self'", "data:", "https:"],
      },
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // Middleware para JSON

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
  console.log('Route / accessed');
});

app.post('/register', async (req, res) => {
  const { username, name, phone, email, password, plan } = req.body;
  console.log('/register endpoint hit');
  console.log('Received data:', req.body);

  if (username && name && phone && email && password && plan) {
    const client = await pool.connect();
    try {
      const emailCheck = await client.query('SELECT * FROM users WHERE email = $1', [email]);
      if (emailCheck.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'Email already registered' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const result = await client.query(
        'INSERT INTO users (username, name, phone, email, password, subscription_status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [username, name, phone, email, hashedPassword, 'pending']
      );

      const userId = result.rows[0].id;
      const reference = `${userId}_${new Date().getTime()}`;

      const preference = {
        items: [
          {
            title: `Plano ${plan}`,
            unit_price: plan === 'monthly' ? 29.90 : plan === 'quarterly' ? 79.90 : plan === 'semiannually' ? 149.90 : 299.90,
            quantity: 1,
          },
        ],
        external_reference: reference,
        notification_url: 'https://zaplite.com.br/webhook',
        back_urls: {
          success: `https://zaplite.com.br/success.html?reference=${reference}`,
          failure: 'https://zaplite.com.br/failure.html',
          pending: 'https://zaplite.com.br/pending.html',
        },
        auto_return: 'approved',
      };

      const response = await mercadopago.preferences.create(preference);
      const paymentLink = response.body.init_point;

      res.json({ success: true, paymentLink });
    } catch (err) {
      console.error('Error registering user:', err);
      res.status(500).json({ success: false, message: 'Error registering user' });
    } finally {
      client.release();
    }
  } else {
    res.status(400).json({ success: false, message: 'All fields are required' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (user && await bcrypt.compare(password, user.password)) {
      if (user.subscription_status === 'inactive') {
        return res.status(401).json({ success: false, message: 'Subscription inactive. Please renew your plan.' });
      }
      res.status(200).json({ success: true, userId: user.id });
    } else {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('Error logging in user:', err);
    res.status(500).json({ success: false, message: 'Error logging in user' });
  } finally {
    client.release();
  }
});

app.post('/set-prompt', async (req, res) => {
  const { userId, prompt } = req.body;
  const client = await pool.connect();
  try {
    await client.query('UPDATE users SET prompt = $1 WHERE id = $2', [prompt, userId]);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error setting prompt:', err);
    res.status(500).json({ success: false, message: 'Error setting prompt' });
  } finally {
    client.release();
  }
});

app.post('/get-prompt', async (req, res) => {
  const { userId } = req.body;
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT prompt FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      throw new Error('No user found with the provided userId');
    }
    res.status(200).json({ success: true, prompt: result.rows[0].prompt });
  } catch (err) {
    console.error('Error getting prompt:', err);
    res.status(500).json({ success: false, message: 'Error getting prompt' });
  } finally {
    client.release();
  }
});

app.post('/start-bot', (req, res) => {
  console.log('Received request to start bot');
  const { userId } = req.body;
  startBot(userId);
  res.json({ success: true });
});

app.post('/stop-bot', (req, res) => {
  console.log('Received request to stop bot');
  const { userId } = req.body;
  stopBot(userId);
  res.json({ success: true });
});

const cleanSession = (sessionName) => {
  const sessionDir = path.join(__dirname, 'tokens', sessionName);
  if (fs.existsSync(sessionDir)) {
    fs.rmdirSync(sessionDir, { recursive: true });
    console.log(`Previous session ${sessionName} removed.`);
  }
};

const processQueue = () => {
  if (isProcessingQueue || requestQueue.length === 0) return;

  const { client, message, prompt } = requestQueue.shift();

  console.log(`Processing message from ${message.from}`);

  const tryRequest = (retries) => {
    const session = sessions[message.from] || { history: [] };
    session.history.push(`Cliente: ${message.body}`);

    const fullPrompt = `${prompt}\n\nHistórico da conversa:\n${session.history.join('\n')}`;

    console.log(`Sending prompt to API: ${fullPrompt}`);

    axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`, {
      "contents": [{"parts": [{"text": fullPrompt}]}]
    })
    .then((response) => {
      console.log('API response:', response.data);

      if (response.data && response.data.candidates && response.data.candidates[0] && response.data.candidates[0].content) {
        const contentParts = response.data.candidates[0].content.parts;
        const reply = contentParts.map(part => part.text).join("\n");
        console.log('Gemini response:', reply);

        session.history.push(`IA: ${reply}`);
        sessions[message.from] = session;

        client.sendText(message.from, reply)
          .then(() => {
            console.log('Message sent successfully');
            isProcessingQueue = false;
            processQueue();
          })
          .catch((err) => {
            console.log('Error sending message:', err);
            isProcessingQueue = false;
            processQueue();
          });
      } else {
        throw new Error('Unexpected response structure');
      }
    })
    .catch((err) => {
      if (err.response && err.response.status === 429 && retries > 0) {
        console.log(`Error 429 received. Retrying in 10 seconds... (${retries} retries left)`);
        setTimeout(() => tryRequest(retries - 1), 10000);
      } else {
        console.log('Error calling Gemini API:', err.message || err);
        isProcessingQueue = false;
        processQueue();
      }
    });
  };

  tryRequest(3);
};

const startBot = async (userId) => {
  const sessionName = `session_${userId}`;
  cleanSession(sessionName);
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT prompt FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      throw new Error('No user found with the provided userId');
    }
    const prompt = result.rows[0].prompt || "Default prompt";
    
    create(
      sessionName,
      (base64Qr, asciiQR) => {
        console.log('QR Code generated, scan with your WhatsApp:');
        console.log(asciiQR);
        if (wss) {
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ status: 'qr_code', data: base64Qr }));
              console.log('Sent QR Code to client');
            }
          });
        }
      },
      undefined,
      {
        headless: true,
        useChrome: true,
        browserArgs: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      }
    )
      .then((client) => {
        sessions[sessionName] = client;
        console.log(`WhatsApp connected successfully for user ${userId}!`);
        if (wss) {
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ status: 'connected' }));
              console.log('Sent connected status to client');
            }
          });
        }

        client.onMessage((message) => {
          console.log('Message received:', message.body);
          requestQueue.push({ client, message, prompt });
          processQueue();
        });
      })
      .catch((err) => {
        console.error('Error connecting to WhatsApp:', err.message);
      });
  } catch (err) {
    console.error('Error getting prompt:', err);
  } finally {
    client.release();
  }
};

const stopBot = (userId) => {
  const sessionName = `session_${userId}`;
  if (sessions[sessionName]) {
    sessions[sessionName].close().then(() => {
      console.log(`WhatsApp session closed successfully for user ${userId}!`);
      delete sessions[sessionName];
      cleanSession(sessionName);
    }).catch(err => {
      console.error('Error closing WhatsApp session:', err.message);
    });
  } else {
    console.log(`No active WhatsApp session to stop for user ${userId}`);
  }
};

const server = app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log('Routes are configured as follows:');
  app._router.stack.forEach((middleware) => {
    if (middleware.route) { // Routes registered diretamente no app
      console.log(middleware.route);
    } else if (middleware.name === 'router') { // Middleware de roteador
      middleware.handle.stack.forEach((handler) => {
        if (handler.route) {
          console.log(handler.route);
        }
      });
    }
  });
});

wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ status: 'connected_to_server' }));
  console.log('WebSocket client connected');
});

// Webhook para MercadoPago
app.post('/webhook', express.json(), (req, res) => {
  console.log('Webhook received:', req.body);

  const payment = req.body;

  if (payment.type === 'payment' && payment.action === 'payment.created') {
    handlePaymentSuccess(payment.data.id);
  } else if (payment.type === 'payment' && payment.action === 'payment.updated') {
    if (payment.data.status === 'approved') {
      handlePaymentSuccess(payment.data.id);
    } else if (payment.data.status === 'rejected') {
      handlePaymentFailure(payment.data.id);
    }
  }

  res.sendStatus(200);
});

const handlePaymentSuccess = async (paymentId) => {
  const client = await pool.connect();
  try {
    const result = await mercadopago.payment.findById(paymentId);
    const userId = result.response.external_reference.split('_')[0];
    await client.query('UPDATE users SET subscription_status = $1 WHERE id = $2', ['active', userId]);
    console.log(`User ${userId} subscription activated.`);
  } catch (err) {
    console.error('Error updating subscription status:', err);
  } finally {
    client.release();
  }
};

const handlePaymentFailure = async (paymentId) => {
  const client = await pool.connect();
  try {
    const result = await mercadopago.payment.findById(paymentId);
    const userId = result.response.external_reference.split('_')[0];
    await client.query('UPDATE users SET subscription_status = $1 WHERE id = $2', ['inactive', userId]);
    console.log(`User ${userId} subscription deactivated.`);
  } catch (err) {
    console.error('Error updating subscription status:', err);
  } finally {
    client.release();
  }};
