const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const config = require('./config'); // Import config

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Variables globales
let sock;
let startTime = Date.now();
const rateLimit = new Map(); // Rate limit: max 5 msg/min par user
const connectedUsers = new Set(); // Track des users connectés (pour stats)

// Fonction de log avancée
function log(message, type = 'info') {
  console.log(`[${type.toUpperCase()}] ${new Date().toLocaleString()}: ${message}`);
  io.emit('log', { time: new Date().toLocaleString(), type, message });
}

// Fonction utilitaire pour formater le temps
function formatUptime(uptime) {
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = uptime % 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

// Config bot avec plus de features
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
      io.emit('status', { connected: true, users: connectedUsers.size });
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
    connectedUsers.add(sender); // Ajoute user aux stats
    io.emit('status', { connected: true, users: connectedUsers.size });
    log(`Message reçu de ${sender}: ${text}`, 'message');

    // Rate limit
    const now = Date.now();
    if (!rateLimit.has(sender)) rateLimit.set(sender, []);
    const timestamps = rateLimit.get(sender);
    timestamps.push(now);
    rateLimit.set(sender, timestamps.filter(ts => now - ts < 60000));
    if (timestamps.length > 5) {
      log(`Rate limit exceeded for ${sender}`, 'warning');
      return sock.sendMessage(sender, { text: 'Trop de messages ! Attends 1 minute.' });
    }

    let response = '';
    let args = text.split(' ').slice(1);

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
        response = `Commandes disponibles :\n- ping: Test latence\n- salut: Greeting personnalisé\n- channel: Lien channel WhatsApp\n- uptime: Temps en ligne\n- weather [ville]: Météo\n- quote: Citation random\n- broadcast [msg]: Admin broadcast\n- info: Infos bot\n- stats: Stats users\n- joke: Blague random\n- calc [expr]: Calcul simple (ex: calc 2+2)\n- echo [text]: Répète ton texte`;
        break;
      }
      case 'channel': {
        response = `Rejoins mon channel : ${config.channelLink}`;
        break;
      }
      case 'uptime': {
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        response = `Bot en ligne depuis ${formatUptime(uptime)}.`;
        break;
      }
      case 'weather': {
        const city = args[0] || 'Paris';
        response = `Météo à ${city} : Ensoleillé, 20°C (simulation).`; // Ajoute API réelle si besoin
        break;
      }
      case 'quote': {
        const quotes = ['La vie est belle.', 'Carpe diem.', 'Think big.', 'Stay hungry, stay foolish.'];
        response = quotes[Math.floor(Math.random() * quotes.length)];
        break;
      }
      case 'broadcast': {
        if (sender !== config.adminJid) {
          response = 'Commande admin only.';
          break;
        }
        const broadcastMsg = args.join(' ');
        response = `Broadcast envoyé : ${broadcastMsg} (simulation).`;
        log(`Broadcast: ${broadcastMsg}`, 'admin');
        // Pour réel : boucle sur connectedUsers ou groupes
        break;
      }
      case 'info': {
        response = `Bot v1.0 | Admin: ${config.adminJid} | Démarré: ${new Date(startTime).toLocaleString()}`;
        break;
      }
      case 'stats': {
        response = `Users connectés: ${connectedUsers.size} | Uptime: ${formatUptime(Math.floor((Date.now() - startTime) / 1000))}`;
        break;
      }
      case 'joke': {
        const jokes = ['Pourquoi les plongeurs plongent-ils toujours en arrière ? Parce que sinon ils tombent dans le bateau !', 'Quelle est la différence entre un pigeon ? Il a les deux pattes de la même longueur, surtout la gauche !'];
        response = jokes[Math.floor(Math.random() * jokes.length)];
        break;
      }
      case 'calc': {
        try {
          response = `Résultat : ${eval(args.join(' '))}`; // Attention sécurité : limite à maths simples
        } catch (e) {
          response = 'Erreur calcul : ' + e.message;
        }
        break;
      }
      case 'echo': {
        response = args.join(' ') || 'Rien à répéter ?';
        break;
      }
      default: {
        if (text) response = 'Commande inconnue. Essaie "aide".';
        break;
      }
    }

    if (response) {
      await sock.sendMessage(sender, { text: response });
      log(`Réponse à ${sender}: ${response}`, 'response');
    }
  });

  return pairingCode;
}

