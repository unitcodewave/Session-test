const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store active sessions
const sessions = new Map();

class WhatsAppBot {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.sock = null;
        this.isConnected = false;
    }

    async initialize() {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(`./auth_info_${this.sessionId}`);
            const { version } = await fetchLatestBaileysVersion();
            
            this.sock = makeWASocket({
                version,
                logger: pino({ level: 'silent' }),
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
                },
                browser: ['Chrome', 'Windows', '10.0.0'],
            });

            this.sock.ev.on('creds.update', saveCreds);
            this.sock.ev.on('connection.update', this.handleConnectionUpdate.bind(this));
            this.sock.ev.on('messages.upsert', this.handleMessages.bind(this));

            return this.sock;
        } catch (error) {
            console.error('Initialization error:', error);
            throw error;
        }
    }

    handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`QR for ${this.sessionId}:`, qr);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed for ${this.sessionId}, reconnecting:`, shouldReconnect);
            
            if (shouldReconnect) {
                this.initialize();
            } else {
                this.isConnected = false;
                sessions.delete(this.sessionId);
            }
        } else if (connection === 'open') {
            console.log(`Connected for ${this.sessionId}`);
            this.isConnected = true;
            
            // Send credentials to the bot number itself
            this.sendCredentials();
        }
    }

    async handleMessages(m) {
        if (!m.messages || m.type !== 'notify') return;
        
        const message = m.messages[0];
        if (!message.message) return;

        const text = message.message.conversation || 
                    message.message.extendedTextMessage?.text || 
                    message.message.imageMessage?.caption || '';

        const sender = message.key.remoteJid;
        
        console.log(`Message from ${sender}: ${text}`);

        // Handle pairing command
        if (text.startsWith('!pair')) {
            await this.handlePairCommand(sender, text);
        }

        // Handle other commands
        if (text.startsWith('!')) {
            await this.handleCommand(sender, text);
        }
    }

    async handlePairCommand(sender, text) {
        const parts = text.split(' ');
        if (parts.length < 2) {
            await this.sock.sendMessage(sender, { text: 'Please provide your number: !pair 1234567890' });
            return;
        }

        const phoneNumber = parts[1].replace(/\D/g, '');
        const targetJid = `${phoneNumber}@s.whatsapp.net`;

        try {
            // Send credentials file content
            await this.sendCredentialsToNumber(targetJid);
            await this.sock.sendMessage(sender, { 
                text: `✅ Credentials sent to ${phoneNumber}\n\nSession ID: ${this.sessionId}\nStatus: Paired successfully!` 
            });
        } catch (error) {
            console.error('Pairing error:', error);
            await this.sock.sendMessage(sender, { 
                text: `❌ Failed to send credentials to ${phoneNumber}` 
            });
        }
    }

    async sendCredentials() {
        try {
            const credsPath = path.join(__dirname, `auth_info_${this.sessionId}`, 'creds.json`);
            if (fs.existsSync(credsPath)) {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
                const botJid = this.sock.user?.id;
                
                if (botJid) {
                    await this.sock.sendMessage(botJid, { 
                        text: `🤖 *BOT CREDENTIALS*\n\n` +
                              `Session ID: ${this.sessionId}\n` +
                              `Connected: ${this.isConnected}\n` +
                              `Phone: ${creds.me?.id || 'N/A'}\n` +
                              `Platform: ${creds.platform || 'Web'}\n\n` +
                              `Use !pair <number> to share credentials`
                    });
                }
            }
        } catch (error) {
            console.error('Error sending credentials:', error);
        }
    }

    async sendCredentialsToNumber(targetJid) {
        try {
            const credsPath = path.join(__dirname, `auth_info_${this.sessionId}`, 'creds.json');
            if (fs.existsSync(credsPath)) {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
                
                await this.sock.sendMessage(targetJid, { 
                    text: `🔐 *SESSION CREDENTIALS*\n\n` +
                          `Session ID: ${this.sessionId}\n` +
                          `Phone: ${creds.me?.id || 'N/A'}\n` +
                          `Platform: ${creds.platform || 'Web'}\n` +
                          `Expires: ${new Date(creds.account?.accountExpiry * 1000).toLocaleDateString() || 'Unknown'}\n\n` +
                          `_Keep these credentials secure!_`
                });

                // Send credentials as file
                await this.sock.sendMessage(targetJid, {
                    document: fs.readFileSync(credsPath),
                    fileName: `creds-${this.sessionId}.json`,
                    mimetype: 'application/json'
                });
            }
        } catch (error) {
            console.error('Error sending credentials to number:', error);
            throw error;
        }
    }

    async handleCommand(sender, text) {
        const command = text.toLowerCase().split(' ')[0];
        
        switch (command) {
            case '!hello':
                await this.sock.sendMessage(sender, { text: '👋 Hello! I am your WhatsApp bot.' });
                break;
            case '!status':
                await this.sock.sendMessage(sender, { 
                    text: `📊 *BOT STATUS*\n\n` +
                          `Session: ${this.sessionId}\n` +
                          `Connected: ${this.isConnected}\n` +
                          `Uptime: ${process.uptime().toFixed(0)}s` 
                });
                break;
            case '!help':
                await this.sock.sendMessage(sender, { 
                    text: `🛠 *AVAILABLE COMMANDS*\n\n` +
                          `!pair <number> - Pair with another number\n` +
                          `!status - Check bot status\n` +
                          `!hello - Greet the bot\n` +
                          `!help - Show this help message` 
                });
                break;
        }
    }
}

