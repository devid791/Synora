const { app, BrowserWindow } = require("electron");
app.setName("Harbour QA Desk");
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 900,
    height: 600,
    x: 20,
    y: 20,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  await window.loadURL(process.env.SYNORA_QA_PAGE);
});
app.on("window-all-closed", () => app.quit());
