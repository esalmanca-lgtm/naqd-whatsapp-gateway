const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const webpush = require('web-push');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const API_URL = process.env.API_URL || 'https://evo.naqd.in';
const API_KEY = process.env.API_KEY || '93D6C0CFC14E-49C8-A8FC-C0300A29D250';
const INSTANCE = process.env.INSTANCE || 'EXIM';

// Web Push (VAPID) — private key MUST come from env, never hardcode it
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:naqdexim@gmail.com';
let pushReady = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); pushReady = true; console.log('[Push] VAPID configured — web push enabled'); }
  catch (e) { console.error('[Push] Invalid VAPID keys, push disabled:', e.message); }
} else {
  console.log('[Push] No VAPID keys set — web push disabled');
}

// Persist into a mounted DIRECTORY (Docker mounts dirs cleanly) — avoids the
// "mounted file becomes a directory" footgun that silently broke state saving.
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(STATE_DIR, 'alert_state.json');
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) {}

// Persistent settings config (loads from Env first, can be overridden by UI)
let config = {
  alert_enabled: process.env.ALERT_ENABLED !== 'false',
  alert_target: process.env.TARGET_JID || '120363411366521608@g.us',
  alert_office: process.env.OFFICE_NUMBERS || '918848159581,919380525080,919778159581,919495849582,918136849582,919495739582',
  alert_timeout: process.env.TIMEOUT_MINS || '10',
  alert_format: process.env.ALERT_FORMAT || '⚠️ *Unreplied Chat Alert*\n*Chat:* {name}\n*JID:* {jid}\nNo reply has been sent for over {timeout} minutes!'
};

// State caches
let alertedMsgIds = {};
let activeUnreplied = {};
let lateReplies = [];
let ownerJid = '';
let subscriptions = [];   // web-push subscriptions
let lastSeenMsg = {};     // jid -> last message id already notified
let pushSeeded = false;   // don't notify for the existing backlog on first scan

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      alertedMsgIds = data.alertedMsgIds || {};
      activeUnreplied = data.activeUnreplied || {};
      lateReplies = data.lateReplies || [];
      ownerJid = data.ownerJid || '';
      subscriptions = data.subscriptions || [];
      lastSeenMsg = data.lastSeenMsg || {};
      pushSeeded = data.pushSeeded || false;
      
      // Load saved settings if they exist in file
      if (data.config) {
        config = Object.assign({}, config, data.config);
      }
      console.log(`[State] Loaded state and config from ${STATE_FILE}`);
    } catch (e) {
      console.error('[State] Failed to parse state file, using default config:', e.message);
    }
  }
}

function saveState() {
  try {
    try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) {}
    const data = { alertedMsgIds, activeUnreplied, lateReplies, ownerJid, config, subscriptions, lastSeenMsg, pushSeeded };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[State] Failed to save state file:', e.message);
  }
}

// Send a push notification to every subscribed device; prune dead subscriptions.
function sendPush(payload) {
  if (!pushReady || !subscriptions.length) return;
  const body = JSON.stringify(payload);
  const alive = [];
  let pruned = false;
  Promise.all(subscriptions.map(sub =>
    webpush.sendNotification(sub, body).then(
      () => { alive.push(sub); },
      (err) => {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) { pruned = true; }
        else { alive.push(sub); console.error('[Push] send error:', err && err.statusCode); }
      }
    )
  )).then(() => {
    if (pruned) { subscriptions = alive; saveState(); console.log(`[Push] Pruned dead subs; ${subscriptions.length} remain`); }
  });
}

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'apikey': API_KEY,
    'Content-Type': 'application/json'
  }
});

function cleanJidPhone(j) {
  if (!j) return "";
  const raw = String(j).split("@")[0];
  const base = raw.split(":")[0];
  const clean = base.split(".")[0];
  return clean.replace(/[^0-9]/g, "");
}

function getSenderPhone(lm) {
  if (!lm) return "";
  const remoteJid = (lm.key && lm.key.remoteJid) || "";
  const isGroup = remoteJid.indexOf("@g.us") > -1;
  let senderJid = "";
  if (isGroup) {
    senderJid = (lm.key && lm.key.participantAlt) || lm.participantAlt || lm.participant || (lm.key && lm.key.participant) || "";
  } else {
    senderJid = (lm.key && lm.key.remoteJidAlt) || (lm.key && lm.key.participantAlt) || lm.participantAlt || remoteJid;
  }
  return cleanJidPhone(senderJid);
}

