const { app, BrowserWindow, shell, dialog } = require("electron");
const path = require("path");
const { fork } = require("child_process");
const http = require("http");
const { autoUpdater } = require("electron-updater");

let win = null;
let serverProcess = null;
let serverPort = 4100;

function waitForServer(port, retries, cb) {
  const req = http.get(`http://127.0.0.1:${port}/api/ping`, (res) => {
    if (res.statusCode === 200) { res.resume(); cb(null, port); }
    else { res.resume(); retry(); }
  });
  req.on("error", retry);
  req.setTimeout(800, () => { req.destroy(); retry(); });
  function retry() {
    if (retries <= 0) return cb(new Error("Server timeout"));
    setTimeout(() => waitForServer(port, retries - 1, cb), 500);
  }
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    frame: true,
    title: "Discord Manager",
    backgroundColor: "#070d1a",
  });
  win.loadURL(`http://127.0.0.1:${port}`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => { win = null; });
}

app.whenReady().then(() => {
  const serverPath = path.join(__dirname, "..", "server.js");

  // No app compilado usa AppData para dados graváveis; em dev usa data/ local.
  const dataRoot = app.isPackaged
    ? path.join(app.getPath("userData"), "data")
    : path.join(__dirname, "..", "data");

  const helperExe = app.isPackaged
    ? path.join(process.resourcesPath, "quest_helper.exe")
    : path.join(__dirname, "..", "data", "quest_helper.exe");

  serverProcess = fork(serverPath, [], {
    env: {
      ...process.env,
      PORT: String(serverPort),
      ELECTRON_MODE: "1",
      ELECTRON_RUN_AS_NODE: "1",
      DATA_ROOT: dataRoot,
      HELPER_EXE: helperExe,
      BOT_SERVICE_URL: "https://darkmoon-bot.abinhomartins.workers.dev",
      BOT_SECRET: "26f70cce3ca6923f90e821d313ded9be9640f1b8f6f196a6122d3d9a84d54362",
    },
    execPath: process.execPath,
    stdio: "pipe",
  });
  serverProcess.stdout?.on("data", (d) => process.stdout.write(d));
  serverProcess.stderr?.on("data", (d) => process.stderr.write(d));

  // Usa APENAS o IPC para saber a porta real — evita conectar em servidor antigo
  serverProcess.on("message", (msg) => {
    if (msg?.type === "port" && msg.port) {
      serverPort = msg.port;
      if (!win) createWindow(serverPort);
    }
  });

  // Fallback só se o IPC não chegar em 15 segundos
  setTimeout(() => {
    if (win) return;
    waitForServer(serverPort, 30, (err, port) => {
      if (!win) {
        if (!err) createWindow(port || serverPort);
        else { console.error("Servidor não iniciou."); app.quit(); }
      }
    });
  }, 15000);
});

app.on("window-all-closed", () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess) serverProcess.kill();
});

// ─── AUTO UPDATER ───
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on("update-downloaded", async () => {
  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "Dark Moon — Atualização pronta",
    message: "Nova versão baixada!",
    detail: "A atualização foi baixada. Deseja reiniciar agora para instalar?",
    buttons: ["Reiniciar agora", "Mais tarde"],
    defaultId: 0,
    icon: path.join(__dirname, "..", "build-assets", "icon.png"),
  });
  if (response === 0) autoUpdater.quitAndInstall();
});

autoUpdater.on("error", (err) => {
  console.error("[updater]", err?.message ?? err);
});

app.whenReady().then(() => {
  // Verifica atualização 6s após iniciar (só no app compilado)
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates(), 6000);
  }
});