// API Routes
app.post('/api/session/start', async (req, res) => {
    try {
        const { sessionId = 'default' } = req.body;
        
        if (sessions.has(sessionId)) {
            return res.json({ 
                success: true, 
                message: 'Session already exists',
                sessionId 
            });
        }

        const bot = new WhatsAppBot(sessionId);
        await bot.initialize();
        sessions.set(sessionId, bot);

        res.json({ 
            success: true, 
            message: 'Session started successfully',
            sessionId 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.post('/api/session/pair', async (req, res) => {
    try {
        const { sessionId, phoneNumber } = req.body;
        
        if (!sessions.has(sessionId)) {
            return res.status(404).json({ 
                success: false, 
                error: 'Session not found' 
            });
        }

        const bot = sessions.get(sessionId);
        const targetJid = `${phoneNumber.replace(/\D/g, '')}@s.whatsapp.net`;
        
        await bot.sendCredentialsToNumber(targetJid);

        res.json({ 
            success: true, 
            message: `Credentials sent to ${phoneNumber}` 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/api/sessions', (req, res) => {
    const sessionList = Array.from(sessions.entries()).map(([id, bot]) => ({
        sessionId: id,
        isConnected: bot.isConnected
    }));
    
    res.json({ sessions: sessionList });
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>CodeWave Unit Force ID - WhatsApp Bot</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; }
                .container { max-width: 800px; margin: 0 auto; }
                .card { background: #f5f5f5; padding: 20px; margin: 10px 0; border-radius: 8px; }
                button { background: #25D366; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 CodeWave Unit Force ID</h1>
                <p>WhatsApp Bot Pairing System</p>
                
                <div class="card">
                    <h3>Start New Session</h3>
                    <button onclick="startSession()">Start Session</button>
                </div>
                
                <div class="card">
                    <h3>Pair with Number</h3>
                    <input type="text" id="phoneNumber" placeholder="Phone number (with country code)" style="padding: 8px; width: 200px;">
                    <button onclick="pairNumber()">Pair Number</button>
                </div>
                
                <div id="status"></div>
            </div>

            <script>
                async function startSession() {
                    const response = await fetch('/api/session/start', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId: 'codewave-unit-force' })
                    });
                    
                    const data = await response.json();
                    document.getElementById('status').innerHTML = 
                        `<div class="card"><strong>Status:</strong> ${data.message}</div>`;
                }

                async function pairNumber() {
                    const phoneNumber = document.getElementById('phoneNumber').value;
                    if (!phoneNumber) {
                        alert('Please enter a phone number');
                        return;
                    }

                    const response = await fetch('/api/session/pair', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            sessionId: 'codewave-unit-force', 
                            phoneNumber 
                        })
                    });
                    
                    const data = await response.json();
                    document.getElementById('status').innerHTML = 
                        `<div class="card"><strong>Pairing:</strong> ${data.message || data.error}</div>`;
                }
            </script>
        </body>
        </html>
    `);
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Web Interface: http://localhost:${PORT}`);
    console.log(`🤖 Project: CodeWave Unit Force ID`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    sessions.clear();
    process.exit(0);
});