// Styles CSS wow animés (embedded)
const cssStyles = `
  body { font-family: 'Arial', sans-serif; background: linear-gradient(to bottom, #1e3c72, #2a5298); color: white; margin: 0; padding: 20px; }
  h1 { text-align: center; animation: fadeIn 1s ease-in-out, glow 2s infinite alternate; }
  form { max-width: 400px; margin: auto; padding: 20px; background: rgba(255,255,255,0.1); border-radius: 10px; box-shadow: 0 0 20px rgba(0,0,0,0.5); animation: slideUp 0.5s ease-out; }
  input, button { width: 100%; padding: 10px; margin: 10px 0; border: none; border-radius: 5px; }
  button { background: #4CAF50; color: white; cursor: pointer; transition: transform 0.3s; }
  button:hover { transform: scale(1.05); }
  #status { color: #FFD700; }
  #logs { background: rgba(0,0,0,0.3); border-radius: 10px; padding: 10px; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes slideUp { from { transform: translateY(50px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes glow { from { text-shadow: 0 0 5px #fff; } to { text-shadow: 0 0 20px #fff, 0 0 30px #4CAF50; } }
`;

// Routes avec styles wow animés
app.get('/', (req, res) => {
  log('Accès dashboard', 'access');
  res.send(`
    <html>
      <head><style>${cssStyles}</style></head>
      <body>
        <h1>Dashboard Bot WhatsApp 🚀</h1>
        <p>Status : <span id="status">Vérification...</span> | Users : <span id="users">0</span></p>
        <a href="/pair" style="display:block; text-align:center; color:#fff;">Pairer un appareil</a> | <a href="/logs" style="display:block; text-align:center; color:#fff;">Logs en live</a>
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          socket.on('status', (data) => {
            document.getElementById('status').innerText = data.connected ? 'Connecté ✅' : 'Déconnecté ❌';
            document.getElementById('users').innerText = data.users || 0;
          });
        </script>
      </body>
    </html>
  `);
});

app.get('/pair', (req, res) => {
  log('Accès pairing', 'access');
  res.send(`
    <html>
      <head><style>${cssStyles}</style></head>
      <body>
        <h1>Pairer ton Bot ✨</h1>
        <form action="/pair" method="post">
          <label>Numéro (sans +) :</label><br>
          <input type="text" name="number" placeholder="ex: 24176209643" required><br>
          <button type="submit">Générer Code 🎉</button>
        </form>
      </body>
    </html>
  `);
});

app.post('/pair', async (req, res) => {
  const phoneNumber = req.body.number.trim();
  log(`Pairing pour ${phoneNumber}`, 'info');
  if (!phoneNumber || !/^\d+$/.test(phoneNumber)) {
    return res.send('<html><head><style>' + cssStyles + '</style></head><body><h1>Numéro invalide ❌</h1></body></html>');
  }
  try {
    const pairingCode = await connectToWhatsApp(phoneNumber);
    res.send(`
      <html>
        <head><style>${cssStyles}</style></head>
        <body>
          <h1>Code Généré 🌟</h1>
          <p>Code : <strong>${pairingCode}</strong></p>
          <p>Entre-le dans WhatsApp !</p>
        </body>
      </html>
    `);
  } catch (error) {
    res.send('<html><head><style>' + cssStyles + '</style></head><body><h1>Erreur 😞 Réessaie.</h1></body></html>');
  }
});

app.get('/logs', (req, res) => {
  log('Accès logs', 'access');
  res.send(`
    <html>
      <head><style>${cssStyles}</style></head>
      <body>
        <h1>Logs en Temps Réel ⚡</h1>
        <div id="logs" style="height:400px; overflow-y:scroll;"></div>
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          socket.on('log', (data) => {
            const logDiv = document.getElementById('logs');
            const p = document.createElement('p');
            p.innerHTML = `<strong>[${data.time}] ${data.type.toUpperCase()}:</strong> ${data.message}`;
            p.style.animation = 'fadeIn 0.5s';
            logDiv.appendChild(p);
            logDiv.scrollTop = logDiv.scrollHeight;
          });
        </script>
      </body>
    </html>
  `);
});

// Lance server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log(`Server on port ${PORT}`, 'success');
  connectToWhatsApp();
});
