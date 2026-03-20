import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 8080);
const rooms = new Map();

function normalizeDisplayName(raw) {
  return String(raw || "")
    .replace(/[\s\u00A0]+/g, " ")
    .trim()
    .slice(0, 32);
}

function fallbackDisplayName(userId) {
  const suffix = String(userId || "user").slice(-4);
  return `User-${suffix}`;
}

function send(ws, payload) {
  if (!ws || ws.readyState !== 1) {
    return;
  }

  const body = payload && typeof payload === "object"
    ? { ...payload, serverTime: Date.now() }
    : payload;

  ws.send(JSON.stringify(body));
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      leaderId: null,
      leaderEpoch: 0,
      clients: new Map(),
      displayNames: new Map()
    });
  }

  return rooms.get(roomId);
}

function chooseLeader(room) {
  const ids = [...room.clients.keys()].sort();
  return ids.length > 0 ? ids[0] : null;
}

function peerNamesObject(room) {
  return Object.fromEntries(room.displayNames.entries());
}

function broadcast(room, payload, exceptUserId = null) {
  room.clients.forEach((clientWs, userId) => {
    if (exceptUserId && userId === exceptUserId) {
      return;
    }
    send(clientWs, payload);
  });
}

function leaveRoom(ws) {
  const meta = ws.meta;
  if (!meta || !meta.roomId || !meta.userId) {
    return;
  }

  const room = rooms.get(meta.roomId);
  if (!room) {
    ws.meta = { roomId: null, userId: null };
    return;
  }

  const { roomId, userId } = meta;
  const isCurrentConnection = room.clients.get(userId) === ws;
  if (!isCurrentConnection) {
    ws.meta = { roomId: null, userId: null };
    return;
  }

  const displayName = room.displayNames.get(userId) || fallbackDisplayName(userId);

  room.clients.delete(userId);
  room.displayNames.delete(userId);
  broadcast(room, { type: "peer-left", peerId: userId, displayName }, userId);

  const wasLeader = room.leaderId === userId;

  if (room.clients.size === 0) {
    rooms.delete(roomId);
  } else if (wasLeader) {
    room.leaderId = chooseLeader(room);
    room.leaderEpoch += 1;
    broadcast(room, { type: "leader-changed", leaderId: room.leaderId, leaderEpoch: room.leaderEpoch });
  }

  ws.meta = { roomId: null, userId: null };
}

function sendJoined(ws, room, roomId, userId, displayName) {
  const peers = [...room.clients.keys()].filter((id) => id !== userId);

  send(ws, {
    type: "joined",
    roomId,
    peers,
    peerNames: peerNamesObject(room),
    displayName,
    leaderId: room.leaderId,
    leaderEpoch: room.leaderEpoch
  });
}

function joinRoom(ws, roomId, userId, requestedDisplayName) {
  if (!roomId || !userId) {
    send(ws, { type: "error", message: "roomId and userId are required" });
    return;
  }

  const displayName = normalizeDisplayName(requestedDisplayName) || fallbackDisplayName(userId);

  if (ws.meta.roomId === roomId && ws.meta.userId === userId) {
    const room = getRoom(roomId);
    room.clients.set(userId, ws);
    room.displayNames.set(userId, displayName);

    if (!room.leaderId || !room.clients.has(room.leaderId)) {
      room.leaderId = chooseLeader(room) || userId;
      room.leaderEpoch += 1;
    }

    sendJoined(ws, room, roomId, userId, displayName);
    return;
  }

  if (ws.meta.roomId || ws.meta.userId) {
    leaveRoom(ws);
  }

  const room = getRoom(roomId);

  const existingWs = room.clients.get(userId);
  if (existingWs && existingWs !== ws) {
    existingWs.meta = { roomId: null, userId: null };
    try {
      existingWs.close(4001, "session-replaced");
    } catch (error) {
      // no-op
    }
    room.clients.delete(userId);
    room.displayNames.delete(userId);
  }

  room.clients.set(userId, ws);
  room.displayNames.set(userId, displayName);

  if (!room.leaderId || !room.clients.has(room.leaderId)) {
    room.leaderId = userId;
    room.leaderEpoch += 1;
  }

  ws.meta = { roomId, userId };

  sendJoined(ws, room, roomId, userId, displayName);
  broadcast(room, { type: "peer-joined", peerId: userId, displayName }, userId);
}

function relaySignal(ws, to, payload) {
  const { roomId, userId } = ws.meta || {};
  if (!roomId || !userId) {
    send(ws, { type: "error", message: "join a room before relaying signals" });
    return;
  }

  if (!to) {
    send(ws, { type: "error", message: "relay target is required" });
    return;
  }

  const room = rooms.get(roomId);
  if (!room) {
    send(ws, { type: "error", message: "room not found" });
    return;
  }

  const targetWs = room.clients.get(to);
  if (!targetWs) {
    send(ws, { type: "error", message: `peer ${to} not found` });
    return;
  }

  send(targetWs, {
    type: "signal",
    from: userId,
    payload
  });
}

const wss = new WebSocketServer({ port });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.meta = { roomId: null, userId: null };

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let message;
    ws.isAlive = true;

    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      send(ws, { type: "error", message: "invalid json" });
      return;
    }

    if (!message || typeof message !== "object" || !message.type) {
      send(ws, { type: "error", message: "invalid message" });
      return;
    }

    if (message.type === "join") {
      joinRoom(
        ws,
        String(message.roomId || "").trim().toUpperCase(),
        String(message.userId || "").trim(),
        String(message.displayName || "")
      );
      return;
    }

    if (message.type === "relay") {
      relaySignal(ws, message.to, message.payload);
      return;
    }

    if (message.type === "leave") {
      leaveRoom(ws);
      return;
    }

    if (message.type === "ping") {
      send(ws, { type: "pong", timestamp: Number.isFinite(message.timestamp) ? message.timestamp : Date.now() });
      return;
    }

    if (message.type === "pong") {
      return;
    }

    send(ws, { type: "error", message: `unsupported type: ${message.type}` });
  });

  ws.on("close", () => {
    leaveRoom(ws);
  });

  ws.on("error", () => {
    leaveRoom(ws);
  });
});

const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => {
  clearInterval(heartbeatTimer);
});

console.log(`[signaling] WebSocket server running on ws://localhost:${port}`);
