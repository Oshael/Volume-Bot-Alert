'use strict';

process.env.NODE_ENV = 'test';
process.env.ROBINHOOD_USER_VISIBILITY_ENABLED = 'true';

const express = require('express');
const robinhoodTradesRoutes = require('../../src/routes/robinhood-trades');

const app = express();
app.use(express.json());
app.use('/api/robinhood', robinhoodTradesRoutes);

const server = app.listen(0, '127.0.0.1', () => {
  if (process.send) process.send({ type: 'ready', port: server.address().port });
});

function stop() {
  server.close(() => process.exit(0));
}

process.on('message', (message) => {
  if (message?.type === 'stop') stop();
});
process.once('SIGTERM', stop);
