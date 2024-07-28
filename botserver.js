const express = require('express');
const { create } = require('venom-bot');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
let clientInstance;
let wss;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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

wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ status: 'connected_to_server' }));
});
