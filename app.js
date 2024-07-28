const venom = require("venom-bot");
const axios = require("axios");
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

let clientInstance;
let wss;

const sessionDir = path.join(__dirname, 'session_general'); // Diretório da sessão

const cleanSession = () => {
    // Remove arquivos da sessão antiga, se existirem
    if (fs.existsSync(sessionDir)) {
        fs.rmdirSync(sessionDir, { recursive: true });
        console.log('Sessão anterior removida.');
    }
};

const start = () => {
    cleanSession(); // Limpa a sessão antes de criar uma nova conexão

    venom.create({
        session: `session_general`,
        multidevice: true,
        headless: true // Executar em segundo plano
    }, (base64Qr, asciiQR) => {
        console.log("QR Code gerado, escaneie com seu WhatsApp:");
        console.log(asciiQR);
        if (wss) {
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ status: 'qr_code', data: base64Qr }));
                }
            });
        }
    })
    .then(client => {
        clientInstance = client;
        console.log("WhatsApp conectado com sucesso!");
        if (wss) {
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ status: 'connected' }));
                }
            });
        }

        client.onMessage((message) => {
            console.log('Mensagem recebida:', message.body);
            requestQueue.push({ client, message });
            processQueue();
        });
    })
    .catch(err => {
        console.error('Erro ao conectar com o WhatsApp:', err.message);
    });
};

const apiKey = "YOUR_API_KEY_HERE"; // Adicione sua chave de API aqui
const requestQueue = [];
let isProcessingQueue = false;

const sessions = {};

const basePromptParts = [
    "Você é o atendente da marca Greenplay, o GreenBOT, com os dados de acesso greenplay o cliente pode utilizar sua lista de Canais, Filmes e Séries no aplicativo que bem quiser, parte totalmente da sua preferência mesmo.",
];

const processQueue = () => {
    if (isProcessingQueue || requestQueue.length === 0) return;

    const { client, message } = requestQueue.shift();

    console.log(`Processando mensagem de ${message.from}`);

    const tryRequest = (retries) => {
        const session = sessions[message.from] || { history: [] };
        session.history.push(`Cliente: ${message.body}`);

        const fullPrompt = `${basePromptParts.join('\n')}\n\nHistórico da conversa:\n${session.history.join('\n')}`;

        console.log(`Enviando prompt para API: ${fullPrompt}`);

        axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`, {
            "contents": [{"parts": [{"text": fullPrompt}]}]
        })
        .then((response) => {
            console.log('Resposta completa da API:', response.data);

            if (response.data && response.data.candidates && response.data.candidates[0] && response.data.candidates[0].content) {
                const contentParts = response.data.candidates[0].content.parts;
                const reply = contentParts.map(part => part.text).join("\n");
                console.log('Resposta do Gemini:', reply);

                session.history.push(`IA: ${reply}`);
                sessions[message.from] = session;

                client.sendText(message.from, reply)
                    .then(() => {
                        console.log('Mensagem enviada com sucesso');
                        isProcessingQueue = false;
                        processQueue();
                    })
                    .catch((err) => {
                        console.log('Erro ao enviar mensagem:', err);
                        isProcessingQueue = false;
                        processQueue();
                    });
            } else {
                throw new Error('Estrutura da resposta inesperada');
            }
        })
        .catch((err) => {
            if (err.response && err.response.status === 429 && retries > 0) {
                console.log(`Erro 429 recebido. Tentando novamente em 10 segundos... (${retries} tentativas restantes)`);
                setTimeout(() => tryRequest(retries - 1), 10000);
            } else {
                console.log('Erro ao chamar API do Gemini:', err.message || err);
                isProcessingQueue = false;
                processQueue();
            }
        });
    };

    tryRequest(3);
};

const setupWebSocket = (server) => {
    wss = new WebSocket.Server({ server });
    wss.on('connection', ws => {
        ws.send(JSON.stringify({ status: 'connected_to_server' }));
    });
};

module.exports = { start, setupWebSocket };
