// Isolated Electron host for the real renderer/controlled API fixture only.
const { app, BrowserWindow, nativeTheme } = require("electron");
app.setPath("userData", process.env.SYNORA_SETTINGS_USER_DATA);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  nativeTheme.themeSource = "dark";
  const win = new BrowserWindow({
    width: 1280,
    height: 960,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
