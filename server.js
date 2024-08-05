const express = require('express');
const { create, Whatsapp } = require('venom-bot');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');
const axios = require('axios');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const PagSeguro = require('pagseguro'); // Adicionando biblioteca do PagSeguro

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

// Configuração do PagSeguro
const pagseguro = new PagSeguro({
  email: 'luizgustavofmachado@gmail.com',
  token: 'A094CC2E7F684869B7BBA1D9E55DDE1E',
  mode: 'sandbox' // Modo de testes, troque para 'production' em produção
});

pagseguro.currency('BRL');

// Use Helmet para definir cabeçalhos de segurança, incluindo CSP
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
  const hashedPassword = await bcrypt.hash(password, 10);
  const reference = `${email}_${new Date().getTime()}`;

  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO users (username, name, phone, email, password, plan, reference, subscription_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [username, name, phone, email, hashedPassword, plan, reference, 'inactive']
    );

    pagseguro.addItem({
      id: plan,
      description: `Plano ${plan}`,
      amount: getPlanAmount(plan),
      quantity: 1
    });

    pagseguro.setRedirectURL(`https://your-domain.com/success.html?reference=${reference}`);
    pagseguro.setNotificationURL('https://your-domain.com/webhook');

    pagseguro.send((err, response) => {
      if (err) {
        console.log('Error creating checkout session:', err);
        return res.status(500).json({ success: false, message: 'Error creating checkout session' });
      }
      res.json({ success: true, paymentLink: response.redirect_url });
    });
  } catch (err) {
    console.error('Error registering user:', err);
    res.status(500).json({ success: false, message: 'Error registering user' });
  } finally {
    client.release();
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
  if (sessions[sessionName]) {
    console.log(`Bot already started for user ${userId}`);
    return;
  }

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
        useChrome: true, // Usar Chrome/Chromium
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

// Função para obter o valor do plano
const getPlanAmount = (plan) => {
  switch (plan) {
    case 'monthly':
      return '79.90';
    case 'quarterly':
      return '79.90';
    case 'semiannual':
      return '149.90';
    case 'annual':
      return '299.90';
    default:
      return '29.90';
  }
};

// Webhook para PagSeguro
app.post('/webhook', express.raw({ type: 'application/xml' }), (req, res) => {
  const notificationCode = req.body.notificationCode;

  pagseguro.notification(notificationCode, (err, notification) => {
    if (err) {
      console.log('Error handling notification:', err);
      return res.status(500).send(`Webhook Error: ${err.message}`);
    }

    const status = notification.status;
    const reference = notification.reference;
    const userId = reference.split('_')[0];

    if (status === '3') { // Pagamento confirmado
      handlePaymentSuccess(userId);
    } else if (status === '7') { // Pagamento cancelado
      handlePaymentFailure(userId);
    }

    res.sendStatus(200);
  });
});

const handlePaymentSuccess = async (userId) => {
  const client = await pool.connect();
  try {
    const subscriptionEnd = new Date();
    subscriptionEnd.setMonth(subscriptionEnd.getMonth() + 1); // Assumindo pagamento mensal
    await client.query('UPDATE users SET subscription_status = $1, subscription_end = $2 WHERE id = $3', ['active', subscriptionEnd, userId]);
    console.log(`User ${userId} subscription activated.`);
  } catch (err) {
    console.error('Error updating subscription status:', err);
  } finally {
    client.release();
  }
};

const handlePaymentFailure = async (userId) => {
  const client = await pool.connect();
  try {
    await client.query('UPDATE users SET subscription_status = $1 WHERE id = $2', ['inactive', userId]);
    console.log(`User ${userId} subscription deactivated.`);
  } catch (err) {
    console.error('Error updating subscription status:', err);
  } finally {
    client.release();
  }
};
