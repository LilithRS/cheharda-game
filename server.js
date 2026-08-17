const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
app.use((req, res, next) => {
  console.log(`Запрос: ${req.method} ${req.url}`);
  next();
});
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Health check для Railway
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Хранилище комнат
const rooms = {};

// Генерация кода комнаты
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Перемешивание массива
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Получение комнаты по коду
function getRoom(code) {
  return rooms[code];
}

// Отправка обновлённого списка игроков
function updatePlayersList(roomCode) {
  const room = getRoom(roomCode);
  if (room) {
    io.to(roomCode).emit('updatePlayers', room.players.map(p => ({
      name: p.name,
      isCreator: p.isCreator,
      hasAnswered: room.answers.some(a => a.playerId === p.id),
      isOnline: p.isOnline !== false
    })));
  }
}

// Восстановление игрока после перезагрузки
function reconnectPlayer(roomCode, playerName, socketId, callback) {
  const room = getRoom(roomCode);
  if (!room) return callback({ error: 'Комната не найдена' });
  
  const player = room.players.find(p => p.name === playerName);
  if (!player) return callback({ error: 'Игрок не найден в комнате' });
  
  // Обновляем socket.id у игрока
  player.id = socketId;
  player.isOnline = true;
  socket.join(roomCode);
  
  // Если игра уже идёт, отправляем текущее состояние
  if (room.started) {
    const currentPlayerId = room.order[room.currentTurn];
    const currentPlayer = room.players.find(p => p.id === currentPlayerId);
    
    if (currentPlayerId === socketId) {
      const lastAnswer = room.answers.length > 0 ? room.answers[room.answers.length - 1] : null;
      io.to(socketId).emit('yourTurn', {
        isFirst: room.answers.length === 0,
        question: room.currentQuestion || (lastAnswer ? lastAnswer.question : 'Продолжите историю:')
      });
    } else {
      io.to(socketId).emit('waitingInfo', {
        currentPlayerName: currentPlayer.name,
        totalPlayers: room.players.length
      });
    }
  }
  
  updatePlayersList(roomCode);
  callback({ success: true });
}