function tsMs(t) {
  t = Number(t) || 0;
  return t < 1e12 ? t * 1000 : t;
}

function msgText(m) {
  if (!m || !m.message) return "";
  const t = m.messageType || Object.keys(m.message)[0] || "";
  if (t === "conversation") return m.message.conversation || "";
  if (t === "extendedTextMessage") return m.message.extendedTextMessage.text || "";
  if (t === "imageMessage") return "📷 Photo";
  if (t === "videoMessage") return "🎥 Video";
  if (t === "audioMessage") return "🎙 Voice message";
  if (t === "documentMessage") return "📄 Document";
  return "";
}

function isChatUnreplied(c) {
  const lm = c.lastMessage || (c._raw && c._raw.lastMessage);
  if (!lm || !lm.key) return false;
  if (lm.key.fromMe) return false;
  
  const sender = getSenderPhone(lm);
  const officeNums = config.alert_office.split(",").map(s => cleanJidPhone(s)).filter(Boolean);
  if (officeNums.indexOf(sender) > -1) return false;
  
  if (ownerJid) {
    const myNum = cleanJidPhone(ownerJid);
    if (myNum && sender === myNum) return false;
  }
  
  const msgTimeMs = tsMs(lm.messageTimestamp);
  const elapsed = Date.now() - msgTimeMs;
  const timeoutMins = parseInt(config.alert_timeout, 10) || 10;
  
  return elapsed >= (timeoutMins * 60 * 1000) && elapsed < (24 * 60 * 60 * 1000);
}

async function fetchOwnerJid() {
  try {
    const res = await api.get('/instance/fetchInstances');
    const list = res.data;
    const arr = Array.isArray(list) ? list : (list ? [list] : []);
    const match = arr.find(x => {
      const nm = x.instanceName || x.name;
      return nm && nm.toLowerCase() === INSTANCE.toLowerCase();
    });
    if (match) {
      const owner = match.ownerJid || match.owner;
      if (owner) {
        ownerJid = String(owner);
        console.log(`[Owner] Resolved gateway owner JID: ${ownerJid}`);
        saveState();
      }
    }
  } catch (e) {
    console.error(`[Owner] Failed to fetch owner JID: ${e.message}`);
  }
}

