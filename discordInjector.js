import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync, rmdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

function findDiscordResources() {
  const base = join(process.env.LOCALAPPDATA || '', 'Discord');
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base).filter(d => /^app-\d/.test(d)).sort().reverse();
  if (!dirs.length) return null;
  return join(base, dirs[0], 'resources');
}

export function getInjectStatus() {
  const res = findDiscordResources();
  if (!res) return { discordFound: false, injected: false };
  return {
    discordFound: true,
    injected: existsSync(join(res, 'app', '_orion_marker')),
    resourcesDir: res
  };
}

export function injectIntoDiscord() {
  const res = findDiscordResources();
  if (!res) throw new Error('Discord não encontrado em %LOCALAPPDATA%\\Discord');

  const appDir = join(res, 'app');
  mkdirSync(appDir, { recursive: true });

  // Main-process index.js:
  // - All server communication via Node.js http (no CSP, no mixed-content issues)
  // - Polls /api/orion/command from main process
  // - Finds Discord's main window (webpackChunkdiscord_app present)
  // - Executes orion_script.js via executeJavaScript when command is 'start'
  // - Reads window._orionProgressQueue every second and POSTs updates to server
  const indexJs = `"use strict";
var electron = require("electron");
var http = require("http");
var path = require("path");

var HOST = '127.0.0.1';
var PORT = 4100;

function httpGet(urlPath, cb) {
  var req = http.request({ hostname: HOST, port: PORT, path: urlPath, method: 'GET' }, function(res) {
    var data = '';
    res.setEncoding('utf8');
    res.on('data', function(c) { data += c; });
    res.on('end', function() { cb(null, data); });
  });
  req.setTimeout(8000, function() { req.destroy(); });
  req.on('error', function(e) { cb(e); });
  req.end();
}

function httpPost(urlPath, jsonBody) {
  try {
    var data = JSON.stringify(jsonBody);
    var req = http.request({
      hostname: HOST, port: PORT, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, function(r) { r.resume(); });
    req.setTimeout(5000, function() { req.destroy(); });
    req.on('error', function() {});
    req.write(data);
    req.end();
  } catch(e) {}
}

var _mainWC = null;
var _running = false;
var _scriptCode = null;

function runScript(wc) {
  if (!_scriptCode) {
    httpGet('/orion_script.js', function(err, code) {
      if (err || !code) { _running = false; return; }
      _scriptCode = code;
      execScript(wc);
    });
  } else {
    execScript(wc);
  }
}

function execScript(wc) {
  if (!wc || wc.isDestroyed()) { _running = false; return; }
  // Check orionLock before running to avoid double-execution
  wc.executeJavaScript('!!window.orionLock').then(function(locked) {
    if (locked) { _running = false; return; }
    _running = true;
    wc.executeJavaScript(_scriptCode)
      .then(function() { _running = false; })
      .catch(function() { _running = false; });
  }).catch(function() { _running = false; });
}

function pollCommand() {
  // This GET also updates _bridgeLastSeen on the server (proves main process is running)
  httpGet('/api/orion/command', function(err, text) {
    if (err) return;
    try {
      var d = JSON.parse(text);
      if (d.command === 'start' && !_running) {
        if (_mainWC && !_mainWC.isDestroyed()) {
          runScript(_mainWC);
        }
      } else if (d.command === 'idle') {
        _running = false;
      }
    } catch(e) {}
  });
}

function flushProgressQueue() {
  if (!_mainWC || _mainWC.isDestroyed()) { _mainWC = null; return; }
  _mainWC.executeJavaScript(
    '(function(){var q=window._orionProgressQueue;if(!q||!q.length)return"[]";window._orionProgressQueue=[];return JSON.stringify(q);})()'
  ).then(function(json) {
    if (!json || json === '[]') return;
    try {
      var items = JSON.parse(json);
      for (var i = 0; i < items.length; i++) { httpPost('/api/orion/progress', items[i]); }
    } catch(e) {}
  }).catch(function() { _mainWC = null; });
}

// When a new window is created, check if it's Discord's main window
electron.app.on('web-contents-created', function(_, contents) {
  contents.on('did-finish-load', function() {
    if (_mainWC && !_mainWC.isDestroyed()) return;
    setTimeout(function() {
      contents.executeJavaScript('typeof webpackChunkdiscord_app !== "undefined"')
        .then(function(ok) { if (ok) _mainWC = contents; })
        .catch(function() {});
    }, 3000);
  });
  contents.on('destroyed', function() {
    if (_mainWC === contents) { _mainWC = null; _running = false; }
  });
});

electron.app.whenReady().then(function() {
  setInterval(pollCommand, 2000);
  setInterval(flushProgressQueue, 1000);
  // Ping server on startup to confirm main-process injection is active
  setTimeout(function() { httpGet('/api/orion/command', function() {}); }, 2000);
});

require(path.join(__dirname, '..', 'app.asar'));
`;

  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'discord', version: '0.0.1', main: 'index.js' }));
  writeFileSync(join(appDir, 'index.js'), indexJs);
  writeFileSync(join(appDir, '_orion_marker'), new Date().toISOString());

  return { resourcesDir: res, appDir };
}

export function removeInjection() {
  const res = findDiscordResources();
  if (!res) return;
  const appDir = join(res, 'app');
  for (const f of ['index.js', 'package.json', '_orion_marker']) {
    try { unlinkSync(join(appDir, f)); } catch {}
  }
}
