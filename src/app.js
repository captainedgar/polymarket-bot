const { startWebSocket } = require('./services/websocket');
const prices = startWebSocket();

require('dotenv').config();
const express = require('express');

const app = express();

app.get('/', (req, res) => {
  res.send('🔥 Backend funcionando correctamente');
});

app.listen(5000, () => {
  console.log('🚀 Servidor corriendo en http://localhost:5000');
});