async function checkUnrepliedAlerts() {
  try {
    console.log('[Monitor] Scanning active chats...');
    const res = await api.post(`/chat/findChats/${encodeURIComponent(INSTANCE)}`, {});
    const list = res.data;
    const chats = Array.isArray(list) ? list : (list.records || list.chats || []);
    
    const timeoutMins = parseInt(config.alert_timeout, 10) || 10;
    const timeoutMs = timeoutMins * 60 * 1000;
    const currentlyUnrepliedMap = {};

    // ---- New-message push detection ----
    let pushChanged = false;
    if (pushReady && subscriptions.length) {
      const officeNumsPush = config.alert_office.split(",").map(s => cleanJidPhone(s)).filter(Boolean);
      chats.forEach(c => {
        const jid = c.remoteJid || c.id;
        const lm = c.lastMessage;
        if (!lm || !lm.key || lm.key.fromMe) return;                 // only incoming
        const sender = getSenderPhone(lm);
        if (officeNumsPush.indexOf(sender) > -1) return;             // office numbers
        if (ownerJid && sender === cleanJidPhone(ownerJid)) return;  // our own number
        const mid = lm.key.id;
        if (lastSeenMsg[jid] === mid) return;                        // already handled
        lastSeenMsg[jid] = mid;
        pushChanged = true;
        if (!pushSeeded) return;                                     // first scan: seed only
        if (Date.now() - tsMs(lm.messageTimestamp) > 10 * 60 * 1000) return; // ignore old backfill
        const name = c.name || c.pushName || cleanJidPhone(jid);
        sendPush({ title: name, body: msgText(lm) || 'New message', tag: 'msg-' + jid, url: './', jid });
      });
      if (!pushSeeded) { pushSeeded = true; pushChanged = true; console.log('[Push] Seeded last-seen messages (no backlog notifications)'); }
    }

    chats.forEach(c => {
      const jid = c.remoteJid || c.id;
      if (isChatUnreplied(c)) {
        const lm = c.lastMessage;
        if (lm && lm.key) {
          currentlyUnrepliedMap[jid] = true;
          if (!activeUnreplied[jid] || activeUnreplied[jid].msgId !== lm.key.id) {
            activeUnreplied[jid] = {
              msgId: lm.key.id,
              clientTime: tsMs(lm.messageTimestamp),
              name: c.name || c.pushName || cleanJidPhone(jid),
              text: msgText(lm)
            };
            console.log(`[Track] Flagged new overdue chat: ${c.name || jid}`);
          }
        }
      }
    });
    
    const activeJids = Object.keys(activeUnreplied);
    let stateChanged = false;
    
    activeJids.forEach(jid => {
      if (!currentlyUnrepliedMap[jid]) {
        const c = chats.find(x => (x.remoteJid || x.id) === jid);
        if (c && c.lastMessage && c.lastMessage.key) {
          const lm = c.lastMessage;
          let isReplied = lm.key.fromMe;
          if (!isReplied) {
            const sender = getSenderPhone(lm);
            const officeNums = config.alert_office.split(",").map(s => cleanJidPhone(s)).filter(Boolean);
            if (officeNums.indexOf(sender) > -1) isReplied = true;
            if (ownerJid && sender === cleanJidPhone(ownerJid)) isReplied = true;
          }
          
          if (isReplied) {
            const replyTime = tsMs(lm.messageTimestamp);
            const clientTime = activeUnreplied[jid].clientTime;
            const elapsed = replyTime - clientTime;
            if (elapsed >= timeoutMs) {
              lateReplies.unshift({
                jid: jid,
                name: activeUnreplied[jid].name,
                clientMsg: activeUnreplied[jid].text,
                clientTime,
                replyTime,
                elapsedMins: Math.floor(elapsed / 60000),
                repliedBy: lm.key.fromMe ? 'Gateway' : getSenderPhone(lm),
                timestamp: Date.now()
              });
              console.log(`[Compliance] Late reply detected for ${activeUnreplied[jid].name}. Took ${Math.floor(elapsed / 60000)} mins.`);
              stateChanged = true;
            }
          }
        }
        delete activeUnreplied[jid];
        stateChanged = true;
      }
    });
    
    // Alerts dispatcher
    let alertChanged = false;
    if (config.alert_enabled) {
      for (const c of chats) {
        if (isChatUnreplied(c)) {
          const lm = c.lastMessage;
          if (!lm || !lm.key) continue;
          
          const mid = lm.key.id;
          if (alertedMsgIds[mid]) continue;
          
          const msgTimeMs = tsMs(lm.messageTimestamp);
          const elapsed = Date.now() - msgTimeMs;
          if (elapsed > (12 * 60 * 60 * 1000)) continue;
          
          if (elapsed >= timeoutMs) {
            const name = c.name || c.pushName || cleanJidPhone(c.remoteJid || c.id);
            const previewText = msgText(lm);
            
            const text = config.alert_format
              .replace(/\\n/g, '\n')   // .env stores newlines as literal "\n" — turn them into real line breaks
              .replace(/{name}/g, name)
              .replace(/{jid}/g, c.remoteJid || c.id)
              .replace(/{timeout}/g, timeoutMins)
              .replace(/{preview}/g, previewText);
              
            let alertNumber = config.alert_target;
            if (alertNumber.length === 18 && !alertNumber.includes('@')) {
              alertNumber += '@g.us';
            }
            
            console.log(`[Alerter] Sending alert for chat ${name} to target ${alertNumber}...`);
            try {
              await api.post(`/message/sendText/${encodeURIComponent(INSTANCE)}`, {
                number: alertNumber,
                text: text
              });
              console.log(`[Alerter] Alert sent successfully!`);
              alertedMsgIds[mid] = true;
              alertChanged = true;
              sendPush({ title: '⚠️ Unreplied: ' + name, body: (previewText || 'No reply sent yet').slice(0, 120), tag: 'unreplied-' + (c.remoteJid || c.id), url: './', jid: (c.remoteJid || c.id) });
            } catch (err) {
              console.error(`[Alerter] Failed to send alert: ${err.message}`);
            }
          }
        }
      }
    }
    
    if (stateChanged || alertChanged || pushChanged) {
      const keys = Object.keys(alertedMsgIds);
      if (keys.length > 500) {
        const newAlerted = {};
        keys.slice(keys.length - 200).forEach(k => {
          newAlerted[k] = true;
        });
        alertedMsgIds = newAlerted;
      }
      saveState();
    }
  } catch (err) {
    console.error(`[Monitor] Error scanning chats: ${err.message}`);
  }
}

