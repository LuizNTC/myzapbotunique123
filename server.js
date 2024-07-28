const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { create } = require('venom-bot');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const users = [];

// Rota de registro
app.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (username && password) {
    users.push({ username, password });
    res.status(201).json({ success: true });
  } else {
    res.status(400).json({ success: false, message: 'Username and password are required' });
  }
});

// Rota de login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);
  if (user) {
    res.status(200).json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

app.post('/start-bot', (req, res) => {
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
      useChrome: false,
      browserArgs: ['--no-sandbox'],
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
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ status: 'connected_to_server' }));
});
