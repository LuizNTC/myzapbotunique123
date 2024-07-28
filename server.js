const express = require('express');
const { create } = require('venom-bot');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
let clientInstance;
let wss;

let users = []; // Simulação de banco de dados de usuários

console.log('Initializing server...');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // Middleware para JSON

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
  console.log('Route / accessed');
});

app.post('/register', (req, res) => {
  console.log('Received request to register:', req.body);
  const { username, password } = req.body;
  if (username && password) {
    users.push({ username, password });
    console.log('User registered:', username);
    res.status(201).json({ success: true });
  } else {
    console.log('Registration failed: Username and password are required');
    res.status(400).json({ success: false, message: 'Username and password are required' });
  }
});

app.post('/login', (req, res) => {
  console.log('Received request to login:', req.body);
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);
  if (user) {
    console.log('Login successful for user:', username);
    res.status(200).json({ success: true });
  } else {
    console.log('Login failed: Invalid credentials');
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

app.post('/start-bot', (req, res) => {
  console.log('Received request to start bot');
  cleanSession();
  create(
    'session_name',
    (base64Qr, asciiQR) => {
      console.log('QR Code generated, scan with your WhatsApp:');
      console.log(asciiQR);
      if (wss) {
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ status: 'qr_code', data: base64Qr }));
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
        '--single-process', // <- isso não funciona no Windows
        '--disable-gpu'
      ]
    }
  )
    .then((client) => {
      clientInstance = client;
      console.log('WhatsApp connected successfully!');
      if (wss) {
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ status: 'connected' }));
          }
        });
      }

      client.onMessage((message) => {
        console.log('Message received:', message.body);
      });
    })
    .catch((err) => {
      console.error('Error connecting to WhatsApp:', err.message);
    });
  res.json({ success: true });
});

const cleanSession = () => {
  const sessionDir = path.join(__dirname, 'session_name');
  if (fs.existsSync(sessionDir)) {
    fs.rmdirSync(sessionDir, { recursive: true });
    console.log('Previous session removed.');
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
