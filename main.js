const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Mia App Desktop",
    icon: path.join(__dirname, 'icona.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Sostituisci questo URL con il sito su cui lavora lo script
  win.loadURL('https://www.google.com');

  // Quando la pagina ha finito di caricarsi, inietta lo userscript
  win.webContents.on('did-finish-load', () => {
    const scriptPath = path.join(__dirname, 'script.js');
    if (fs.existsSync(scriptPath)) {
      const userScript = fs.readFileSync(scriptPath, 'utf8');
      win.webContents.executeJavaScript(userScript)
        .then(() => console.log('Userscript iniettato con successo!'))
        .catch(err => console.error('Errore nell\'iniezione dello script:', err));
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});