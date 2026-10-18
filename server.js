'use strict';
require('./scripts/load-env');
const { open } = require('./src/db');
const { createApp } = require('./src/app');
const { ensureInitialManager } = require('./scripts/bootstrap');

const db = open(process.env.DATABASE_PATH || './data/nm-school.db');
ensureInitialManager(db);
const port = Number(process.env.PORT || 3000);
const server = createApp(db).listen(port, () => console.log(`Nalla Malayalam school app listening on http://localhost:${port}`));

function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
