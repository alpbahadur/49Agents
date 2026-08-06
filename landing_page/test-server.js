// Minimal test server — serves static files + logs analytics events
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 1071;
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json'
};

http.createServer(function (req, res) {
  // Analytics ingest
  if (req.method === 'POST' && (req.url === '/api/telemetry/events' || req.url === '/api/analytics/events')) {
    var chunks = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () {
      var body = Buffer.concat(chunks).toString();
      console.log('\x1b[90m[raw] Content-Type:', req.headers['content-type'], '| Length:', body.length, '\x1b[0m');
      try {
        var parsed = JSON.parse(body);
        parsed.events.forEach(function (evt) {
          console.log('\x1b[35m[analytics]\x1b[0m', evt.event_type, JSON.stringify(evt.data));
        });
      } catch (e) {
        console.log('\x1b[31m[analytics] parse error:\x1b[0m', e.message);
        console.log('\x1b[31m[analytics] body:\x1b[0m', body.slice(0, 500));
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end('{"ok":true}');
    });
    return;
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // Static file serving
  var filePath = req.url === '/' ? '/index.html' : req.url;
  if (filePath === '/tutorial') filePath = '/tutorial.html';
  var fullPath = path.join(__dirname, filePath);
  var ext = path.extname(fullPath);

  fs.readFile(fullPath, function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, function () {
  console.log('Test server running at http://localhost:' + PORT);
  console.log('Analytics events will be logged below:\n');
});
