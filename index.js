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
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const reconnectDelay = 5000; // 5 secondes

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

// Config bot avec reconnexion robuste
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
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && reconnectAttempts < maxReconnectAttempts;
      log(`Connexion perdue (code: ${statusCode}), reconnexion ${shouldReconnect ? 'oui' : 'non'}...`, 'error');
      if (shouldReconnect) {
        reconnectAttempts++;
        setTimeout(() => connectToWhatsApp(), reconnectDelay * reconnectAttempts); // Backoff exponentiel
      } else {
        log('Trop de tentatives ou logout, arrêt reconnexion.', 'error');
        reconnectAttempts = 0; // Reset pour futur
      }
    } else if (connection === 'open') {
      reconnectAttempts = 0;
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

// Styles CSS pro et wow (avec Bootstrap pour look professionnel)
const htmlHeader = `
<head>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background: linear-gradient(135deg, #0f2027, #203a43, #2c5364); color: #fff; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    .navbar { background: rgba(0,0,0,0.5) !important; }
    .card { background: rgba(255,255,255,0.1); border: none; box-shadow: 0 4px 30px rgba(0,0,0,0.2); backdrop-filter: blur(5px); }
    .btn-primary { background: linear-gradient(to right, #4e54c8, #8f94fb); border: none; transition: transform 0.3s; }
    .btn-primary:hover { transform: scale(1.05); }
    #logs { height: 500px; overflow-y: auto; background: rgba(0,0,0,0.3); border-radius: 10px; padding: 15px; }
    .log-entry { animation: fadeIn 0.5s; margin-bottom: 10px; padding: 10px; border-radius: 5px; }
    .log-info { background: rgba(255,255,255,0.1); }
    .log-success { background: rgba(76,175,80,0.2); color: #4caf50; animation: bounceIn 0.5s; }
    .log-error { background: rgba(244,67,54,0.2); color: #f44336; animation: shake 0.5s; }
    .log-warning { background: rgba(255,235,59,0.2); color: #ffeb3b; }
    .log-message { background: rgba(33,150,243,0.2); color: #2196f3; }
    .log-response { background: rgba(156,39,176,0.2); color: #9c27b0; }
    .log-admin { background: rgba(255,87,34,0.2); color: #ff5722; }
    .log-access { background: rgba(255,193,7,0.2); color: #ffc107; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes bounceIn { from { transform: scale(0.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    @keyframes shake { 0%, 100% { transform: translateX(0); } 10%, 30%, 50% { transform: translateX(-5px); } 20%, 40% { transform: translateX(5px); } }
  </style>
</head>
`;

// Routes avec UI pro (Bootstrap + animations)
app.get('/', (req, res) => {
  log('Accès dashboard', 'access');
  res.send(`
    <html>${htmlHeader}
      <body>
        <nav class="navbar navbar-expand-lg navbar-dark">
          <div class="container">
            <a class="navbar-brand" href="/">WhatsApp Bot Dashboard</a>
            <div class="collapse navbar-collapse">
              <ul class="navbar-nav ms-auto">
                <li class="nav-item"><a class="nav-link" href="/pair">Pairer</a></li>
                <li class="nav-item"><a class="nav-link" href="/logs">Logs</a></li>
              </ul>
            </div>
          </div>
        </nav>
        <div class="container mt-5">
          <div class="card p-4 text-center">
            <h1 class="card-title">Status du Bot 🚀</h1>
            <p>Connexion : <span id="status">Vérification...</span></p>
            <p>Utilisateurs connectés : <span id="users">0</span></p>
          </div>
        </div>
        <script src="https://cdn.socket.io/4.8.0/socket.io.min.js"></script>
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
    <html>${htmlHeader}
      <body>
        <nav class="navbar navbar-expand-lg navbar-dark">
          <div class="container">
            <a class="navbar-brand" href="/">WhatsApp Bot Dashboard</a>
            <div class="collapse navbar-collapse">
              <ul class="navbar-nav ms-auto">
                <li class="nav-item"><a class="nav-link" href="/pair">Pairer</a></li>
                <li class="nav-item"><a class="nav-link" href="/logs">Logs</a></li>
              </ul>
            </div>
          </div>
        </nav>
        <div class="container mt-5">
          <div class="card p-4">
            <h1 class="card-title text-center">Pairer ton Bot ✨</h1>
            <form action="/pair" method="post">
              <div class="mb-3">
                <label class="form-label">Numéro (sans +)</label>
                <input type="text" name="number" class="form-control" placeholder="ex: 24176209643" required>
              </div>
              <button type="submit" class="btn btn-primary">Générer Code 🎉</button>
            </form>
          </div>
        </div>
      </body>
    </html>
  `);
});

app.post('/pair', async (req, res) => {
  const phoneNumber = req.body.number.trim();
  log(`Pairing pour ${phoneNumber}`, 'info');
  if (!phoneNumber || !/^\d+$/.test(phoneNumber)) {
    return res.send(`<html>${htmlHeader}<body><div class="container mt-5"><div class="alert alert-danger">Numéro invalide ❌</div></div></body></html>`);
  }
  try {
    const pairingCode = await connectToWhatsApp(phoneNumber);
    res.send(`
      <html>${htmlHeader}
        <body>
          <nav class="navbar navbar-expand-lg navbar-dark">
            <div class="container">
              <a class="navbar-brand" href="/">WhatsApp Bot Dashboard</a>
            </div>
          </nav>
          <div class="container mt-5">
            <div class="card p-4 text-center">
              <h1 class="card-title">Code Généré 🌟</h1>
              <p class="lead">Code : <strong>${pairingCode}</strong></p>
              <p>Entre-le dans WhatsApp > Appareils connectés.</p>
            </div>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    res.send(`<html>${htmlHeader}<body><div class="container mt-5"><div class="alert alert-danger">Erreur 😞 Réessaie.</div></div></body></html>`);
  }
});

app.get('/logs', (req, res) => {
  log('Accès logs', 'access');
  res.send(`
    <html>${htmlHeader}
      <body>
        <nav class="navbar navbar-expand-lg navbar-dark">
          <div class="container">
            <a class="navbar-brand" href="/">WhatsApp Bot Dashboard</a>
            <div class="collapse navbar-collapse">
              <ul class="navbar-nav ms-auto">
                <li class="nav-item"><a class="nav-link" href="/pair">Pairer</a></li>
                <li class="nav-item"><a class="nav-link" href="/logs">Logs</a></li>
              </ul>
            </div>
          </div>
        </nav>
        <div class="container mt-5">
          <div class="card p-4">
            <h1 class="card-title text-center">Logs en Temps Réel ⚡</h1>
            <div id="logs"></div>
          </div>
        </div>
        <script src="https://cdn.socket.io/4.8.0/socket.io.min.js"></script>
        <script>
          const socket = io();
          socket.on('log', (data) => {
            const logDiv = document.getElementById('logs');
            const div = document.createElement('div');
            div.className = 'log-entry log-' + data.type;
            div.innerHTML = '<strong>[' + data.time + '] ' + data.type.toUpperCase() + ':</strong> ' + data.message;
            logDiv.appendChild(div);
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
