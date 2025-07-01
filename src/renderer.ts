import './index.css';

// Declare the electron API interface
declare global {
  interface Window {
    electronAPI: {
      getConfig: () => Promise<any>;
      updateConfig: (config: any) => Promise<boolean>;
      selectFolder: () => Promise<string | null>;
      showNotification: (title: string, body: string) => Promise<void>;
      openFolder: () => Promise<void>;
      processPDF: (filePath: string) => Promise<void>;
      onPDFAdded: (callback: (filePath: string) => void) => void;
      onProcessingUpdate: (callback: (data: any) => void) => void;
    };
  }
}

interface ActivityItem {
  id: string;
  filename: string;
  status: 'parsing' | 'extracting' | 'renaming' | 'completed' | 'error';
  message: string;
  timestamp: Date;
}

class PDFRenamerApp {
  private activities: ActivityItem[] = [];
  private config: any = {};
  
  constructor() {
    this.initializeApp();
    this.setupEventListeners();
    this.setupIPCListeners();
  }
  
  private async initializeApp() {
    try {
      // Load configuration
      this.config = await window.electronAPI.getConfig();
      this.updateUI();
    } catch (error) {
      console.error('Failed to initialize app:', error);
    }
  }
  
  private updateUI() {
    // Update folder path display
    const folderPathEl = document.getElementById('folder-path');
    if (folderPathEl) {
      folderPathEl.textContent = this.config.watchFolder || 'Not configured';
    }
    
    // Update settings modal
    const watchFolderInput = document.getElementById('watch-folder-input') as HTMLInputElement;
    const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement;
    const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
    
    if (watchFolderInput) watchFolderInput.value = this.config.watchFolder || '';
    if (apiKeyInput) apiKeyInput.value = this.config.openaiApiKey || '';
    if (modelSelect) modelSelect.value = this.config.llmModel || 'gpt-3.5-turbo';
  }
  
  private setupEventListeners() {
    // Settings button
    document.getElementById('settings-btn')?.addEventListener('click', () => {
      document.getElementById('settings-modal')?.classList.remove('hidden');
    });
    
    // Close settings
    document.getElementById('close-settings')?.addEventListener('click', () => {
      document.getElementById('settings-modal')?.classList.add('hidden');
    });
    
    // Select folder
    document.getElementById('select-folder')?.addEventListener('click', async () => {
      const folder = await window.electronAPI.selectFolder();
      if (folder) {
        const input = document.getElementById('watch-folder-input') as HTMLInputElement;
        input.value = folder;
      }
    });
    
    // Save settings
    document.getElementById('save-settings')?.addEventListener('click', async () => {
      const watchFolder = (document.getElementById('watch-folder-input') as HTMLInputElement).value;
      const openaiApiKey = (document.getElementById('api-key-input') as HTMLInputElement).value;
      const llmModel = (document.getElementById('model-select') as HTMLSelectElement).value;
      
      try {
        await window.electronAPI.updateConfig({
          watchFolder,
          openaiApiKey,
          llmModel
        });
        
        this.config = { watchFolder, openaiApiKey, llmModel };
        this.updateUI();
        document.getElementById('settings-modal')?.classList.add('hidden');
        
        await window.electronAPI.showNotification('Settings Saved', 'Configuration updated successfully');
      } catch (error) {
        console.error('Failed to save settings:', error);
        await window.electronAPI.showNotification('Error', 'Failed to save settings');
      }
    });
    
    // Open folder button
    document.getElementById('open-folder')?.addEventListener('click', () => {
      window.electronAPI.openFolder();
    });
    
    // Close modal on background click
    document.getElementById('settings-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        document.getElementById('settings-modal')?.classList.add('hidden');
      }
    });
  }
  
  private setupIPCListeners() {
    // Listen for new PDFs
    window.electronAPI.onPDFAdded((filePath) => {
      const filename = filePath.split('/').pop() || filePath;
      this.addActivity({
        id: Date.now().toString(),
        filename,
        status: 'parsing',
        message: 'Processing PDF...',
        timestamp: new Date()
      });
    });
    
    // Listen for processing updates
    window.electronAPI.onProcessingUpdate((data) => {
      const filename = data.path.split('/').pop() || data.path;
      const activity = this.activities.find(a => a.filename === filename);
      
      if (activity) {
        activity.status = data.status;
        
        switch (data.status) {
          case 'parsing':
            activity.message = 'Parsing PDF content...';
            break;
          case 'extracting':
            activity.message = 'Extracting metadata with AI...';
            break;
          case 'renaming':
            activity.message = 'Renaming file...';
            break;
          case 'completed':
            activity.message = `Renamed successfully`;
            break;
          case 'error':
            activity.message = `Error: ${data.error || 'Unknown error'}`;
            break;
        }
        
        this.updateActivityList();
      }
    });
  }
  
  private addActivity(activity: ActivityItem) {
    this.activities.unshift(activity);
    if (this.activities.length > 50) {
      this.activities = this.activities.slice(0, 50);
    }
    this.updateActivityList();
  }
  
  private updateActivityList() {
    const listEl = document.getElementById('activity-list');
    if (!listEl) return;
    
    if (this.activities.length === 0) {
      listEl.innerHTML = '<p class="empty-state">Waiting for PDF files...</p>';
      return;
    }
    
    listEl.innerHTML = this.activities
      .map(activity => `
        <div class="activity-item">
          <div class="activity-status ${activity.status}"></div>
          <div class="activity-content">
            <div class="activity-filename">${activity.filename}</div>
            <div class="activity-message">${activity.message}</div>
          </div>
        </div>
      `)
      .join('');
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new PDFRenamerApp();
});