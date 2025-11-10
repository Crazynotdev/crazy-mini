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
const connectedUsers = new Set(); // Track des users connectés

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
    connectedUsers.add(sender);
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
        response = `Commandes disponibles :\n- ping: Test latence\n- salut: Greeting\n- channel: Lien channel\n- uptime: Temps en ligne\n- weather [ville]: Météo\n- quote: Citation\n- broadcast [msg]: Admin broadcast\n- info: Infos bot\n- stats: Stats\n- joke: Blague\n- calc [expr]: Calcul\n- echo [text]: Répète\n- roll [max]: Nombre aléatoire (1-max, def 100)\n- coin: Pile ou face\n- time: Heure actuelle\n- fact: Fait aléatoire`;
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
        response = `Météo à ${city} : Ensoleillé, 20°C (simulation).`;
        break;
      }
      case 'quote': {
        const quotes = ['La vie est belle.', 'Carpe diem.', 'Think big.', 'Stay hungry, stay foolish.', 'Be the change.'];
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
        const jokes = ['Pourquoi les plongeurs plongent-ils toujours en arrière ? Parce que sinon ils tombent dans le bateau !', 'Quelle est la différence entre un pigeon ? Il a les deux pattes de la même longueur, surtout la gauche !', 'Pourquoi les tomates sont-elles rouges ? Parce qu\'elles rougissent en voyant la salade !'];
        response = jokes[Math.floor(Math.random() * jokes.length)];
        break;
      }
      case 'calc': {
        try {
          response = `Résultat : ${eval(args.join(' '))}`;
        } catch (e) {
          response = 'Erreur calcul : ' + e.message;
        }
        break;
      }
      case 'echo': {
        response = args.join(' ') || 'Rien à répéter ?';
        break;
      }
      case 'roll': {
        const max = parseInt(args[0]) || 100;
        response = `Tirage aléatoire (1-${max}) : ${Math.floor(Math.random() * max) + 1}`;
        break;
      }
      case 'coin': {
        response = Math.random() < 0.5 ? 'Pile !' : 'Face !';
        break;
      }
      case 'time': {
        response = `Heure actuelle : ${new Date().toLocaleString()}`;
        break;
      }
      case 'fact': {
        const facts = ['Les pieuvres ont 3 cœurs.', 'Les bananes sont des baies.', 'Un jour sur Vénus dure plus longtemps qu\'une année.', 'Les abeilles peuvent reconnaître les visages humains.'];
        response = facts[Math.floor(Math.random() * facts.length)];
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

// Styles CSS wow animés améliorés
const cssStyles = `
  body { font-family: 'Arial', sans-serif; background: linear-gradient(to bottom, #1e3c72, #2a5298); color: white; margin: 0; padding: 20px; transition: background 1s; }
  h1 { text-align: center; animation: fadeIn 1s ease-in-out, glow 2s infinite alternate, rainbow 10s infinite; }
  form { max-width: 400px; margin: auto; padding: 20px; background: rgba(255,255,255,0.1); border-radius: 10px; box-shadow: 0 0 20px rgba(0,0,0,0.5); animation: slideUp 0.5s ease-out, pulse 2s infinite; }
  input, button { width: 100%; padding: 10px; margin: 10px 0; border: none; border-radius: 5px; transition: all 0.3s; }
  button { background: linear-gradient(to right, #4CAF50, #2196F3); color: white; cursor: pointer; }
  button:hover { transform: scale(1.05); box-shadow: 0 0 15px #fff; }
  #status { color: #FFD700; animation: blink 1s infinite; }
  #logs { background: rgba(0,0,0,0.3); border-radius: 10px; padding: 10px; }
  .log-info { color: #fff; }
  .log-success { color: #4CAF50; animation: bounceIn 0.5s; }
  .log-error { color: #F44336; animation: shake 0.5s; }
  .log-warning { color: #FFEB3B; }
  .log-message { color: #2196F3; }
  .log-response { color: #9C27B0; }
  .log-admin { color: #FF5722; }
  .log-access { color: #FFC107; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes slideUp { from { transform: translateY(50px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes glow { from { text-shadow: 0 0 5px #fff; } to { text-shadow: 0 0 20px #fff, 0 0 30px #4CAF50; } }
  @keyframes pulse { 0% { transform: scale(1); } 50% { transform: scale(1.02); } 100% { transform: scale(1); } }
  @keyframes rainbow { 0% { color: #f00; } 14% { color: #ff0; } 28% { color: #0f0; } 42% { color: #0ff; } 57% { color: #00f; } 71% { color: #f0f; } 85% { color: #f00; } 100% { color: #f00; } }
  @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
  @keyframes bounceIn { from { transform: scale(0.5); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  @keyframes shake { 0%, 100% { transform: translateX(0); } 10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); } 20%, 40%, 60%, 80% { transform: translateX(5px); } }
`;

// Routes avec styles wow
app.get('/', (req, res) => {
  log('Accès dashboard', 'access');
  res.send(`
    <html>
      <head><style>${cssStyles}</style></head>
      <body>
        <h1>Dashboard Bot WhatsApp 🚀✨</h1>
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
        <h1>Pairer ton Bot ✨🌟</h1>
        <form action="/pair" method="post">
          <label>Numéro (sans +) :</label><br>
          <input type="text" name="number" placeholder="ex: 24176209643" required><br>
          <button type="submit">Générer Code 🎉🔥</button>
        </form>
      </body>
    </html>
  `);
});

app.post('/pair', async (req, res) => {
  const phoneNumber = req.body.number.trim();
  log(`Pairing pour ${phoneNumber}`, 'info');
  if (!phoneNumber || !/^\d+$/.test(phoneNumber)) {
    return res.send('<html><head><style>' + cssStyles + '</style></head><body><h1>Numéro invalide ❌😞</h1></body></html>');
  }
  try {
    const pairingCode = await connectToWhatsApp(phoneNumber);
    res.send(`
      <html>
        <head><style>${cssStyles}</style></head>
        <body>
          <h1>Code Généré 🌟🎊</h1>
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
        <h1>Logs en Temps Réel ⚡🔥</h1>
        <div id="logs" style="height:400px; overflow-y:scroll;"></div>
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          socket.on('log', (data) => {
            const logDiv = document.getElementById('logs');
            const p = document.createElement('p');
            p.className = 'log-' + data.type;
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
