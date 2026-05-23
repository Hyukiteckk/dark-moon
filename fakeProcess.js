import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { spawn, exec } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __dir = dirname(fileURLToPath(import.meta.url));
// No app compilado, HELPER_EXE aponta para resources/ (extraResources do electron-builder).
const HELPER_EXE = process.env.HELPER_EXE || join(__dir, 'data', 'quest_helper.exe');

let _child = null;
let _fakeExePath = null;
let _tempDir = null;
let _status = { running: false, exeName: null, pid: null };

export async function startFakeProcess(exeName) {
  await stopFakeProcess();

  if (!existsSync(HELPER_EXE)) throw new Error('quest_helper.exe não encontrado em data/');

  const tempDir = join(tmpdir(), `dqh_${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });

  const fakeExe = join(tempDir, exeName);
  await fs.copyFile(HELPER_EXE, fakeExe);

  const child = spawn(fakeExe, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: tempDir,
  });
  child.unref();

  _child = child;
  _fakeExePath = fakeExe;
  _tempDir = tempDir;
  _status = { running: true, exeName, pid: child.pid };

  console.log(`[FakeProcess] Iniciado "${exeName}" PID=${child.pid}`);
  return _status;
}

export async function stopFakeProcess() {
  if (_status.pid) {
    try { await execAsync(`taskkill /F /PID ${_status.pid}`); } catch {}
  }
  if (_status.exeName) {
    try { await execAsync(`taskkill /F /IM "${_status.exeName}"`); } catch {}
  }
  _child = null;
  if (_fakeExePath) {
    try { await fs.unlink(_fakeExePath); } catch {}
    _fakeExePath = null;
  }
  if (_tempDir) {
    try { await fs.rm(_tempDir, { recursive: true, force: true }); } catch {}
    _tempDir = null;
  }
  const prev = _status;
  _status = { running: false, exeName: null, pid: null };
  if (prev.exeName) console.log(`[FakeProcess] Parado "${prev.exeName}"`);
}

export function getFakeStatus() {
  return { ..._status };
}
