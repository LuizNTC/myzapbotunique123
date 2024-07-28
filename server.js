const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const { start, setupWebSocket } = require('./app'); // Importar a função start do app.js
const app = express();
const http = require('http');
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Para armazenar as credenciais dos usuários
const users = {};

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (users[username]) {
        return res.json({ success: false, message: 'Username already exists' });
    }
    users[username] = { password };
    return res.json({ success: true });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (users[username] && users[username].password === password) {
        return res.json({ success: true });
    }
    return res.json({ success: false });
});

app.post('/start-bot', (req, res) => {
    console.log('Tentando iniciar o bot...');
    try {
        start(); // Chama a função start do seu app.js
        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao iniciar o bot:', error);
        res.status(500).json({ success: false, error: 'Failed to start the bot' });
    }
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

setupWebSocket(server); // Configura o WebSocket

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
