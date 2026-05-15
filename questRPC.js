import DiscordRPC from 'discord-rpc';

let _client = null;
let _status = 'disconnected'; // disconnected | connecting | connected | error
let _game = null;             // { id: string, name: string }
let _startTime = null;        // timestamp ms
let _error = null;            // string | null

export async function startRPC(appId, gameName) {
  if (_client) await stopRPC();

  _status = 'connecting';
  _error = null;
  _game = null;
  _startTime = null;

  return new Promise((resolve) => {
    const rpc = new DiscordRPC.Client({ transport: 'ipc' });

    const timeout = setTimeout(() => {
      rpc.destroy().catch(() => {});
      _status = 'error';
      _error = 'Tempo esgotado. Verifique se o Discord está aberto e logado.';
      resolve({ ok: false, error: _error });
    }, 15000);

    rpc.on('ready', async () => {
      clearTimeout(timeout);
      _client = rpc;
      _status = 'connected';
      _startTime = Date.now();
      _game = { id: String(appId), name: gameName };

      try {
        await rpc.setActivity({
          details: gameName,
          startTimestamp: _startTime,
          instance: false,
        });
      } catch { /* falha ao setar activity é não-fatal */ }

      resolve({ ok: true });
    });

    rpc.login({ clientId: String(appId) }).catch((err) => {
      clearTimeout(timeout);
      _status = 'error';
      _error = err.message || 'Falha ao conectar ao Discord RPC.';
      resolve({ ok: false, error: _error });
    });
  });
}

export async function stopRPC() {
  if (_client) {
    try { _client.destroy(); } catch { /* ignore */ }
    _client = null;
  }
  _status = 'disconnected';
  _game = null;
  _startTime = null;
  _error = null;
}

export function getRPCStatus() {
  return {
    status: _status,
    game: _game,
    startTime: _startTime,
    elapsed: _startTime ? Date.now() - _startTime : 0,
    error: _error,
  };
}
