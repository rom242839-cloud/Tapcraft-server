const { WebSocketServer } = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Tap Craft Server is running!');
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.playerId = Math.random().toString(36).substr(2, 9);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }

    if (msg.type === 'join') {
      const roomId = String(msg.roomId).toLowerCase();
      if (!rooms.has(roomId)) rooms.set(roomId, { players: [], taps: {} });
      const room = rooms.get(roomId);
      if (room.players.length >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Комната заполнена' }));
        return;
      }
      ws.roomId = roomId;
      ws.playerName = msg.name;
      room.players.push(ws);
      room.taps[ws.playerId] = 0;
      ws.send(JSON.stringify({ type: 'joined', playerId: ws.playerId }));
      if (room.players.length === 2) {
        room.players.forEach(p => p.send(JSON.stringify({ type: 'start' })));
      }
      return;
    }

    if (msg.type === 'tap' && ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room && room.taps[ws.playerId] !== undefined) {
        room.taps[ws.playerId]++;
        const scores = {};
        room.players.forEach(p => scores[p.playerId] = room.taps[p.playerId]);
        room.players.forEach(p => p.send(JSON.stringify({ type: 'scores', scores })));
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomId && rooms.has(ws.roomId)) {
      const room = rooms.get(ws.roomId);
      room.players = room.players.filter(p => p !== ws);
      if (room.players.length === 0) rooms.delete(ws.roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server on port ' + PORT));
