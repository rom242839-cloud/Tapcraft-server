const { WebSocketServer } = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Tap Craft Server is running!');
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
const MAX_PLAYERS = 3;

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.playerId = Math.random().toString(36).substr(2, 9);
  ws.playerName = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }

    // ===== ВХОД В КОМНАТУ =====
    if (msg.type === 'join') {
      const roomId = String(msg.roomId || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      const name = String(msg.name || 'Игрок').slice(0, 16);
      if (!roomId || !name) {
        ws.send(JSON.stringify({ type: 'error', message: 'Неверные данные' }));
        return;
      }

      let room = rooms.get(roomId);
      if (!room) {
        room = { players: [], taps: {}, started: false, timer: null, startTime: 0 };
        rooms.set(roomId, room);
      }

      // Комната уже играет или заполнена
      if (room.started) {
        ws.send(JSON.stringify({ type: 'error', message: 'Игра уже идёт' }));
        return;
      }
      if (room.players.length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'error', message: 'Комната заполнена (макс 3)' }));
        return;
      }
      // Дубликат имени
      if (room.players.some(p => p.name === name)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Такое имя уже в комнате' }));
        return;
      }

      ws.roomId = roomId;
      ws.playerName = name;
      room.players.push({ ws, name, id: ws.playerId });
      room.taps[ws.playerId] = 0;

      // Отправляем ID
      ws.send(JSON.stringify({ type: 'joined', playerId: ws.playerId }));

      // Сообщаем всем список игроков
      broadcast(room, {
        type: 'room_update',
        players: room.players.map(p => ({ id: p.id, name: p.name })),
        count: room.players.length
      });

      // Если 2+ игроков — стартуем через 2 сек (ждём третьего)
      if (room.players.length >= 2 && !room.started) {
        room.started = true;
        room.startTime = Date.now();
        room.taps = {};
        room.players.forEach(p => room.taps[p.id] = 0);

        // Даём 2 сек на подключение третьего
        room.timer = setTimeout(() => {
          broadcast(room, {
            type: 'start',
            duration: 20,
            players: room.players.map(p => ({ id: p.id, name: p.name }))
          });
        }, 2000);

        // Таймер на конец боя — 22 сек (2 сек ожидания + 20 сек боя)
        room.endTimer = setTimeout(() => {
          finishRoom(roomId);
        }, 22000);
      }
      return;
    }

    // ===== ТАП =====
    if (msg.type === 'tap') {
      const room = rooms.get(ws.roomId);
      if (!room || !room.started) return;
      if (room.taps[ws.playerId] === undefined) return;
      room.taps[ws.playerId]++;

      // Рассылаем счёт всем
      const scores = {};
      room.players.forEach(p => scores[p.id] = room.taps[p.id] || 0);
      broadcast(room, { type: 'scores', scores });
      return;
    }

    // ===== ВЫХОД =====
    if (msg.type === 'leave') {
      leaveRoom(ws);
      return;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

function broadcast(room, obj) {
  const data = JSON.stringify(obj);
  room.players.forEach(p => {
    if (p.ws.readyState === 1) {
      try { p.ws.send(data); } catch(e) {}
    }
  });
}

function leaveRoom(ws) {
  if (!ws.roomId) return;
  const room = rooms.get(ws.roomId);
  if (!room) return;

  room.players = room.players.filter(p => p.ws !== ws);
  delete room.taps[ws.playerId];

  if (room.players.length === 0) {
    // Удаляем комнату полностью
    if (room.timer) clearTimeout(room.timer);
    if (room.endTimer) clearTimeout(room.endTimer);
    rooms.delete(ws.roomId);
    console.log('Комната удалена:', ws.roomId);
  } else {
    broadcast(room, {
      type: 'room_update',
      players: room.players.map(p => ({ id: p.id, name: p.name })),
      count: room.players.length
    });
    // Если кто-то вышел во время игры и остался один — завершаем
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

  // Определяем победителей (может быть ничья)
  let maxScore = -1;
  let winners = [];
  room.players.forEach(p => {
    const s = scores[p.id] || 0;
    if (s > maxScore) { maxScore = s; winners = [p.id]; }
    else if (s === maxScore) winners.push(p.id);
  });

  broadcast(room, {
    type: 'duel_end',
    scores,
    winners,
    players: room.players.map(p => ({ id: p.id, name: p.name }))
  });

  // Удаляем комнату через 5 секунд
  room.started = false;
  room.taps = {};
  setTimeout(() => {
    const r = rooms.get(roomId);
    if (r) {
      rooms.delete(roomId);
      console.log('Комната удалена после боя:', roomId);
    }
  }, 5000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server on port ' + PORT));
