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

cron.schedule('0 0 * * *', async () => {
  const client = await pool.connect();
  try {
    const expiredUsers = await client.query('SELECT id FROM users WHERE subscription_status = $1', ['expired']);
    expiredUsers.rows.forEach(user => {
      const sessionName = `session_${user.id}`;
      if (sessions[sessionName]) {
        sessions[sessionName].close().then(() => {
          console.log(`Session closed for expired user ${user.id}`);
          delete sessions[sessionName];
        }).catch(err => console.error(`Error closing session for expired user ${user.id}:`, err));
      }
    });
  } catch (err) {
    console.error('Error checking for expired sessions:', err);
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
const sendEmail = (to, subject, userName) => {
  const mailOptions = {
    from: 'contato.zaplite@gmail.com',
    to,
    subject,
    html: `
      <div style="background-color:#f7f7f7; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif; background-color: #ffffff; padding: 20px; border-radius: 10px;">
          <h2 style="color: #333333; text-align: center;">Sua assinatura foi ativada!</h2>
          <p style="color: #666666; text-align: center;">Olá ${userName},</p>
          <p style="color: #666666; text-align: center;">Estamos felizes em informar que sua assinatura foi ativada com sucesso. Agora você pode acessar a plataforma e aproveitar todos os nossos serviços.</p>
          <p style="color: #666666; text-align: center;">Obrigado por escolher ZapLite!</p>
          <div style="text-align: center;">
            <a href="https://zaplite.com.br/login.html" style="display: inline-block; padding: 10px 20px; color: #ffffff; background-color: #4CAF50; border-radius: 5px; text-decoration: none;">Acessar a Plataforma</a>
          </div>
          <p style="color: #999999; text-align: center; font-size: 12px; margin-top: 20px;">ZapLite | Todos os direitos reservados</p>
        </div>
      </div>
    `
  };
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('Erro ao enviar email:', error);
    } else {
      console.log('Email enviado:', info.response);
    }
  });
};

app.post('/get-user-info', async (req, res) => {
  const { userId } = req.body;
  const client = await pool.connect();

  try {
      const result = await client.query('SELECT name, username, phone, email FROM users WHERE id = $1', [userId]);
      if (result.rows.length === 0) {
          return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
      }
      const user = result.rows[0];
      res.status(200).json({ success: true, user });
  } catch (err) {
      console.error('Erro ao obter informações do usuário:', err);
      res.status(500).json({ success: false, message: 'Erro ao obter informações do usuário' });
  } finally {
      client.release();
  }
});

app.post('/update-user-info', async (req, res) => {
  const { userId, username, phone, email, newPassword } = req.body;
  const client = await pool.connect();

  try {
      let updateQuery = 'UPDATE users SET username = $1, phone = $2, email = $3';
      const updateValues = [username, phone, email];

      if (newPassword) {
          const hashedPassword = await bcrypt.hash(newPassword, 10);
          updateQuery += ', password = $4 WHERE id = $5';
          updateValues.push(hashedPassword, userId);
      } else {
          updateQuery += ' WHERE id = $4';
          updateValues.push(userId);
      }

      await client.query(updateQuery, updateValues);
      res.status(200).json({ success: true });
  } catch (err) {
      console.error('Erro ao atualizar informações do usuário:', err);
      res.status(500).json({ success: false, message: 'Erro ao atualizar informações do usuário' });
  } finally {
      client.release();
  }
});


