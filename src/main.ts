import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, Notification, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import started from 'electron-squirrel-startup';
const Store = require('electron-store').default || require('electron-store');
import chokidar from 'chokidar';
import { config } from 'dotenv';
import { createPDFPipeline, type PDFState } from './pdfPipeline';

config();

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const store = new Store();
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let watcher: chokidar.FSWatcher | null = null;
// Track renamed files to avoid processing them again
const renamedFiles = new Set<string>();

// Pipeline instance - cached and reused
let pdfPipeline: ReturnType<typeof createPDFPipeline> | null = null;
let currentPipelineConfig = { openaiApiKey: '', llmModel: '', useLowercase: true };

// Configuration
let WATCH_FOLDER = (store as any).get('watchFolder', path.join(os.homedir(), 'Documents', 'inbox')) as string;
let OPENAI_API_KEY = process.env.OPENAI_API_KEY || (store as any).get('openaiApiKey', '') as string;
let LLM_MODEL = process.env.LLM_MODEL || (store as any).get('llmModel', 'gpt-4.1-nano') as string;
let USE_LOWERCASE = (store as any).get('useLowercase', true) as boolean;

// Initialize pipeline with current config
function initializePipeline() {
  if (!pdfPipeline || 
      currentPipelineConfig.openaiApiKey !== OPENAI_API_KEY || 
      currentPipelineConfig.llmModel !== LLM_MODEL ||
      currentPipelineConfig.useLowercase !== USE_LOWERCASE) {
    console.log('Creating new PDF pipeline with updated configuration');
    pdfPipeline = createPDFPipeline(OPENAI_API_KEY, LLM_MODEL, USE_LOWERCASE);
    currentPipelineConfig = { openaiApiKey: OPENAI_API_KEY, llmModel: LLM_MODEL, useLowercase: USE_LOWERCASE };
  }
  return pdfPipeline;
}

// Configuration will be used when processing PDFs

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
  
  tray.setToolTip('File Wrangler');
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
    
    // Skip if this is a file we renamed (avoid reprocessing our output)
    if (renamedFiles.has(filePath)) {
      console.log('Skipping renamed file:', filePath);
      renamedFiles.delete(filePath); // Clean up after detection
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
  
  watcher.on('error', (error: Error) => {
    console.error('Watcher error:', error);
  });
  
  watcher.on('ready', () => {
    console.log('Watcher is ready and monitoring for PDF files');
  });
  
  // Also watch for all events to debug
  watcher.on('all', (event: string, path: string) => {
    console.log('Watcher event:', event, path);
  });
  
  console.log('Watching folder:', WATCH_FOLDER);
};

// IPC handlers
ipcMain.handle('get-config', () => ({
  watchFolder: WATCH_FOLDER,
  openaiApiKey: OPENAI_API_KEY,
  llmModel: LLM_MODEL,
  useLowercase: USE_LOWERCASE,
}));

ipcMain.handle('update-config', (_event, config) => {
  const oldWatchFolder = WATCH_FOLDER;
  
  if (config.watchFolder) {
    (store as any).set('watchFolder', config.watchFolder);
    WATCH_FOLDER = config.watchFolder;
  }
  if (config.openaiApiKey) {
    (store as any).set('openaiApiKey', config.openaiApiKey);
    OPENAI_API_KEY = config.openaiApiKey;
  }
  if (config.llmModel) {
    (store as any).set('llmModel', config.llmModel);
    LLM_MODEL = config.llmModel;
  }
  if (config.useLowercase !== undefined) {
    (store as any).set('useLowercase', config.useLowercase);
    USE_LOWERCASE = config.useLowercase;
  }
  
  // Restart watcher if folder changed
  if (config.watchFolder && config.watchFolder !== oldWatchFolder) {
    console.log('Watch folder changed from', oldWatchFolder, 'to', config.watchFolder);
    
    // Ensure new watch folder exists
    if (!fs.existsSync(WATCH_FOLDER)) {
      console.log('Creating new watch folder:', WATCH_FOLDER);
      fs.mkdirSync(WATCH_FOLDER, { recursive: true });
    }
    
    setupWatcher();
  }
  
  // Reinitialize pipeline if API key, model, or lowercase setting changed
  if ((config.openaiApiKey && config.openaiApiKey !== currentPipelineConfig.openaiApiKey) ||
      (config.llmModel && config.llmModel !== currentPipelineConfig.llmModel) ||
      (config.useLowercase !== undefined && config.useLowercase !== currentPipelineConfig.useLowercase)) {
    pdfPipeline = null; // Force recreation on next use
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
  const pipeline = initializePipeline();
  
  const initialState: PDFState = {
    path: filePath
  };
  
  let currentState: PDFState = initialState;
  
  // Send initial state
  mainWindow?.webContents.send('processing-update', { ...currentState });
  
  // Run the pipeline
  const stream = await pipeline.stream(initialState);
  
  for await (const chunk of stream) {
    // Update state with each step's output
    const [nodeName, nodeOutput] = Object.entries(chunk)[0];
    currentState = { ...currentState, ...nodeOutput } as PDFState;
    
    // Map node names to status
    let status: string;
    switch (nodeName) {
      case 'parse':
        status = 'parsing';
        break;
      case 'llm':
        status = 'extracting';
        break;
      case 'rename':
        status = currentState.error ? 'error' : 'completed';
        break;
      default:
        status = 'processing';
    }
    
    mainWindow?.webContents.send('processing-update', {
      ...currentState,
      status,
      originalPath: filePath,
    });
  }
  
  if (currentState.newPath) {
    // Add the new path to renamed files to avoid reprocessing
    renamedFiles.add(currentState.newPath);
    
    // Log the rename for debugging
    console.log(`PDF renamed: ${path.basename(filePath)} → ${path.basename(currentState.newPath)}`);
    
    new Notification({
      title: 'PDF Renamed',
      body: `${path.basename(filePath)} → ${path.basename(currentState.newPath)}`
    }).show();
  }
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

// Cleanup function
function cleanup() {
  console.log('Cleaning up before exit...');
  
  // Close file watcher
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  
  // Destroy tray
  if (tray) {
    tray.destroy();
    tray = null;
  }
  
  // Close all windows
  BrowserWindow.getAllWindows().forEach(window => {
    window.destroy();
  });
}

// Handle process termination signals
process.on('SIGINT', () => {
  console.log('Received SIGINT, cleaning up...');
  cleanup();
  app.quit();
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, cleaning up...');
  cleanup();
  app.quit();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  cleanup();
  app.quit();
});

// Handle app quit
app.on('before-quit', () => {
  console.log('App is quitting...');
  cleanup();
});