io.on('connection', (socket) => {
  console.log('Новое подключение:', socket.id);

  // Создание комнаты
  socket.on('createRoom', (playerName, callback) => {
    const code = generateCode();
    rooms[code] = {
      players: [{ id: socket.id, name: playerName, isCreator: true, isOnline: true }],
      currentTurn: 0,
      currentQuestion: '',
      answers: [],
      started: false,
      finished: false,
      order: [],
      lastFragment: ''
    };
    socket.join(code);
    callback({ code, players: rooms[code].players.map(p => ({ name: p.name, isCreator: p.isCreator })) });
    console.log(`Комната ${code} создана игроком ${playerName}`);
  });

  // Присоединение к комнате
  socket.on('joinRoom', ({ code, playerName }, callback) => {
    const room = getRoom(code);
    if (!room) {
      return callback({ error: 'Комната не найдена' });
    }
    if (room.started && !room.players.some(p => p.name === playerName)) {
      return callback({ error: 'Игра уже началась' });
    }
    if (room.players.some(p => p.name === playerName)) {
      return reconnectPlayer(code, playerName, socket.id, callback);
    }
    room.players.push({ id: socket.id, name: playerName, isCreator: false, isOnline: true });
    socket.join(code);
    updatePlayersList(code);
    callback({ code, players: room.players.map(p => ({ name: p.name, isCreator: p.isCreator })) });
  });

  // Начало игры
  socket.on('startGame', (data, callback) => {
    const { code } = data;
    const room = getRoom(code);
    if (!room) return;
    if (!room.players.find(p => p.id === socket.id)?.isCreator) return;
    if (room.players.length < 2) {
      return callback?.({ error: 'Нужно минимум 2 игрока' });
    }

    room.started = true;
    
    // Случайный порядок игроков
    room.order = shuffleArray(room.players.map(p => p.id));
    room.currentTurn = 0;
    room.currentQuestion = '';

    const firstPlayerId = room.order[0];
    const firstPlayer = room.players.find(p => p.id === firstPlayerId);

    // Первый игрок пишет первую часть текста
    io.to(firstPlayerId).emit('yourTurn', {
      isFirst: true,
      message: 'Вы начинаете историю! Напишите первую часть текста:'
    });

    // Остальным сообщаем, что игра началась
    room.players.forEach(p => {
      if (p.id !== firstPlayerId) {
        io.to(p.id).emit('gameStarted', {
          currentPlayerName: firstPlayer.name,
          totalPlayers: room.players.length
        });
      }
    });

    callback?.({ success: true });
  });

  // Отправка ответа (части истории и вопроса)
  socket.on('submitAnswer', ({ code, text, question, isFirst = false }) => {
    const room = getRoom(code);
    if (!room || room.finished || !room.started) return;

    const currentPlayerId = room.order[room.currentTurn];
    if (socket.id !== currentPlayerId) {
      console.log('Не ваш ход!', socket.id, currentPlayerId);
      return;
    }

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    const player = room.players[playerIndex];

    // Сохраняем ответ
    room.answers.push({
      playerId: player.id,
      playerName: player.name,
      text,
      question: room.currentQuestion || '(начало истории)'
    });

    // Переходим к следующему игроку
    room.currentTurn++;
    if (room.currentTurn >= room.players.length) {
      room.currentTurn = 0;
    }

    room.currentQuestion = question || '';
    room.lastFragment = text;

    const nextPlayerId = room.order[room.currentTurn];
    const nextPlayer = room.players.find(p => p.id === nextPlayerId);

    // Отправляем следующему игроку его ход (без показа предыдущего текста)
    io.to(nextPlayerId).emit('yourTurn', {
      isFirst: false,
      question: question || 'Продолжите историю:'
    });

    updatePlayersList(code);

    // Остальным сообщаем, что ход перешёл
    room.players.forEach(p => {
      if (p.id !== nextPlayerId) {
        io.to(p.id).emit('turnChanged', {
          currentPlayerName: nextPlayer.name,
          totalPlayers: room.players.length
        });
      }
    });
  });

  // Завершение истории
  socket.on('finishStory', ({ code, text }) => {
    const room = getRoom(code);
    if (!room || room.finished) return;

    const currentPlayerId = room.order[room.currentTurn];
    if (socket.id !== currentPlayerId) return;

    // Добавляем текст завершающего игрока как последнюю часть
    if (text && text.trim()) {
      const player = room.players.find(p => p.id === socket.id);
      room.answers.push({
        playerId: player.id,
        playerName: player.name,
        text: text.trim(),
        question: room.currentQuestion || ''
      });
    }

    room.finished = true;

    // Формируем итоговую историю: просто склеиваем все тексты
    const story = room.answers.map(a => a.text).join(' ');

    io.to(code).emit('gameOver', {
      story
    });
  });

  // Отключение игрока
  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players[idx].isOnline = false;
        updatePlayersList(code);
        setTimeout(() => {
          const stillOffline = room.players.every(p => !p.isOnline);
          if (stillOffline) {
            delete rooms[code];
          }
        }, 300000);
      }
    }
  });
});

