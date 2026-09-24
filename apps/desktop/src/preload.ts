import { contextBridge, ipcRenderer } from "electron";

export type DesktopBridge = {
  initializeLocalData(input: { confirmed: true; locale: "en" | "ar" }): Promise<{ ready: boolean; error?: string }>;
  completeOwnerSetup(input: { name: string; email: string; password: string; branchName: string; registerName: string; locale: "en" | "ar" }): Promise<void>;
  getRuntimeStatus(): Promise<{ state: "setup_required" | "upgrade_required" | "starting" | "ready" | "failed"; version: string }>;
  upgradeLocalDatabase(confirmed: true): Promise<{ ready: boolean; backup?: string; error?: string }>;
  createBackup(): Promise<{ filename: string; path: string }>;
  restoreBackup(confirmed: true): Promise<{ restored: boolean; recoveryPath?: string }>;
};

if (process.isMainFrame) {
  const bridge: DesktopBridge = {
    initializeLocalData: (input) => ipcRenderer.invoke("desktop:initialize-local-data", input),
    completeOwnerSetup: (input) => ipcRenderer.invoke("desktop:complete-owner-setup", input),
    getRuntimeStatus: () => ipcRenderer.invoke("desktop:runtime-status"),
    upgradeLocalDatabase: (confirmed) => ipcRenderer.invoke("desktop:upgrade-local-database", confirmed),
    createBackup: () => ipcRenderer.invoke("desktop:create-backup"),
    restoreBackup: (confirmed) => ipcRenderer.invoke("desktop:restore-backup", confirmed),
  };
  contextBridge.exposeInMainWorld("fornoDesktop", bridge);
}
