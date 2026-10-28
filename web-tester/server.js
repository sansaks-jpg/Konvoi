const http = require('http');
const net = require('net');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3000;
const PROTOCOL_VERSION = 1;

// Helper to find real Wi-Fi IP
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  // 1. Look for Wi-Fi or WLAN adapter
  for (const name of Object.keys(interfaces)) {
    if (/wi-?fi|wlan/i.test(name)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  }
  // 2. Look for other non-virtual adapters
  for (const name of Object.keys(interfaces)) {
    if (/virtual|vethernet|wg|tun|tap/i.test(name)) continue;
    for (const iface of interfaces[name]) {
      if (
        iface.family === 'IPv4' &&
        !iface.internal &&
        !iface.address.startsWith('192.168.56.')
      ) {
        return iface.address;
      }
    }
  }
  return '192.168.100.11';
}

const LOCAL_IP = getLocalIpAddress();

// Global state for Guest mode (laptop connects to phone)
let guestSocket = null;
let guestBuffer = '';
let guestPingTimer = null;
let guestState = {
  status: 'disconnected', // 'disconnected' | 'connecting' | 'connected'
  selfId: null,
  hostId: null,
  roomId: null,
  roomName: null,
  participants: [],
  voiceParticipants: [],
  locations: {},
  error: null,
};

// Global state for Host mode (laptop hosts room, phone connects to laptop)
let hostServer = null;
let hostClients = new Map(); // id -> { socket, participant, voice, location }
let hostState = {
  running: false,
  port: 50000,
  pin: '123456', // 6 digits per Konvoi protocol
  roomId: 'laptop-room-' + Math.random().toString(36).substring(2, 7),
  roomName: 'Konvoi Laptop Host',
  participants: [],
  voiceParticipants: [],
  locations: {},
};

// Connected SSE clients for real-time browser push
const sseClients = new Set();

