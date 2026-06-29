const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const API_URL = process.env.API_URL || 'https://evo.naqd.in';
const API_KEY = process.env.API_KEY || '93D6C0CFC14E-49C8-A8FC-C0300A29D250';
const INSTANCE = process.env.INSTANCE || 'EXIM';

const STATE_FILE = path.join(__dirname, 'alert_state.json');

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

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      alertedMsgIds = data.alertedMsgIds || {};
      activeUnreplied = data.activeUnreplied || {};
      lateReplies = data.lateReplies || [];
      ownerJid = data.ownerJid || '';
      
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
    const data = { alertedMsgIds, activeUnreplied, lateReplies, ownerJid, config };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[State] Failed to save state file:', e.message);
  }
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
            } catch (err) {
              console.error(`[Alerter] Failed to send alert: ${err.message}`);
            }
          }
        }
      }
    }
    
    if (stateChanged || alertChanged) {
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

  if (url === '/api/settings' && req.method === 'GET') {
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
  } else if (url === '/' || url === '/index.html' || url === '/naqd-gateway.html') {
    const fileName = (url === '/' || url === '/index.html') ? 'index.html' : 'naqd-gateway.html';
    const filePath = path.join(__dirname, fileName);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Dashboard HTML Not Found');
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
