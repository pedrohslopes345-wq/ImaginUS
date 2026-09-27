const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage } = require("electron");
const { autoUpdater } = require("electron-updater");

const DEFAULT_SETTINGS = { hotkey: "Control+Alt+Space" };
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const startHidden = process.argv.includes("--hidden");

// "--perfil=nome" abre uma cópia separada do app (outro login, outros ajustes).
// Serve para testar sozinho, fazendo o papel das duas pessoas no mesmo PC.
const profileArg = process.argv.find((arg) => arg.startsWith("--perfil="));
const profile = profileArg ? profileArg.slice("--perfil=".length).replace(/[^\w-]/g, "") : "";
if (profile) {
  app.setPath("userData", path.join(app.getPath("appData"), `ImaginUS-${profile}`));
}
const appTitle = profile ? `ImaginUS (${profile})` : "ImaginUS";

let win = null;
let tray = null;
let quitting = false;
let settings = { ...DEFAULT_SETTINGS };
let pendingUpdateVersion = null;

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const asset = (name) => path.join(__dirname, "..", "assets", name);

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function registerHotkey(accelerator) {
  globalShortcut.unregisterAll();
  if (!accelerator) return true;
  try {
    return globalShortcut.register(accelerator, () => send("hotkey"));
  } catch {
    return false;
  }
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 440,
    height: 660,
    minWidth: 360,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: appTitle,
    icon: asset("icon.png"),
    backgroundColor: "#faf7f5",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // O app passa quase todo o tempo escondido e precisa continuar ouvindo e tocando.
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  // Mantém o nome do perfil no título (o <title> do HTML sobrescreveria).
  win.on("page-title-updated", (e) => e.preventDefault());
  win.once("ready-to-show", () => {
    if (!startHidden) win.show();
  });
  // Fechar a janela só esconde; para sair de verdade use o menu da bandeja.
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function buildTrayMenu() {
  const items = [
    { label: "Abrir", click: showWindow },
    { label: "Enviar mensagem do atalho", click: () => send("hotkey") },
  ];
  if (pendingUpdateVersion) {
    items.push({ label: `Instalar versão ${pendingUpdateVersion} e reiniciar`, click: installUpdate });
  }
  items.push(
    { type: "separator" },
    {
      label: "Sair",
      click: () => {
        quitting = true;
        app.quit();
      },
    }
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(asset("tray.png")));
  tray.setToolTip(appTitle);
  tray.on("click", showWindow);
  buildTrayMenu();
}

// Atualização automática: procura versões novas no GitHub Releases, baixa em segundo plano
// e instala quando o app fecha (ex.: ao desligar o PC) ou quando a pessoa clica em "reiniciar".
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => {
    pendingUpdateVersion = info.version;
    buildTrayMenu();
    send("update:ready", info.version);
  });
  autoUpdater.on("error", (err) => console.error("Falha ao atualizar:", err && err.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

function installUpdate() {
  quitting = true;
  autoUpdater.quitAndInstall(true, true);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId("com.imaginus.app");
    loadSettings();
    createWindow();
    createTray();
    registerHotkey(settings.hotkey);
    setupAutoUpdate();

    ipcMain.handle("settings:get", () => ({
      ...settings,
      autostart: app.getLoginItemSettings().openAtLogin,
      version: app.getVersion(),
      pendingUpdateVersion,
    }));

    ipcMain.handle("settings:setHotkey", (_e, accelerator) => {
      if (!registerHotkey(accelerator)) {
        registerHotkey(settings.hotkey);
        return { ok: false };
      }
      settings.hotkey = accelerator;
      saveSettings();
      return { ok: true };
    });

    ipcMain.handle("settings:setAutostart", (_e, enabled) => {
      app.setLoginItemSettings({ openAtLogin: !!enabled, args: ["--hidden"] });
      return app.getLoginItemSettings().openAtLogin;
    });

    ipcMain.handle("update:check", async () => {
      if (!app.isPackaged) return { status: "dev" };
      try {
        const result = await autoUpdater.checkForUpdates();
        const latest = result && result.updateInfo && result.updateInfo.version;
        return { status: latest && latest !== app.getVersion() ? "downloading" : "latest", latest };
      } catch (err) {
        return { status: "error", message: err && err.message };
      }
    });

    ipcMain.on("update:install", installUpdate);
    ipcMain.on("tray:status", (_e, text) => tray && tray.setToolTip(`${appTitle} — ${text}`));
    ipcMain.on("window:show", showWindow);
  });

  app.on("before-quit", () => {
    quitting = true;
  });

  app.on("will-quit", () => globalShortcut.unregisterAll());
}