// HTML-страница (клиентская часть)
const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Чехарда</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f0f2f5; }
    .screen { display: none; max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .screen.active { display: block; }
    input, textarea { width: 100%; padding: 10px; margin: 8px 0; border: 1px solid #ddd; border-radius: 5px; box-sizing: border-box; }
    button { padding: 10px 20px; background: #4CAF50; color: white; border: none; border-radius: 5px; cursor: pointer; margin: 5px; }
    button:hover { background: #45a049; }
    button.finish { background: #f44336; }
    button.finish:hover { background: #d32f2f; }
    #playersList li { list-style: none; padding: 8px; background: #f0f0f0; margin: 4px 0; border-radius: 4px; }
    #story { white-space: pre-wrap; background: #fff; padding: 15px; border-radius: 5px; }
    .waiting-message { color: #666; font-style: italic; padding: 20px; text-align: center; }
  </style>
</head>
<body>
  <!-- Экран входа -->
  <div id="loginScreen" class="screen active">
    <h2>Чехарда</h2>
    <input type="text" id="playerName" placeholder="Ваше имя">
    <input type="text" id="roomCode" placeholder="Код комнаты (если есть)">
    <button onclick="joinRoom()">Присоединиться</button>
    <button onclick="createRoom()">Создать комнату</button>
  </div>

  <!-- Экран ожидания -->
  <div id="waitingScreen" class="screen">
    <h2>Комната: <span id="roomCodeDisplay"></span></h2>
    <p>Игроки:</p>
    <ul id="playersList"></ul>
    <button id="startButton" style="display:none" onclick="startGame()">Начать игру</button>
    <p class="waiting-message" id="waitingMessage">Ожидание других игроков...</p>
  </div>

  <!-- Экран хода -->
  <div id="questionScreen" class="screen">
    <h2 id="turnTitle">Ваш ход!</h2>
    <p id="turnMessage"></p>
    <div id="questionContainer" style="display:none;">
      <strong>Вопрос от предыдущего игрока:</strong>
      <p id="currentQuestion"></p>
    </div>
    <textarea id="answer" rows="4" placeholder="Ваша часть истории..."></textarea>
    <input type="text" id="nextQuestion" placeholder="Ваш вопрос следующему игроку (необязательно)">
    <button onclick="submitTurn()">Отправить</button>
    <button class="finish" onclick="finishStory()">Завершить историю</button>
  </div>

  <!-- Экран финала -->
  <div id="finalScreen" class="screen">
    <h2>Готовая история!</h2>
    <div id="story"></div>
    <button onclick="reset()">Играть снова</button>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    let socket = io({
      transports: ['websocket', 'polling']
    });
    let currentRoomCode = localStorage.getItem('cheharda_room') || '';
    let currentPlayerName = localStorage.getItem('cheharda_name') || '';
    let isCreator = false;
    let isFirstTurn = false;

    // Автоподключение, если есть сохранённые данные
    if (currentRoomCode && currentPlayerName) {
      socket.emit('joinRoom', { code: currentRoomCode, playerName: currentPlayerName }, (res) => {
        if (!res.error) {
          isCreator = res.players?.some(p => p.isCreator && p.name === currentPlayerName) || false;
          document.getElementById('roomCodeDisplay').innerText = currentRoomCode;
          showScreen('waitingScreen');
          document.getElementById('waitingMessage').textContent = 'Переподключение...';
        } else {
          localStorage.removeItem('cheharda_room');
          localStorage.removeItem('cheharda_name');
          showScreen('loginScreen');
        }
      });
    }

    function showScreen(id) {
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      document.getElementById(id).classList.add('active');
    }

    // Создание комнаты
    function createRoom() {
      const name = document.getElementById('playerName').value.trim();
      if (!name) return alert('Введите имя');
      socket.emit('createRoom', name, (res) => {
        currentRoomCode = res.code;
        currentPlayerName = name;
        localStorage.setItem('cheharda_room', currentRoomCode);
        localStorage.setItem('cheharda_name', name);
        isCreator = true;
        document.getElementById('roomCodeDisplay').innerText = currentRoomCode;
        showScreen('waitingScreen');
        document.getElementById('startButton').style.display = 'block';
        document.getElementById('waitingMessage').textContent = 'Вы создатель. Отправьте код друзьям и нажмите "Начать игру", когда все будут готовы.';
      });
    }

    // Присоединение к комнате
    function joinRoom() {
      const name = document.getElementById('playerName').value.trim();
      const code = document.getElementById('roomCode').value.trim().toUpperCase();
      if (!name || !code) return alert('Введите имя и код');
      socket.emit('joinRoom', { code, playerName: name }, (res) => {
        if (res.error) return alert(res.error);
        currentRoomCode = res.code || code;
        currentPlayerName = name;
        localStorage.setItem('cheharda_room', currentRoomCode);
        localStorage.setItem('cheharda_name', name);
        isCreator = res.players?.some(p => p.isCreator && p.name === name) || false;
        document.getElementById('roomCodeDisplay').innerText = currentRoomCode;
        showScreen('waitingScreen');
        document.getElementById('waitingMessage').textContent = 'Ожидание начала игры...';
      });
    }

    // Обновление списка игроков
    socket.on('updatePlayers', (players) => {
      const list = document.getElementById('playersList');
      list.innerHTML = '';
      players.forEach(p => {
        const li = document.createElement('li');
        let status = '';
        if (p.hasAnswered) status = ' ✓ (ответил)';
        if (p.isCreator) status += ' (создатель)';
        if (!p.isOnline) status += ' (оффлайн)';
        li.textContent = p.name + status;
        list.appendChild(li);
      });
    });

    // Начало игры
    function startGame() {
      socket.emit('startGame', { code: currentRoomCode }, (res) => {
        if (res?.error) return alert(res.error);
        document.getElementById('startButton').style.display = 'none';
      });
    }

    // Ваш ход
    socket.on('yourTurn', (data) => {
      showScreen('questionScreen');
      isFirstTurn = data.isFirst;
      
      if (data.isFirst) {
        document.getElementById('turnTitle').textContent = 'Вы начинаете!';
        document.getElementById('turnMessage').textContent = 'Напишите первую часть истории:';
        document.getElementById('questionContainer').style.display = 'none';
      } else {
        document.getElementById('turnTitle').textContent = 'Ваш ход!';
        document.getElementById('turnMessage').textContent = 'Продолжите историю:';
        
        // Показываем только вопрос предыдущего игрока
        if (data.question) {
          document.getElementById('questionContainer').style.display = 'block';
          document.getElementById('currentQuestion').textContent = data.question;
        } else {
          document.getElementById('questionContainer').style.display = 'none';
        }
      }
      
      document.getElementById('answer').value = '';
      document.getElementById('nextQuestion').value = '';
    });

    // Игра началась, но ход не ваш
    socket.on('gameStarted', (data) => {
      showScreen('waitingScreen');
      document.getElementById('waitingMessage').textContent = \`Игра началась! Ходит: \${data.currentPlayerName}\`;
    });

    // Ход перешёл к другому игроку
    socket.on('turnChanged', (data) => {
      showScreen('waitingScreen');
      document.getElementById('waitingMessage').textContent = \`Ходит: \${data.currentPlayerName}. Ожидайте своей очереди...\`;
    });

    // Информация при переподключении (если не ваш ход)
    socket.on('waitingInfo', (data) => {
      showScreen('waitingScreen');
      document.getElementById('waitingMessage').textContent = \`Сейчас ходит: \${data.currentPlayerName}. Ожидайте...\`;
    });

    // Отправка ответа
    function submitTurn() {
      const answer = document.getElementById('answer').value.trim();
      const nextQuestion = document.getElementById('nextQuestion').value.trim();
      if (!answer) return alert('Напишите вашу часть истории');
      
      socket.emit('submitAnswer', {
        code: currentRoomCode,
        text: answer,
        question: nextQuestion,
        isFirst: isFirstTurn
      });
      
      showScreen('waitingScreen');
      document.getElementById('waitingMessage').textContent = 'Ваш ответ отправлен. Ожидайте...';
    }

    // Завершение истории
    function finishStory() {
      const answer = document.getElementById('answer').value.trim();
      if (!answer) {
        alert('Напишите вашу часть истории перед завершением');
        return;
      }
      if (!confirm('Завершить историю? Все увидят полный текст.')) return;
      
      socket.emit('finishStory', { 
        code: currentRoomCode, 
        text: answer 
      });
    }

    // Игра завершена
    socket.on('gameOver', (data) => {
      showScreen('finalScreen');
      document.getElementById('story').textContent = data.story;
      localStorage.removeItem('cheharda_room');
      localStorage.removeItem('cheharda_name');
    });

    // Сброс
    function reset() {
      localStorage.removeItem('cheharda_room');
      localStorage.removeItem('cheharda_name');
      location.reload();
    }
  </script>
</body>
</html>
`;

// Отдаём HTML по основному маршруту
app.get('/', (req, res) => {
  res.send(html);
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});

// Обработка ошибок сервера, чтобы процесс не падал молча
server.on('error', (err) => {
  console.error('Ошибка сервера:', err);
});
