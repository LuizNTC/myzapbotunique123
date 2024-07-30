const express = require('express');
const { create } = require('venom-bot');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
let clientInstance;
let wss;

let users = []; // Simulação de banco de dados de usuários

const apiKey = "AIzaSyBbNTFE9gMdzBHtW5yfPV6SLeLmHbyG8_I"; // Adicione sua chave de API aqui
const requestQueue = [];
let isProcessingQueue = false;
const sessions = {};
const basePromptParts = [
  "Você é o atendente da marca Greenplay, o GreenBOT, com os dados de acesso greenplay o cliente pode utilizar sua lista de Canais, Filmes e Séries no aplicativo que bem quiser, parte totalmente da sua preferência mesmo.",
];

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
  startBot(); // Chama a função startBot ao acessar o endpoint
  res.json({ success: true });
});

const cleanSession = () => {
  const sessionDir = path.join(__dirname, 'session_name');
  if (fs.existsSync(sessionDir)) {
    fs.rmdirSync(sessionDir, { recursive: true });
    console.log('Previous session removed.');
  }
};

const processQueue = () => {
  if (isProcessingQueue || requestQueue.length === 0) return;

  const { client, message } = requestQueue.shift();

  console.log(`Processing message from ${message.from}`);

  const tryRequest = (retries) => {
    const session = sessions[message.from] || { history: [] };
    session.history.push(`Cliente: ${message.body}`);

    const fullPrompt = `${basePromptParts.join('\n')}\n\nHistórico da conversa:\n${session.history.join('\n')}`;

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

const startBot = () => {
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
      clientInstance = client;
      console.log('WhatsApp connected successfully!');
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
        requestQueue.push({ client, message });
        processQueue();
      });
    })
    .catch((err) => {
      console.error('Error connecting to WhatsApp:', err.message);
    });
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
