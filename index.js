const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Variables globales
let sock;
let startTime = Date.now();
const adminJid = process.env.ADMIN_JID || 'TON_NUMERO@s.whatsapp.net'; // Ex: '24176209643@s.whatsapp.net'
const channelLink = 'https://whatsapp.com/channel/TON_LIEN_CHANNEL'; // Remplace par ton vrai lien channel WhatsApp

// Fonction de log qui émet aussi via Socket.io pour real-time
function log(message, type = 'info') {
  console.log(`[${type.toUpperCase()}] ${new Date().toLocaleString()}: ${message}`);
  io.emit('log', { time: new Date().toLocaleString(), type, message });
}

// Config bot
async function connectToWhatsApp(phoneNumber = null) {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: state,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      log('Connexion perdue, reconnexion...', 'error');
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      log('Connecté à WhatsApp ! Bot prêt.', 'success');
      io.emit('status', { connected: true });
    }
  });

  let pairingCode = null;
  if (phoneNumber) {
    try {
      pairingCode = await sock.requestPairingCode(phoneNumber);
      log(`Code de pairing généré pour ${phoneNumber}: ${pairingCode}`, 'info');
    } catch (error) {
      log(`Erreur génération code pairing: ${error.message}`, 'error');
    }
  }

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message) return;
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim().toLowerCase();
    const sender = msg.key.remoteJid;
    log(`Message reçu de ${sender}: ${text}`, 'message');

    let response = '';
    let args = text.split(' ').slice(1); // Pour commandes avec arguments

    switch (text.split(' ')[0]) {
      case 'ping': {
        const latency = Date.now() - msg.messageTimestamp * 1000;
        response = `Pong ! 🏓 Latence: ${latency}ms`;
        break;
      }
      case 'salut': {
        const user = msg.pushName || 'utilisateur';
        response = `Bonjour ${user} ! Comment ça va ? 😊`;
        break;
      }
      case 'aide':
      case 'help': {
        response = `Commandes disponibles :\n- ping: Test latence\n- salut: Greeting personnalisé\n- channel: Lien de mon channel WhatsApp\n- uptime: Temps en ligne\n- weather [ville]: Météo (simulation)\n- quote: Citation random\n- broadcast [message]: (Admin only) Envoyer à tous`;
        break;
      }
      case 'channel': {
        response = `Rejoins mon channel WhatsApp : ${channelLink}`;
        break;
      }
      case 'uptime': {
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        response = `Bot en ligne depuis ${uptime} secondes.`;
        break;
      }
      case 'weather': {
        const city = args[0] || 'Paris';
        // Simulation API (ajoute axios pour vrai OpenWeather API si besoin)
        response = `Météo à ${city} : Ensoleillé, 20°C (simulation).`;
        break;
      }
      case 'quote': {
        // Simulation random quote
        const quotes = ['La vie est belle.', 'Carpe diem.', 'Think big.'];
        response = quotes[Math.floor(Math.random() * quotes.length)];
        break;
      }
      case 'broadcast': {
        if (sender !== adminJid) {
          response = 'Commande admin only.';
          break;
        }
        const broadcastMsg = args.join(' ');
        // Exemple : Envoie à un groupe ou contacts (adapte avec sock.groupMetadata ou liste)
        response = `Broadcast envoyé : ${broadcastMsg} (implémentation simulation).`;
        log(`Broadcast par admin: ${broadcastMsg}`, 'admin');
        break;
      }
      default: {
        if (text) response = 'Commande inconnue. Essaie "aide".';
        break;
      }
    }

    if (response) {
      await sock.sendMessage(sender, { text: response });
      log(`Réponse envoyée à ${sender}: ${response}`, 'response');
    }
  });

  return pairingCode;
}

// Route principale : Dashboard
app.get('/', (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>Dashboard Bot WhatsApp</h1>
        <p>Status : <span id="status">Vérification...</span></p>
        <a href="/pair">Pairer un appareil</a> | <a href="/logs">Voir logs en temps réel</a>
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          socket.on('status', (data) => {
            document.getElementById('status').innerText = data.connected ? 'Connecté' : 'Déconnecté';
          });
        </script>
      </body>
    </html>
  `);
});

// Route pour pairing
app.get('/pair', (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>Pairer ton bot</h1>
        <form action="/pair" method="post">
          <label>Numéro (international sans +) :</label><br>
          <input type="text" name="number" placeholder="ex: 24176209643" required><br><br>
          <button type="submit">Générer code</button>
        </form>
      </body>
    </html>
  `);
});

app.post('/pair', async (req, res) => {
  const phoneNumber = req.body.number.trim();
  if (!phoneNumber || !/^\d+$/.test(phoneNumber)) {
    return res.send('Numéro invalide.');
  }
  try {
    const pairingCode = await connectToWhatsApp(phoneNumber);
    res.send(`
      <html>
        <body>
          <h1>Code généré</h1>
          <p>Code : <strong>${pairingCode}</strong></p>
          <p>Entre-le dans WhatsApp > Appareils connectés.</p>
        </body>
      </html>
    `);
  } catch (error) {
    res.send('Erreur. Réessaie.');
  }
});

// Route pour logs real-time
app.get('/logs', (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>Logs en temps réel</h1>
        <div id="logs" style="border:1px solid #ccc; padding:10px; height:400px; overflow-y:scroll;"></div>
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          socket.on('log', (data) => {
            const logDiv = document.getElementById('logs');
            logDiv.innerHTML += `<p><strong>[${data.time}] ${data.type.toUpperCase()}:</strong> ${data.message}</p>`;
            logDiv.scrollTop = logDiv.scrollHeight;
          });
        </script>
      </body>
    </html>
  `);
});

// Lance le server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log(`Server lancé sur port ${PORT}`, 'success');
  // Connexion initiale sans numéro (si déjà paired)
  connectToWhatsApp();
});
