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
const cron = require('node-cron');
const nodemailer = require('nodemailer');

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
mercadopago.configure({
  access_token: 'APP_USR-1051520557198491-080611-741663b12c0895c6b8f9f252eee04bbf-268303205'
});

// Configuração do Nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'zaplitebrasil@gmail.com',
    pass: 'nuaocpeyfdcgtzds'
  }
});

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

cron.schedule('0 0 * * *', async () => { // Executa diariamente à meia-noite
  console.log('Checking for expired subscriptions...');
  const client = await pool.connect();
  try {
    const result = await client.query('UPDATE users SET subscription_status = $1 WHERE expiration_date < NOW()', ['expired']);
    console.log(`${result.rowCount} subscriptions updated to expired.`);
  } catch (err) {
    console.error('Error updating expired subscriptions:', err);
  } finally {
    client.release();
  }
});

// Função de autenticação
const authenticate = async (req, res, next) => {
  const { userId } = req.body;
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT subscription_status FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];
    if (user && user.subscription_status === 'active') {
      next();
    } else {
      res.status(403).json({ success: false, message: 'Subscription expired or invalid' });
    }
  } catch (err) {
    console.error('Authentication error:', err);
    res.status(500).json({ success: false, message: 'Authentication error' });
  } finally {
    client.release();
  }
};

// Função de envio de email
const sendEmail = (to, subject, text) => {
  console.log(`Enviando email para ${to}...`);
  const mailOptions = {
    from: 'contato.zaplite@gmail.com', // Seu email
    to,
    subject,
    text
  };
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('Erro ao enviar email:', error);
    } else {
      console.log('Email enviado:', info.response);
    }
  });
};


