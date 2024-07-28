const express = require('express');
const venom = require('venom-bot');

let clientInstance;

const app = express();
app.use(express.json());

venom.create({
  session: 'session_general',
  multidevice: true,
  headless: true,
  browserArgs: ['--no-sandbox', '--disable-setuid-sandbox']
}).then(client => {
  clientInstance = client;
  console.log('WhatsApp conectado com sucesso!');
  client.onMessage(message => {
    console.log('Mensagem recebida:', message.body);
  });
});

app.post('/send-message', (req, res) => {
  const { to, message } = req.body;
  if (!clientInstance) {
    return res.status(500).json({ error: 'Bot not initialized' });
  }
  clientInstance.sendText(to, message)
    .then(response => {
      res.json({ success: true, response });
    })
    .catch(err => {
      res.status(500).json({ success: false, error: err.message });
    });
});

app.listen(3000, () => {
  console.log('Bot server is running on port 3000');
});
