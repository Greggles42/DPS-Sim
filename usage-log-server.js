/**
 * Minimal usage-log collector for DPS-Sim.
 * Run: node usage-log-server.js
 * Saves POST body (JSON) to usage-log.jsonl (one line per run).
 * Set USAGE_LOG_URL in index.html to http://localhost:PORT/log (see port below).
 * Not part of the main UI; for your own analytics only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const LOG_FILE = path.join(__dirname, 'usage-log.jsonl');

const server = http.createServer(function (req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/log') {
    let body = '';
    req.on('data', function (chunk) { body += chunk; });
    req.on('end', function () {
      try {
        const payload = JSON.parse(body);
        const line = JSON.stringify(payload) + '\n';
        fs.appendFileSync(LOG_FILE, line);
      } catch (_e) {
        // ignore parse errors
      }
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      });
      res.end('{}');
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, function () {
  console.log('Usage log collector: http://localhost:' + PORT + '/log');
  console.log('Log file: ' + LOG_FILE);
});
