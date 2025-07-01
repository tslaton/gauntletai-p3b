import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, Notification, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import started from 'electron-squirrel-startup';
const Store = require('electron-store').default || require('electron-store');
import chokidar from 'chokidar';
import { config } from 'dotenv';
import { PDFProcessor } from './pdfProcessor';

config();

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const store = new Store();
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let watcher: chokidar.FSWatcher | null = null;
let pdfProcessor: PDFProcessor;

// Configuration
let WATCH_FOLDER = (store as any).get('watchFolder', path.join(os.homedir(), 'Desktop', 'pdfs')) as string;
let OPENAI_API_KEY = process.env.OPENAI_API_KEY || (store as any).get('openaiApiKey', '') as string;
let LLM_MODEL = process.env.LLM_MODEL || (store as any).get('llmModel', 'gpt-3.5-turbo') as string;

// Initialize PDF processor
pdfProcessor = new PDFProcessor(OPENAI_API_KEY, LLM_MODEL);

// Ensure watch folder exists
if (!fs.existsSync(WATCH_FOLDER)) {
  console.log('Creating watch folder:', WATCH_FOLDER);
  fs.mkdirSync(WATCH_FOLDER, { recursive: true });
} else {
  console.log('Watch folder exists:', WATCH_FOLDER);
}

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' || !app.isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
};

const createTray = () => {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    { 
      label: 'Show App', 
      click: () => {
        mainWindow?.show();
      } 
    },
    { 
      label: 'Open PDF Folder', 
      click: () => {
        shell.openPath(WATCH_FOLDER);
      } 
    },
    { type: 'separator' },
    { 
      label: 'Quit', 
      click: () => {
        app.isQuitting = true;
        app.quit();
      } 
    }
  ]);
  
  tray.setToolTip('PDF AI Renamer');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    mainWindow?.show();
  });
};

// Setup file watcher
const setupWatcher = () => {
  if (watcher) {
    watcher.close();
  }
  
  console.log('Setting up watcher for folder:', WATCH_FOLDER);
  
  // Watch the folder itself, not a glob pattern
  watcher = chokidar.watch(WATCH_FOLDER, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100
    },
    // Add these options to help with detection
    usePolling: true,
    interval: 1000,
    depth: 0
  });
  
  watcher.on('add', async (filePath: string) => {
    // Only process PDF files
    if (path.extname(filePath).toLowerCase() !== '.pdf') {
      return;
    }
    
    console.log('PDF detected:', filePath);
    mainWindow?.webContents.send('pdf-added', filePath);
    
    // Automatically process the PDF
    try {
      await processPDFFile(filePath);
    } catch (error) {
      console.error('Error processing PDF:', error);
      mainWindow?.webContents.send('processing-update', {
        path: filePath,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  watcher.on('error', (error) => {
    console.error('Watcher error:', error);
  });
  
  watcher.on('ready', () => {
    console.log('Watcher is ready and monitoring for PDF files');
  });
  
  // Also watch for all events to debug
  watcher.on('all', (event, path) => {
    console.log('Watcher event:', event, path);
  });
  
  console.log('Watching folder:', WATCH_FOLDER);
};

// IPC handlers
ipcMain.handle('get-config', () => ({
  watchFolder: WATCH_FOLDER,
  openaiApiKey: OPENAI_API_KEY,
  llmModel: LLM_MODEL,
}));

ipcMain.handle('update-config', (_event, config) => {
  if (config.watchFolder) {
    (store as any).set('watchFolder', config.watchFolder);
    WATCH_FOLDER = config.watchFolder;
  }
  if (config.openaiApiKey) {
    (store as any).set('openaiApiKey', config.openaiApiKey);
    OPENAI_API_KEY = config.openaiApiKey;
    pdfProcessor.updateConfig(config.openaiApiKey, LLM_MODEL);
  }
  if (config.llmModel) {
    (store as any).set('llmModel', config.llmModel);
    LLM_MODEL = config.llmModel;
    pdfProcessor.updateConfig(OPENAI_API_KEY, config.llmModel);
  }
  
  // Restart watcher if folder changed
  if (config.watchFolder && config.watchFolder !== WATCH_FOLDER) {
    setupWatcher();
  }
  
  return true;
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory']
  });
  
  if (!result.canceled) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('show-notification', (_event, title: string, body: string) => {
  new Notification({ title, body }).show();
});

ipcMain.handle('open-folder', () => {
  shell.openPath(WATCH_FOLDER);
});

ipcMain.handle('process-pdf', async (_event, filePath: string) => {
  return processPDFFile(filePath);
});

// Helper function to process PDF
async function processPDFFile(filePath: string) {
  await pdfProcessor.processPDF(filePath, (state) => {
    mainWindow?.webContents.send('processing-update', state);
  });
  
  new Notification({
    title: 'PDF Renamed',
    body: `Successfully processed: ${path.basename(filePath)}`
  }).show();
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.on('ready', () => {
  console.log('App ready, initializing...');
  createWindow();
  createTray();
  setupWatcher();
  console.log('App initialization complete');
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow?.show();
  }
});

// Extend the app object for the close event
declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean;
    }
  }
}