// REST HTTP server implementation for VPS serving dashboard & settings API
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = req.url;

  if (url === '/api/vapid-public-key' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: VAPID_PUBLIC }));
  } else if (url === '/api/subscribe' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const sub = data.subscription || data;
        if (!sub || !sub.endpoint) { res.writeHead(400); res.end('Invalid subscription'); return; }
        const exists = subscriptions.find(s => s.endpoint === sub.endpoint);
        if (!exists) { subscriptions.push(sub); saveState(); console.log(`[Push] New subscription (${subscriptions.length} total)`); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', count: subscriptions.length }));
      } catch (e) { res.writeHead(400); res.end('Invalid JSON'); }
    });
  } else if (url === '/api/unsubscribe' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const ep = data.endpoint || (data.subscription && data.subscription.endpoint);
        const before = subscriptions.length;
        subscriptions = subscriptions.filter(s => s.endpoint !== ep);
        if (subscriptions.length !== before) saveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', count: subscriptions.length }));
      } catch (e) { res.writeHead(400); res.end('Invalid JSON'); }
    });
  } else if (url === '/api/test-push' && req.method === 'POST') {
    if (!pushReady) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'push-disabled', sent: 0 })); return; }
    sendPush({ title: '✅ NAQD Gateway', body: 'Test notification — push is working!', tag: 'test-' + Date.now(), url: './' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sent: subscriptions.length }));
  } else if (url === '/api/settings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
  } else if (url === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.alert_enabled !== undefined) config.alert_enabled = (data.alert_enabled === 'true' || data.alert_enabled === true);
        if (data.alert_target !== undefined) config.alert_target = data.alert_target;
        if (data.alert_office !== undefined) config.alert_office = data.alert_office;
        if (data.alert_timeout !== undefined) config.alert_timeout = String(data.alert_timeout);
        if (data.alert_format !== undefined) config.alert_format = data.alert_format;
        
        saveState();
        console.log(`[Config] Settings updated via Web UI.`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', config }));
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
  } else if (
    url === '/' ||
    url === '/index.html' ||
    url === '/naqd-gateway.html' ||
    url === '/manifest.json' ||
    url === '/sw.js' ||
    url === '/icon.svg' ||
    url === '/icon-192.png' ||
    url === '/icon-512.png' ||
    url === '/icon-maskable-192.png' ||
    url === '/icon-maskable-512.png'
  ) {
    const fileName = (url === '/' || url === '/index.html') ? 'index.html' : url.substring(1);
    const filePath = path.join(__dirname, fileName);
    if (fs.existsSync(filePath)) {
      let contentType = 'text/html';
      if (fileName.endsWith('.json')) contentType = 'application/json';
      else if (fileName.endsWith('.js')) contentType = 'application/javascript';
      else if (fileName.endsWith('.svg')) contentType = 'image/svg+xml';
      else if (fileName.endsWith('.png')) contentType = 'image/png';
      
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('File Not Found');
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

console.log('================================================');
console.log('   NAQD WHATSAPP RESPONSE MONITOR DAEMON        ');
console.log('================================================');
console.log(`API URL:      ${API_URL}`);
console.log(`Instance:     ${INSTANCE}`);
console.log('------------------------------------------------');

loadState();

fetchOwnerJid().then(() => {
  checkUnrepliedAlerts();
  setInterval(checkUnrepliedAlerts, 30000);
  
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Web] Dashboard & Settings API live on port ${PORT}`);
  });
});
