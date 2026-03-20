import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 8080);
const rooms = new Map();

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
      clients: new Map()
    });
  }

  return rooms.get(roomId);
}

function chooseLeader(room) {
  const ids = [...room.clients.keys()].sort();
  return ids.length > 0 ? ids[0] : null;
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

  if (room.clients.get(userId) === ws) {
    room.clients.delete(userId);
  }

  broadcast(room, { type: "peer-left", peerId: userId }, userId);

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

function joinRoom(ws, roomId, userId) {
  if (!roomId || !userId) {
    send(ws, { type: "error", message: "roomId and userId are required" });
    return;
  }

  if (ws.meta.roomId || ws.meta.userId) {
    leaveRoom(ws);
  }

  const room = getRoom(roomId);

  if (room.clients.has(userId) && room.clients.get(userId) !== ws) {
    send(ws, { type: "error", message: "duplicate userId in room" });
    return;
  }

  const peers = [...room.clients.keys()];
  room.clients.set(userId, ws);

  if (!room.leaderId || !room.clients.has(room.leaderId)) {
    room.leaderId = userId;
    room.leaderEpoch += 1;
  }

  ws.meta = { roomId, userId };

  send(ws, {
    type: "joined",
    roomId,
    peers,
    leaderId: room.leaderId,
    leaderEpoch: room.leaderEpoch
  });

  broadcast(room, { type: "peer-joined", peerId: userId }, userId);
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
      joinRoom(ws, String(message.roomId || "").trim().toUpperCase(), String(message.userId || "").trim());
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
