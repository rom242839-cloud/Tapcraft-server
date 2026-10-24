const { WebSocketServer } = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Tap Craft Server is running!');
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
const friends = new Map();
const onlineUsers = new Map();
const pendingGifts = new Map();
const matchQueue = []; // 🔥 ОЧЕРЕДЬ ПОИСКА
const MAX_PLAYERS = 3;

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.playerId = Math.random().toString(36).substr(2, 9);
  ws.userKey = null;
  ws.inQueue = false;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }

    // ===== АВТОРИЗАЦИЯ =====
    if (msg.type === 'auth') {
      const key = String(msg.name || '').toLowerCase();
      if (!key) return;
      ws.userKey = key;
      ws.playerName = msg.name;
      onlineUsers.set(key, ws);
      send(ws, { type: 'auth_ok' });
      notifyFriends(key, { type: 'friend_online', friend: msg.name });
      const gifts = pendingGifts.get(key) || [];
      if (gifts.length > 0) {
        send(ws, { type: 'gifts', gifts });
        pendingGifts.delete(key);
      }
      return;
    }

    // ===== 🔥 ПОИСК СЛУЧАЙНОГО ИГРОКА =====
    if (msg.type === 'find_match') {
      if (!ws.userKey) { send(ws, { type: 'match_error', message: 'Сначала войди' }); return; }
      if (ws.inQueue) return;
      
      // Убираем из очереди, если уже там (защита от дублей)
      const existingIdx = matchQueue.findIndex(p => p.ws === ws);
      if (existingIdx >= 0) matchQueue.splice(existingIdx, 1);
      
      ws.inQueue = true;
      matchQueue.push({ ws, name: ws.playerName, id: ws.playerId, joinedAt: Date.now() });
      
      send(ws, { type: 'match_waiting', count: matchQueue.length });
      
      // Пытаемся собрать комнату
      tryCreateMatchRoom();
      return;
    }

    if (msg.type === 'cancel_match') {
      ws.inQueue = false;
      const idx = matchQueue.findIndex(p => p.ws === ws);
      if (idx >= 0) matchQueue.splice(idx, 1);
      send(ws, { type: 'match_cancelled' });
      return;
    }

    // ===== ДРУЗЬЯ (без изменений) =====
    if (msg.type === 'add_friend') {
      if (!ws.userKey) return;
      const targetKey = String(msg.targetName || '').toLowerCase();
      const targetName = msg.targetName;
      if (!targetKey || targetKey === ws.userKey) {
        send(ws, { type: 'friend_error', message: 'Нельзя добавить себя' });
        return;
      }
      if (!onlineUsers.has(targetKey) && !globalAllUsers.has(targetKey)) {
        send(ws, { type: 'friend_error', message: 'Игрок не найден' });
        return;
      }
      if (!friends.has(ws.userKey)) friends.set(ws.userKey, new Set());
      if (!friends.has(targetKey)) friends.set(targetKey, new Set());
      friends.get(ws.userKey).add(targetKey);
      friends.get(targetKey).add(ws.userKey);
      send(ws, { type: 'friend_added', name: targetName });
      const targetWs = onlineUsers.get(targetKey);
      if (targetWs) send(targetWs, { type: 'friend_added', name: msg.myName });
      return;
    }

    if (msg.type === 'remove_friend') {
      if (!ws.userKey) return;
      const targetKey = String(msg.targetName || '').toLowerCase();
      if (friends.has(ws.userKey)) friends.get(ws.userKey).delete(targetKey);
      if (friends.has(targetKey)) friends.get(targetKey).delete(ws.userKey);
      send(ws, { type: 'friend_removed', name: msg.targetName });
      const targetWs = onlineUsers.get(targetKey);
      if (targetWs) send(targetWs, { type: 'friend_removed', name: msg.myName });
      return;
    }

    if (msg.type === 'get_friends') {
      if (!ws.userKey) return;
      const list = Array.from(friends.get(ws.userKey) || []);
      const result = list.map(k => ({
        key: k,
        name: msg.allUsers?.[k] || k,
        online: onlineUsers.has(k)
      }));
      send(ws, { type: 'friends_list', friends: result });
      return;
    }

    if (msg.type === 'send_gift') {
      if (!ws.userKey) return;
      const targetKey = String(msg.targetName || '').toLowerCase();
      if (!friends.get(ws.userKey)?.has(targetKey)) {
        send(ws, { type: 'gift_error', message: 'Не в друзьях' });
        return;
      }
      if (!pendingGifts.has(targetKey)) pendingGifts.set(targetKey, []);
      pendingGifts.get(targetKey).push({ from: msg.myName, amount: msg.amount || 1, time: Date.now() });
      send(ws, { type: 'gift_sent', to: msg.targetName });
      const targetWs = onlineUsers.get(targetKey);
      if (targetWs) send(targetWs, { type: 'gift_received', from: msg.myName, amount: msg.amount || 1 });
      return;
    }

    // ===== ДУЭЛЬ (ручная комната) =====
    if (msg.type === 'join') {
      const roomId = String(msg.roomId || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      const name = String(msg.name || 'Игрок').slice(0, 16);
      if (!roomId || !name) { send(ws, { type: 'error', message: 'Неверные данные' }); return; }

      let room = rooms.get(roomId);
      if (!room) {
        room = { players: [], taps: {}, started: false, timer: null, endTimer: null, startTime: 0 };
        rooms.set(roomId, room);
      }
      if (room.started) { send(ws, { type: 'error', message: 'Игра уже идёт' }); return; }
      if (room.players.length >= MAX_PLAYERS) { send(ws, { type: 'error', message: 'Комната заполнена (макс 3)' }); return; }
      if (room.players.some(p => p.name === name)) { send(ws, { type: 'error', message: 'Такое имя уже в комнате' }); return; }

      ws.roomId = roomId;
      ws.playerName = name;
      room.players.push({ ws, name, id: ws.playerId });
      room.taps[ws.playerId] = 0;
      send(ws, { type: 'joined', playerId: ws.playerId });
      broadcast(room, {
        type: 'room_update',
        players: room.players.map(p => ({ id: p.id, name: p.name })),
        count: room.players.length
      });
      if (room.players.length >= 2 && !room.started) {
        room.started = true;
        room.startTime = Date.now();
        room.taps = {};
        room.players.forEach(p => room.taps[p.id] = 0);
        room.timer = setTimeout(() => {
          broadcast(room, {
            type: 'start',
            duration: 20,
            players: room.players.map(p => ({ id: p.id, name: p.name }))
          });
        }, 2000);
        room.endTimer = setTimeout(() => { finishRoom(roomId); }, 22000);
      }
      return;
    }

    if (msg.type === 'tap') {
      const room = rooms.get(ws.roomId);
      if (!room || !room.started) return;
      if (room.taps[ws.playerId] === undefined) return;
      room.taps[ws.playerId]++;
      const scores = {};
      room.players.forEach(p => scores[p.id] = room.taps[p.id] || 0);
      broadcast(room, { type: 'scores', scores });
      return;
    }

    if (msg.type === 'leave') { leaveRoom(ws); return; }
  });

  ws.on('close', () => {
    if (ws.userKey) {
      onlineUsers.delete(ws.userKey);
      notifyFriends(ws.userKey, { type: 'friend_offline', friend: ws.userKey });
    }
    // Убираем из очереди
    ws.inQueue = false;
    const idx = matchQueue.findIndex(p => p.ws === ws);
    if (idx >= 0) matchQueue.splice(idx, 1);
    leaveRoom(ws);
  });
  ws.on('error', () => {});
});