function broadcastEvent(type, data) {
  const payload = `data: ${JSON.stringify({ type, data })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  broadcastEvent('log', line);
}

// -------------------------------------------------------------
// GUEST MODE: Connect laptop to phone
// -------------------------------------------------------------
function connectGuest(host, port, pin, displayName) {
  disconnectGuest();

  guestState = {
    status: 'connecting',
    selfId: null,
    hostId: null,
    roomId: null,
    roomName: null,
    participants: [],
    voiceParticipants: [],
    locations: {},
    error: null,
  };
  broadcastEvent('state', { mode: 'guest', state: guestState });

  log(`[Guest] Menghubungkan ke ${host}:${port} sebagai "${displayName}"...`);
  guestSocket = net.createConnection({ host, port: Number(port) }, () => {
    log(`[Guest] Koneksi TCP terbuka ke ${host}:${port}. Mengirim JOIN_REQUEST...`);
    const joinReq = {
      type: 'JOIN_REQUEST',
      protocolVersion: PROTOCOL_VERSION,
      roomId: '',
      clientMessageId: 'laptop-' + Date.now(),
      displayName: displayName.trim() || 'Laptop Rider',
      pin: String(pin).trim(),
    };
    sendGuest(joinReq);
  });

  guestBuffer = '';

  guestSocket.on('data', chunk => {
    guestBuffer += chunk.toString('utf8');
    let idx;
    while ((idx = guestBuffer.indexOf('\n')) !== -1) {
      const line = guestBuffer.slice(0, idx).trim();
      guestBuffer = guestBuffer.slice(idx + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          handleGuestIncoming(msg);
        } catch (e) {
          log(`[Guest] Error parsing NDJSON: ${e.message}`);
        }
      }
    }
  });

  guestSocket.on('close', () => {
    log('[Guest] Koneksi TCP terputus.');
    if (guestPingTimer) {
      clearInterval(guestPingTimer);
      guestPingTimer = null;
    }
    guestState.status = 'disconnected';
    broadcastEvent('state', { mode: 'guest', state: guestState });
    guestSocket = null;
  });

  guestSocket.on('error', err => {
    log(`[Guest] TCP Error: ${err.message}`);
    if (guestPingTimer) {
      clearInterval(guestPingTimer);
      guestPingTimer = null;
    }
    guestState.status = 'disconnected';
    guestState.error = err.message;
    broadcastEvent('state', { mode: 'guest', state: guestState });
  });
}

function sendGuest(msg) {
  if (guestSocket && !guestSocket.destroyed) {
    guestSocket.write(JSON.stringify(msg) + '\n');
  }
}

function disconnectGuest() {
  if (guestPingTimer) {
    clearInterval(guestPingTimer);
    guestPingTimer = null;
  }
  if (guestSocket) {
    if (guestState.roomId) {
      try {
        sendGuest({
          type: 'LEAVE_ROOM',
          protocolVersion: PROTOCOL_VERSION,
          roomId: guestState.roomId,
        });
      } catch {}
    }
    guestSocket.destroy();
    guestSocket = null;
  }
  guestState.status = 'disconnected';
  broadcastEvent('state', { mode: 'guest', state: guestState });
}

function handleGuestIncoming(msg) {
  log(`<- [Guest In] ${msg.type}`);

  switch (msg.type) {
    case 'JOIN_ACCEPTED':
      guestState.status = 'connected';
      guestState.selfId = msg.selfId;
      guestState.hostId = msg.hostId;
      guestState.roomId = msg.roomId;
      guestState.roomName = msg.roomName;
      guestState.participants = msg.participants || [];
      guestState.voiceParticipants = msg.voiceParticipants || [];
      log(`[Guest] Berhasil bergabung ke ruangan "${msg.roomName}"! Self ID: ${msg.selfId}`);
      broadcastEvent('state', { mode: 'guest', state: guestState });

      // Start automatic heartbeat PING every 10s to keep connection alive
      if (guestPingTimer) clearInterval(guestPingTimer);
      guestPingTimer = setInterval(() => {
        if (guestSocket && !guestSocket.destroyed && guestState.roomId) {
          sendGuest({
            type: 'PING',
            protocolVersion: PROTOCOL_VERSION,
            roomId: guestState.roomId,
          });
        }
      }, 10000);
      break;

    case 'PONG':
      // Heartbeat acknowledged by host
      break;

    case 'JOIN_REJECTED':
      guestState.status = 'disconnected';
      guestState.error = `Ditolak host: ${msg.reason} (${msg.message || ''})`;
      log(`[Guest] JOIN DITOLAK: ${guestState.error}`);
      broadcastEvent('state', { mode: 'guest', state: guestState });
      disconnectGuest();
      break;

    case 'PARTICIPANT_JOINED':
      guestState.participants = guestState.participants.filter(p => p.id !== msg.participant.id);
      guestState.participants.push(msg.participant);
      log(`[Guest] Peserta baru bergabung: ${msg.participant.displayName}`);
      broadcastEvent('state', { mode: 'guest', state: guestState });
      break;

    case 'PARTICIPANT_LEFT':
      guestState.participants = guestState.participants.filter(p => p.id !== msg.participantId);
      guestState.voiceParticipants = guestState.voiceParticipants.filter(v => v.participantId !== msg.participantId);
      delete guestState.locations[msg.participantId];
      log(`[Guest] Peserta keluar: ${msg.participantId}`);
      broadcastEvent('state', { mode: 'guest', state: guestState });
      break;

    case 'ROOM_STATE':
      guestState.participants = msg.participants || [];
      guestState.voiceParticipants = msg.voiceParticipants || [];
      broadcastEvent('state', { mode: 'guest', state: guestState });
      break;

    case 'VOICE_PARTICIPANT_STATE':
      if (msg.joined) {
        guestState.voiceParticipants = guestState.voiceParticipants.filter(v => v.participantId !== msg.participant.participantId);
        guestState.voiceParticipants.push(msg.participant);
      } else {
        guestState.voiceParticipants = guestState.voiceParticipants.filter(v => v.participantId !== msg.participant.participantId);
      }
      broadcastEvent('state', { mode: 'guest', state: guestState });
      broadcastEvent('voice_state', { participant: msg.participant, joined: msg.joined });
      break;

    case 'VOICE_SIGNAL':
      broadcastEvent('voice_signal', {
        fromId: msg.fromId,
        signal: msg.signal,
      });
      break;

    case 'LOCATION_UPDATE':
      guestState.locations[msg.participantId] = {
        location: msg.location,
        receivedAt: Date.now(),
      };
      broadcastEvent('location_update', {
        participantId: msg.participantId,
        location: msg.location,
      });
      break;

    case 'LOCATION_SHARING_STOP':
      delete guestState.locations[msg.participantId];
      broadcastEvent('location_stop', { participantId: msg.participantId });
      break;

    case 'ROOM_CLOSED':
      log('[Guest] Ruangan telah ditutup oleh host.');
      disconnectGuest();
      break;

    case 'KICK_PARTICIPANT':
      log('[Guest] Anda dikeluarkan dari ruangan oleh host.');
      disconnectGuest();
      break;

    default:
      break;
  }
}

// -------------------------------------------------------------
// HOST MODE: Laptop serves as room host for testing
// -------------------------------------------------------------
function startHost(port = 50000, pin = '123456', roomName = 'Konvoi Laptop Host') {
  stopHost();

  hostState.running = true;
  hostState.port = Number(port);
  hostState.pin = String(pin).trim();
  hostState.roomName = roomName;
  hostState.roomId = 'laptop-room-' + Math.random().toString(36).substring(2, 7);
  hostState.participants = [
    {
      id: 'laptop-host',
      displayName: 'Laptop (Host)',
      joinedAt: Date.now(),
    },
  ];
  hostState.voiceParticipants = [];
  hostState.locations = {};

  hostClients = new Map();

  hostServer = net.createServer(socket => {
    let clientBuffer = '';
    let currentParticipantId = null;

    log(`[Host] Menerima koneksi TCP dari ${socket.remoteAddress}:${socket.remotePort}`);

    socket.on('data', chunk => {
      clientBuffer += chunk.toString('utf8');
      let idx;
      while ((idx = clientBuffer.indexOf('\n')) !== -1) {
        const line = clientBuffer.slice(0, idx).trim();
        clientBuffer = clientBuffer.slice(idx + 1);
        if (line) {
          try {
            const msg = JSON.parse(line);
            handleHostIncoming(socket, msg, id => {
              currentParticipantId = id;
            }, () => currentParticipantId);
          } catch (e) {
            log(`[Host] NDJSON parse error: ${e.message}`);
          }
        }
      }
    });

    socket.on('close', () => {
      if (currentParticipantId) {
        log(`[Host] Peserta ${currentParticipantId} terputus.`);
        hostClients.delete(currentParticipantId);
        hostState.participants = hostState.participants.filter(p => p.id !== currentParticipantId);
        hostState.voiceParticipants = hostState.voiceParticipants.filter(v => v.participantId !== currentParticipantId);
        delete hostState.locations[currentParticipantId];
        broadcastHostMsg({
          type: 'PARTICIPANT_LEFT',
          protocolVersion: PROTOCOL_VERSION,
          roomId: hostState.roomId,
          timestamp: Date.now(),
          participantId: currentParticipantId,
          reason: 'LEFT',
        });
        broadcastEvent('state', { mode: 'host', state: hostState });
      }
    });

    socket.on('error', err => {
      log(`[Host] Socket error (${currentParticipantId || 'anon'}): ${err.message}`);
    });
  });

  // Listen explicitly on 0.0.0.0 so all Wi-Fi clients can reach
  hostServer.listen(port, '0.0.0.0', () => {
    log(`[Host] Server aktif di port ${port}! PIN: ${pin} · IP Wi-Fi: ${LOCAL_IP}`);
    broadcastEvent('state', { mode: 'host', state: hostState });
  });

  hostServer.on('error', err => {
    log(`[Host] Server listen error: ${err.message}`);
    stopHost();
  });
}

function broadcastHostMsg(msg, excludeId = null) {
  const data = JSON.stringify(msg) + '\n';
  for (const [id, client] of hostClients.entries()) {
    if (id !== excludeId && client.socket && !client.socket.destroyed) {
      client.socket.write(data);
    }
  }
}

function handleHostIncoming(socket, msg, setId, getId) {
  const senderId = getId();

  if (msg.type === 'JOIN_REQUEST') {
    if (String(msg.pin).trim() !== String(hostState.pin).trim()) {
      log(`[Host] JOIN_REJECTED: PIN salah (diterima: "${msg.pin}", seharusnya: "${hostState.pin}")`);
      socket.write(
        JSON.stringify({
          type: 'JOIN_REJECTED',
          protocolVersion: PROTOCOL_VERSION,
          roomId: hostState.roomId,
          timestamp: Date.now(),
          reason: 'WRONG_PIN',
          message: 'PIN salah.',
        }) + '\n',
      );
      socket.destroy();
      return;
    }

    const newId = 'rider-' + Math.random().toString(36).substring(2, 8);
    setId(newId);

    const participant = {
      id: newId,
      displayName: msg.displayName || 'Tamu',
      joinedAt: Date.now(),
    };

    hostClients.set(newId, { socket, participant, voice: null, location: null });
    hostState.participants.push(participant);

    // Kirim JOIN_ACCEPTED ke client baru
    socket.write(
      JSON.stringify({
        type: 'JOIN_ACCEPTED',
        protocolVersion: PROTOCOL_VERSION,
        roomId: hostState.roomId,
        timestamp: Date.now(),
        selfId: newId,
        hostId: 'laptop-host',
        roomName: hostState.roomName,
        voiceCapacity: 16,
        participants: hostState.participants,
        voiceParticipants: hostState.voiceParticipants,
      }) + '\n',
    );

    // Broadcast ke client lain
    broadcastHostMsg(
      {
        type: 'PARTICIPANT_JOINED',
        protocolVersion: PROTOCOL_VERSION,
        roomId: hostState.roomId,
        timestamp: Date.now(),
        participant,
      },
      newId,
    );

    log(`[Host] HP bergabung: "${participant.displayName}" (ID: ${newId})`);
    broadcastEvent('state', { mode: 'host', state: hostState });
    return;
  }

  // Answer PING immediately to prevent client timeout!
  if (msg.type === 'PING') {
    socket.write(
      JSON.stringify({
        type: 'PONG',
        protocolVersion: PROTOCOL_VERSION,
        roomId: hostState.roomId,
        timestamp: Date.now(),
        ...(msg.nonce ? { nonce: msg.nonce } : {}),
      }) + '\n',
    );
    return;
  }

  // Handle client actions
  switch (msg.type) {
    case 'VOICE_JOIN': {
      const vp = { participantId: senderId, muted: false };
      hostState.voiceParticipants = hostState.voiceParticipants.filter(
        v => v.participantId !== senderId,
      );
      hostState.voiceParticipants.push(vp);
      const clientData = hostClients.get(senderId);
      if (clientData) clientData.voice = vp;

      const vpMsg = {
        type: 'VOICE_PARTICIPANT_STATE',
        protocolVersion: PROTOCOL_VERSION,
        roomId: hostState.roomId,
        timestamp: Date.now(),
        participant: vp,
        joined: true,
      };
      broadcastHostMsg(vpMsg);
      broadcastEvent('state', { mode: 'host', state: hostState });
      broadcastEvent('voice_state', { participant: vp, joined: true });
      log(`[Host] Peserta ${senderId} bergabung ke obrolan suara.`);
      break;
    }

    case 'VOICE_LEAVE': {
      const vp = { participantId: senderId, muted: false };
      hostState.voiceParticipants = hostState.voiceParticipants.filter(
        v => v.participantId !== senderId,
      );
      const clientData = hostClients.get(senderId);
      if (clientData) clientData.voice = null;

      const vpMsg = {
        type: 'VOICE_PARTICIPANT_STATE',
        protocolVersion: PROTOCOL_VERSION,
        roomId: hostState.roomId,
        timestamp: Date.now(),
        participant: vp,
        joined: false,
      };
      broadcastHostMsg(vpMsg);
      broadcastEvent('state', { mode: 'host', state: hostState });
      broadcastEvent('voice_state', { participant: vp, joined: false });
      log(`[Host] Peserta ${senderId} keluar dari obrolan suara.`);
      break;
    }

    case 'VOICE_MUTE_STATUS': {
      const entry = hostState.voiceParticipants.find(
        v => v.participantId === senderId,
      );
      if (entry) {
        entry.muted = Boolean(msg.muted);
      }
      const muteMsg = {
        type: 'VOICE_MUTE_STATUS',
        protocolVersion: PROTOCOL_VERSION,
        roomId: hostState.roomId,
        timestamp: Date.now(),
        participantId: senderId,
        muted: Boolean(msg.muted),
      };
      broadcastHostMsg(muteMsg);
      broadcastEvent('state', { mode: 'host', state: hostState });
      break;
    }

    case 'VOICE_SIGNAL': {
      // Relay WebRTC signal to target participant
      const target = hostClients.get(msg.targetId);
      if (target && target.socket && !target.socket.destroyed) {
        target.socket.write(
          JSON.stringify({
            type: 'VOICE_SIGNAL',
            protocolVersion: PROTOCOL_VERSION,
            roomId: hostState.roomId,
            timestamp: Date.now(),
            fromId: senderId,
            signal: msg.signal,
          }) + '\n',
        );
      } else if (msg.targetId === 'laptop-host') {
        broadcastEvent('voice_signal', {
          fromId: senderId,
          signal: msg.signal,
        });
      }
      break;
    }

    case 'LOCATION_UPDATE': {
      hostState.locations[senderId] = {
        location: msg.location,
        receivedAt: Date.now(),
      };
      broadcastHostMsg({
        type: 'LOCATION_UPDATE',
        protocolVersion: PROTOCOL_VERSION,
        roomId: hostState.roomId,
        timestamp: Date.now(),
        participantId: senderId,
        location: msg.location,
      });
      broadcastEvent('location_update', {
        participantId: senderId,
        location: msg.location,
      });
      break;
    }

    case 'LOCATION_SHARING_STOP': {
      delete hostState.locations[senderId];
      broadcastHostMsg({
        type: 'LOCATION_SHARING_STOP',
        protocolVersion: PROTOCOL_VERSION,
        roomId: hostState.roomId,
        timestamp: Date.now(),
        participantId: senderId,
      });
      broadcastEvent('location_stop', { participantId: senderId });
      break;
    }

    case 'LEAVE_ROOM': {
      socket.destroy();
      break;
    }

    default:
      break;
  }
}

function stopHost() {
  if (hostServer) {
    broadcastHostMsg({
      type: 'ROOM_CLOSED',
      protocolVersion: PROTOCOL_VERSION,
      roomId: hostState.roomId,
      timestamp: Date.now(),
      reason: 'Host menutup ruangan.',
    });
    for (const client of hostClients.values()) {
      try {
        client.socket.destroy();
      } catch {}
    }
    hostClients.clear();
    hostServer.close();
    hostServer = null;
  }
  hostState.running = false;
  broadcastEvent('state', { mode: 'host', state: hostState });
}

// -------------------------------------------------------------
// HTTP & SSE Server
// -------------------------------------------------------------
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // SSE Stream
  if (parsed.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('\n');
    sseClients.add(res);

    // Initial state
    res.write(
      `data: ${JSON.stringify({
        type: 'init',
        data: {
          localIp: LOCAL_IP,
          guestState,
          hostState,
        },
      })}\n\n`,
    );

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // Network Info API
  if (parsed.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        localIp: LOCAL_IP,
        phoneCandidateIp: '192.168.100.10',
        hostRunning: hostState.running,
        hostPort: hostState.port,
        hostPin: hostState.pin,
        guestConnected: guestState.status === 'connected',
      }),
    );
  }

  // API Endpoints
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      let data = {};
      try {
        data = JSON.parse(body || '{}');
      } catch {}

      if (parsed.pathname === '/api/connect-guest') {
        const { host, port, pin, displayName } = data;
        connectGuest(host, port, pin, displayName || 'Laptop Rider');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (parsed.pathname === '/api/disconnect-guest') {
        disconnectGuest();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (parsed.pathname === '/api/start-host') {
        const { port, pin, roomName } = data;
        startHost(port || 50000, pin || '123456', roomName || 'Konvoi Laptop Host');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, localIp: LOCAL_IP }));
      }

      if (parsed.pathname === '/api/stop-host') {
        stopHost();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (parsed.pathname === '/api/send-action') {
        // Handle when Laptop is GUEST
        if (guestState.status === 'connected' && guestState.roomId) {
          const action = {
            ...data,
            protocolVersion: PROTOCOL_VERSION,
            roomId: guestState.roomId,
          };
          sendGuest(action);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
        }

        // Handle when Laptop is HOST
        if (hostState.running) {
          const { type } = data;

          if (type === 'VOICE_JOIN') {
            const vp = { participantId: 'laptop-host', muted: false };
            hostState.voiceParticipants = hostState.voiceParticipants.filter(
              v => v.participantId !== 'laptop-host',
            );
            hostState.voiceParticipants.push(vp);

            broadcastHostMsg({
              type: 'VOICE_PARTICIPANT_STATE',
              protocolVersion: PROTOCOL_VERSION,
              roomId: hostState.roomId,
              timestamp: Date.now(),
              participant: vp,
              joined: true,
            });
            broadcastEvent('state', { mode: 'host', state: hostState });
            broadcastEvent('voice_state', { participant: vp, joined: true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
          }

          if (type === 'VOICE_LEAVE') {
            const vp = { participantId: 'laptop-host', muted: false };
            hostState.voiceParticipants = hostState.voiceParticipants.filter(
              v => v.participantId !== 'laptop-host',
            );

            broadcastHostMsg({
              type: 'VOICE_PARTICIPANT_STATE',
              protocolVersion: PROTOCOL_VERSION,
              roomId: hostState.roomId,
              timestamp: Date.now(),
              participant: vp,
              joined: false,
            });
            broadcastEvent('state', { mode: 'host', state: hostState });
            broadcastEvent('voice_state', { participant: vp, joined: false });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
          }

          if (type === 'VOICE_MUTE_STATUS') {
            const entry = hostState.voiceParticipants.find(
              v => v.participantId === 'laptop-host',
            );
            if (entry) entry.muted = Boolean(data.muted);

            broadcastHostMsg({
              type: 'VOICE_MUTE_STATUS',
              protocolVersion: PROTOCOL_VERSION,
              roomId: hostState.roomId,
              timestamp: Date.now(),
              participantId: 'laptop-host',
              muted: Boolean(data.muted),
            });
            broadcastEvent('state', { mode: 'host', state: hostState });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
          }

          if (type === 'VOICE_SIGNAL') {
            const target = hostClients.get(data.targetId);
            if (target && target.socket && !target.socket.destroyed) {
              target.socket.write(
                JSON.stringify({
                  type: 'VOICE_SIGNAL',
                  protocolVersion: PROTOCOL_VERSION,
                  roomId: hostState.roomId,
                  timestamp: Date.now(),
                  fromId: 'laptop-host',
                  signal: data.signal,
                }) + '\n',
              );
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
          }

          if (type === 'LOCATION_UPDATE') {
            hostState.locations['laptop-host'] = {
              location: data.location,
              receivedAt: Date.now(),
            };
            broadcastHostMsg({
              type: 'LOCATION_UPDATE',
              protocolVersion: PROTOCOL_VERSION,
              roomId: hostState.roomId,
              timestamp: Date.now(),
              participantId: 'laptop-host',
              location: data.location,
            });
            broadcastEvent('location_update', {
              participantId: 'laptop-host',
              location: data.location,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
          }

          if (type === 'LOCATION_SHARING_STOP') {
            delete hostState.locations['laptop-host'];
            broadcastHostMsg({
              type: 'LOCATION_SHARING_STOP',
              protocolVersion: PROTOCOL_VERSION,
              roomId: hostState.roomId,
              timestamp: Date.now(),
              participantId: 'laptop-host',
            });
            broadcastEvent('location_stop', { participantId: 'laptop-host' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
        }

        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Belum terhubung atau server tidak aktif.' }));
      }

      res.writeHead(404);
      res.end();
    });
    return;
  }

  // Favicon ignore to avoid 404 in browser console
  if (parsed.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  // Serve static files (HTML, JS)
  const reqPath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  const filePath = path.join(__dirname, 'public', reqPath);

  // Security check to avoid path traversal
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.js'
        ? 'application/javascript; charset=utf-8'
        : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.json'
        ? 'application/json'
        : 'text/plain';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`Konvoi Web Tester Siap Digunakan!`);
  console.log(`IP Wi-Fi Laptop: ${LOCAL_IP}`);
  console.log(`Buka di browser laptop Anda:`);
  console.log(`  -> http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
