const { app, BrowserWindow, shell, dialog } = require("electron");
const path = require("path");
const { fork } = require("child_process");
const http = require("http");
const fs = require("fs");

let autoUpdater;
try {
  autoUpdater = require("electron-updater").autoUpdater;
} catch {
  autoUpdater = null;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  } catch {
    return {};
  }
}
const botConfig = loadConfig();

// Isolate session storage: Admin and Membro must never share cookies
{
  const suffix = (botConfig.MASTER_ADMIN || botConfig.BOT_SECRET) ? "Admin" : "Membro";
  app.setPath("userData", require("path").join(app.getPath("appData"), `DarkMoon-${suffix}`));
}

let win = null;
let serverProcess = null;
let serverPort = 4100;
let serverReady = false;

const SPLASH_PATH = path.join(__dirname, "splash.html");
const ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico")
  : path.join(__dirname, "..", "build-assets", "icon.ico");

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    frame: true,
    title: "Dark Moon",
    icon: ICON_PATH,
    backgroundColor: "#070d1a",
    show: false,
  });

  win.loadFile(SPLASH_PATH);

  win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => { win = null; });
}

function navigateToApp() {
  if (win && !win.isDestroyed()) {
    win.loadURL(`http://127.0.0.1:${serverPort}`);
  }
}

function waitForServer(port, retries, cb) {
  const req = http.get(`http://127.0.0.1:${port}/api/ping`, (res) => {
    if (res.statusCode === 200) { res.resume(); cb(null, port); }
    else { res.resume(); retry(); }
  });
  req.on("error", retry);
  req.setTimeout(600, () => { req.destroy(); retry(); });
  function retry() {
    if (retries <= 0) return cb(new Error("timeout"));
    setTimeout(() => waitForServer(port, retries - 1, cb), 400);
  }
}

app.whenReady().then(() => {
  // Abre janela imediatamente com loading
  createWindow();

  const serverPath = path.join(__dirname, "..", "server.js");

  const dataRoot = app.isPackaged
    ? path.join(app.getPath("userData"), "data")
    : path.join(__dirname, "..", "data");

  const helperExe = app.isPackaged
    ? path.join(process.resourcesPath, "quest_helper.exe")
    : path.join(__dirname, "..", "data", "quest_helper.exe");

  const forkEnv = {
    ...process.env,
    PORT: String(serverPort),
    ELECTRON_MODE: "1",
    ELECTRON_RUN_AS_NODE: "1",
    DATA_ROOT: dataRoot,
    HELPER_EXE: helperExe,
    BOT_SERVICE_URL: botConfig.BOT_SERVICE_URL || "",
    BOT_SECRET: botConfig.BOT_SECRET || "",
    TURNSTILE_SECRET: botConfig.TURNSTILE_SECRET || "",
    TURNSTILE_SITE_KEY: botConfig.TURNSTILE_SITE_KEY || "",
    MASTER_ADMIN: botConfig.MASTER_ADMIN || "",
    ADMIN_PASSWORD: botConfig.ADMIN_PASSWORD || "",
    CLIENT_SECRET: botConfig.CLIENT_SECRET || botConfig.BOT_SECRET || "",
  };

  try {
    serverProcess = fork(serverPath, [], {
      env: forkEnv,
      execPath: process.execPath,
      stdio: "pipe",
    });
  } catch (e) {
    dialog.showErrorBox("Erro ao iniciar servidor", e.message);
    app.quit();
    return;
  }

  serverProcess.stdout?.on("data", (d) => { try { process.stdout.write(d); } catch {} });
  serverProcess.stderr?.on("data", (d) => { try { process.stderr.write(d); } catch {} });

  serverProcess.on("error", (err) => {
    if (!serverReady) dialog.showErrorBox("Erro no servidor", err.message);
  });

  serverProcess.on("exit", (code) => {
    if (code !== 0 && code !== null && !serverReady) {
      dialog.showErrorBox("Servidor encerrou", `Código: ${code}`);
    }
  });

  // Servidor avisa a porta via IPC — caminho principal
  serverProcess.on("message", (msg) => {
    if (msg?.type === "port" && msg.port) {
      serverPort = msg.port;
      serverReady = true;
      navigateToApp();
    }
  });

  // Fallback: polling HTTP a cada 400ms, começa imediatamente
  waitForServer(serverPort, 60, (err, port) => {
    if (serverReady) return;
    if (!err) {
      serverReady = true;
      serverPort = port;
      navigateToApp();
    } else {
      dialog.showErrorBox("Servidor não iniciou", "Tente fechar e abrir o app novamente.");
      app.quit();
    }
  });
});

app.on("window-all-closed", () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess) serverProcess.kill();
});

// ─── AUTO UPDATER ────────────────────────────────────────────────────────────
if (autoUpdater) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", async () => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Dark Moon — Atualização pronta",
      message: "Nova versão baixada!",
      detail: "Deseja reiniciar agora para instalar?",
      buttons: ["Reiniciar agora", "Mais tarde"],
      defaultId: 0,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater]", err?.message ?? err);
  });

  app.whenReady().then(() => {
    if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates(), 8000);
  });
}