const globalAllUsers = new Map();

function send(ws, obj) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch(e) {} }
}
function broadcast(room, obj) {
  const data = JSON.stringify(obj);
  room.players.forEach(p => { if (p.ws.readyState === 1) { try { p.ws.send(data); } catch(e) {} } });
}
function notifyFriends(userKey, obj) {
  const list = friends.get(userKey) || new Set();
  list.forEach(k => {
    const ws = onlineUsers.get(k);
    if (ws) send(ws, obj);
  });
}

// 🔥 СОЗДАНИЕ КОМНАТЫ ИЗ ОЧЕРЕДИ
function tryCreateMatchRoom() {
  if (matchQueue.length < 2) return;
  
  // Берём до 3 игроков из очереди
  const count = Math.min(matchQueue.length, MAX_PLAYERS);
  const players = matchQueue.splice(0, count);
  
  // Генерируем случайный код комнаты
  const roomId = 'random_' + Math.random().toString(36).substr(2, 8);
  
  const room = { players: [], taps: {}, started: false, timer: null, endTimer: null, startTime: 0 };
  rooms.set(roomId, room);
  
  players.forEach(p => {
    p.ws.inQueue = false;
    p.ws.roomId = roomId;
    p.ws.playerName = p.name;
    room.players.push({ ws: p.ws, name: p.name, id: p.id });
    room.taps[p.id] = 0;
    send(p.ws, { type: 'joined', playerId: p.id });
  });
  
  broadcast(room, {
    type: 'room_update',
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    count: room.players.length
  });
  
  // Стартуем через 2 секунды (ждём третьего, если есть)
  room.started = true;
  room.startTime = Date.now();
  room.timer = setTimeout(() => {
    broadcast(room, {
      type: 'start',
      duration: 20,
      players: room.players.map(p => ({ id: p.id, name: p.name }))
    });
  }, 2000);
  room.endTimer = setTimeout(() => { finishRoom(roomId); }, 22000);
}

function leaveRoom(ws) {
  if (!ws.roomId) return;
  const room = rooms.get(ws.roomId);
  if (!room) return;
  room.players = room.players.filter(p => p.ws !== ws);
  delete room.taps[ws.playerId];
  if (room.players.length === 0) {
    if (room.timer) clearTimeout(room.timer);
    if (room.endTimer) clearTimeout(room.endTimer);
    rooms.delete(ws.roomId);
  } else {
    broadcast(room, {
      type: 'room_update',
      players: room.players.map(p => ({ id: p.id, name: p.name })),
      count: room.players.length
    });
    if (room.started && room.players.length < 2) {
      if (room.endTimer) clearTimeout(room.endTimer);
      finishRoom(ws.roomId);
    }
  }
  ws.roomId = null;
}

function finishRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (room.endTimer) { clearTimeout(room.endTimer); room.endTimer = null; }
  const scores = {};
  room.players.forEach(p => scores[p.id] = room.taps[p.id] || 0);
  let maxScore = -1, winners = [];
  room.players.forEach(p => {
    const s = scores[p.id] || 0;
    if (s > maxScore) { maxScore = s; winners = [p.id]; }
    else if (s === maxScore) winners.push(p.id);
  });
  broadcast(room, {
    type: 'duel_end',
    scores, winners,
    players: room.players.map(p => ({ id: p.id, name: p.name }))
  });
  room.started = false;
  room.taps = {};
  setTimeout(() => { if (rooms.has(roomId)) rooms.delete(roomId); }, 5000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server on port ' + PORT));