app.post('/create-checkout-session', async (req, res) => {
  const { username, name, phone, email, password, plan, userId } = req.body;
  console.log('Received data:', req.body);

  if (userId && plan) {
    // Se userId e plan forem fornecidos, trata-se de uma renovação ou atualização de plano
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
      const user = result.rows[0];
      if (!user) {
        return res.status(400).json({ success: false, message: 'User not found' });
      }

      const reference = `${userId}_${new Date().getTime()}`;
      let price;
      let expirationDate = new Date();
      switch (plan) {
        case 'monthly':
          price = 5.00;  // Alterado para R$5,00
          expirationDate.setMonth(expirationDate.getMonth() + 1);
          break;
        case 'quarterly':
          price = 197.90;  // Alterado para R$197,90
          expirationDate.setMonth(expirationDate.getMonth() + 3);
          break;
        case 'semiannually':
          price = 373.80;  // Alterado para R$373,80
          expirationDate.setMonth(expirationDate.getMonth() + 6);
          break;
        case 'annually':
          price = 670.80;  // Alterado para R$670,80
          expirationDate.setFullYear(expirationDate.getFullYear() + 1);
          break;
        default:
          price = 5.00;  // Definido para R$5,00 como padrão durante os testes
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
      console.error('Error creating checkout session:', err);
      res.status(500).json({ success: false, message: 'Error creating checkout session' });
    } finally {
      client.release();
    }
  } else if (username && name && phone && email && password && plan) {
    // Nova inscrição
    const hashedPassword = await bcrypt.hash(password, 10);
    const client = await pool.connect();

    try {
      const emailCheck = await client.query('SELECT * FROM users WHERE email = $1', [email]);
      if (emailCheck.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'Email already registered' });
      }

      const result = await client.query(
        'INSERT INTO users (username, name, phone, email, password, subscription_status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [username, name, phone, email, hashedPassword, 'pending']
      );

      const newUserId = result.rows[0].id;
      const reference = `${newUserId}_${new Date().getTime()}`;
      let price;
      let expirationDate = new Date();
      switch (plan) {
        case 'monthly':
          price = 5.00;  // Alterado para R$5,00
          expirationDate.setMonth(expirationDate.getMonth() + 1);
          break;
        case 'quarterly':
          price = 197.90;  // Alterado para R$197,90
          expirationDate.setMonth(expirationDate.getMonth() + 3);
          break;
        case 'semiannually':
          price = 373.80;  // Alterado para R$373,80
          expirationDate.setMonth(expirationDate.getMonth() + 6);
          break;
        case 'annually':
          price = 670.80;  // Alterado para R$670,80
          expirationDate.setFullYear(expirationDate.getFullYear() + 1);
          break;
        default:
          price = 5.00;  // Definido para R$5,00 como padrão durante os testes
          expirationDate.setMonth(expirationDate.getMonth() + 1);
      }


      await client.query('UPDATE users SET expiration_date = $1 WHERE id = $2', [expirationDate, newUserId]);

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
  console.log('Received renewal request:', req.body);
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


app.post('/get-expiration-date', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ success: false, message: 'User ID is required' });
  }

  const client = await pool.connect();
  try {
    const result = await client.query('SELECT expiration_date FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const expirationDate = result.rows[0].expiration_date;
    return res.status(200).json({ success: true, expirationDate });
  } catch (err) {
    console.error('Error fetching expiration date:', err);
    return res.status(500).json({ success: false, message: 'Error fetching expiration date' });
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
      } else if (user.subscription_status === 'pending') {
        res.status(200).json({ success: true, userId: user.id, pending: true });
      } else if (user.subscription_status === 'expired') {
        res.status(200).json({ success: true, userId: user.id, expired: true });
      }
    } else {
      res.status(401).json({ success: false, message: 'Invalid credentials!' });
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
  console.log('Received request to start bot with userId:', req.body.userId);  // Adicionar log aqui
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

const processQueue = (sessionName) => {
  const queue = queues[sessionName];
  if (!queue || queue.length === 0) return;

  const { client, message, prompt } = queue.shift();

  console.log(`Processing message from ${message.from}`);

  const tryRequest = (retries) => {
      const session = sessions[message.from] || { history: [] };
      session.history.push(`Cliente: ${message.body}`);

      const fullPrompt = `${prompt}\n\nHistórico da conversa:\n${session.history.join('\n')}`;

      console.log(`Sending prompt to API: ${fullPrompt}`);

      axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`, {
          "contents": [{ "parts": [{ "text": fullPrompt }] }]
      }).then((response) => {
          console.log('API response:', response.data);

          if (response.data && response.data.candidates && response.data.candidates[0] && response.data.candidates[0].content) {
              const contentParts = response.data.candidates[0].content.parts;
              const reply = contentParts.map(part => part.text).join("\n");
              console.log('Gemini response:', reply);

              session.history.push(`IA: ${reply}`);
              sessions[message.from] = session;

              client.sendText(message.from, reply).then(() => {
                  console.log('Message sent successfully');
                  processQueue(sessionName); // Processar próxima mensagem na fila
              }).catch((err) => {
                  console.log('Error sending message:', err);
                  processQueue(sessionName); // Processar próxima mensagem na fila
              });
          } else {
              throw new Error('Unexpected response structure');
          }
      }).catch((err) => {
          if (err.response && err.response.status === 429 && retries > 0) {
              console.log(`Error 429 received. Retrying in 10 seconds... (${retries} retries left)`);
              setTimeout(() => tryRequest(retries - 1), 10000);
          } else {
              console.log('Error calling Gemini API:', err.message || err);
              processQueue(sessionName); // Processar próxima mensagem na fila
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

  // Limpeza da sessão anterior, se existir
  cleanSession(sessionName);

  const client = await pool.connect();
  try {
      // Obtenção do prompt do usuário
      const result = await client.query('SELECT prompt FROM users WHERE id = $1', [userId]);
      if (result.rows.length === 0) {
          throw new Error('No user found with the provided userId');
      }
      const prompt = result.rows[0].prompt || "Default prompt";

      console.log('Starting WhatsApp bot creation process...');

      // Criação da sessão do WhatsApp com o venom-bot
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
              headless: false, // Modificado para false para testes
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
      ).then((client) => {
          sessions[sessionName] = client;
          queues[sessionName] = []; // Criação da fila de mensagens para o usuário

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
              queues[sessionName].push({ client, message, prompt });
              processQueue(sessionName); // Processando a fila de mensagens para o usuário
          });
      }).catch((err) => {
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
      sendEmail(userEmail, 'Pagamento Recebido - ZapLite', 'Boas Novas');
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