app.post('/create-checkout-session', async (req, res) => {
  const { username, name, phone, email, password, plan } = req.body;
  console.log('Received data:', req.body);

  if (username && name && phone && email && password && plan) {
    const hashedPassword = await bcrypt.hash(password, 10);
    const client = await pool.connect();

    try {
      // Verificar se o email já existe
      const emailCheck = await client.query('SELECT * FROM users WHERE email = $1', [email]);
      if (emailCheck.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'Email already registered' });
      }

      const result = await client.query(
        'INSERT INTO users (username, name, phone, email, password, subscription_status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [username, name, phone, email, hashedPassword, 'pending']
      );

      const userId = result.rows[0].id;
      const reference = `${userId}_${new Date().getTime()}`;

      let price;
      let expirationDate = new Date();
      switch (plan) {
        case 'monthly':
          price = 29.90;
          expirationDate.setMonth(expirationDate.getMonth() + 1);
          break;
        case 'quarterly':
          price = 79.90;
          expirationDate.setMonth(expirationDate.getMonth() + 3);
          break;
        case 'semiannually':
          price = 149.90;
          expirationDate.setMonth(expirationDate.getMonth() + 6);
          break;
        case 'annually':
          price = 299.90;
          expirationDate.setFullYear(expirationDate.getFullYear() + 1);
          break;
        default:
          price = 29.90;
          expirationDate.setMonth(expirationDate.getMonth() + 1);
      }

      await client.query('UPDATE users SET expiration_date = $1 WHERE id = $2', [expirationDate, userId]);

      const preference = {
        items: [
          {
            title: `Plano ${plan}`,
            quantity: 1,
            currency_id: 'BRL',
            unit_price: price
          }
        ],
        back_urls: {
          success: `https://zaplite.com.br/success.html?reference=${reference}`,
          failure: `https://zaplite.com.br/failure.html`
        },
        auto_return: 'approved',
        external_reference: reference,
        notification_url: 'https://zaplite.com.br/webhook'
      };

      const response = await mercadopago.preferences.create(preference);

      res.json({ success: true, paymentLink: response.body.init_point });
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


app.post('/create-renewal-checkout-session', async (req, res) => {
  console.log('/create-renewal-checkout-session endpoint hit');
  const { userId, plan } = req.body;
  console.log('Received data:', req.body); // Logando os dados recebidos

  if (userId && plan) {
    const client = await pool.connect();
    try {
      const userResult = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
      const user = userResult.rows[0];
      if (!user) {
        return res.status(400).json({ success: false, message: 'User not found' });
      }

      const reference = `${userId}_${new Date().getTime()}`;

      let price;
      let expirationDate = new Date();
      switch (plan) {
        case 'monthly':
          price = 29.90;
          expirationDate.setMonth(expirationDate.getMonth() + 1);
          break;
        case 'quarterly':
          price = 79.90;
          expirationDate.setMonth(expirationDate.getMonth() + 3);
          break;
        case 'semiannually':
          price = 149.90;
          expirationDate.setMonth(expirationDate.getMonth() + 6);
          break;
        case 'annually':
          price = 299.90;
          expirationDate.setFullYear(expirationDate.getFullYear() + 1);
          break;
        default:
          price = 29.90;
          expirationDate.setMonth(expirationDate.getMonth() + 1);
      }

      console.log('Expiration date set to:', expirationDate);

      const preference = {
        items: [
          {
            title: `Plano ${plan}`,
            quantity: 1,
            currency_id: 'BRL',
            unit_price: price
          }
        ],
        back_urls: {
          success: `https://zaplite.com.br/success.html?reference=${reference}`,
          failure: `https://zaplite.com.br/failure.html`
        },
        auto_return: 'approved',
        external_reference: reference,
        notification_url: 'https://zaplite.com.br/webhook'
      };

      console.log('Creating MercadoPago preference:', preference);

      const response = await mercadopago.preferences.create(preference);
      console.log('MercadoPago response:', response);

      res.json({ success: true, paymentLink: response.body.init_point });
    } catch (err) {
      console.error('Error creating renewal session:', err);
      res.status(500).json({ success: false, message: 'Error creating renewal session' });
    } finally {
      client.release();
    }
  } else {
    res.status(400).json({ success: false, message: 'User ID and plan are required' });
  }
});


app.post('/get-expiration-date', authenticate, async (req, res) => {
  const { userId } = req.body;
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT expiration_date FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      throw new Error('No user found with the provided userId');
    }
    res.status(200).json({ success: true, expirationDate: result.rows[0].expiration_date });
  } catch (err) {
    console.error('Error getting expiration date:', err);
    res.status(500).json({ success: false, message: 'Error getting expiration date' });
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
      if (user.subscription_status === 'active') {
        res.status(200).json({ success: true, userId: user.id });
      } else {
        res.status(403).json({ success: false, message: 'Subscription expired', expiration_date: user.expiration_date });
      }
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

app.post('/set-prompt', authenticate, async (req, res) => {
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

app.post('/get-prompt', authenticate, async (req, res) => {
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

app.post('/start-bot', authenticate, (req, res) => {
  console.log('Received request to start bot');
  const { userId } = req.body;
  startBot(userId);
  res.json({ success: true });
});

app.post('/stop-bot', authenticate, (req, res) => {
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
app.post('/webhook', express.json(), async (req, res) => {
  console.log('Webhook received:', req.body);

  const { type, data } = req.body;
  
  if (type === 'payment') {
    const paymentId = data.id;

    try {
      const payment = await mercadopago.payment.findById(paymentId);
      const status = payment.body.status;
      const externalReference = payment.body.external_reference;
      const userId = externalReference.split('_')[0];

      if (status === 'approved') {
        handlePaymentSuccess(userId);
      } else if (status === 'rejected') {
        handlePaymentFailure(userId);
      }
    } catch (err) {
      console.error('Error handling webhook:', err);
      return res.status(500).send(`Webhook Error: ${err.message}`);
    }
  }

  res.sendStatus(200);
});

app.post('/verify-subscription', async (req, res) => {
  const { userId } = req.body;
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT subscription_status, expiration_date FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];
    if (user && user.subscription_status === 'active') {
      res.json({ success: true, active: true });
    } else {
      res.json({ success: true, active: false });
    }
  } catch (err) {
    console.error('Error verifying subscription:', err);
    res.status(500).json({ success: false, message: 'Error verifying subscription' });
  } finally {
    client.release();
  }
});

const handlePaymentSuccess = async (userId) => {
  const client = await pool.connect();
  try {
    // Atualizar o status da assinatura para "active"
    await client.query('UPDATE users SET subscription_status = $1 WHERE id = $2', ['active', userId]);
    console.log(`User ${userId} subscription activated.`);

    // Obter o email do usuário
    const result = await client.query('SELECT email FROM users WHERE id = $1', [userId]);
    if (result.rows.length > 0) {
      const userEmail = result.rows[0].email;

      // Enviar email de confirmação
      sendEmail(userEmail, 'Subscription Activated', 'Your subscription has been activated. You can now access the platform.');
      console.log(`Confirmation email sent to ${userEmail}`);
    } else {
      console.error('User not found for sending email.');
    }

  } catch (err) {
    console.error('Error updating subscription status or sending email:', err);
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
