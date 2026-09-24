import { contextBridge, ipcRenderer } from "electron";

export type DesktopBridge = {
  initializeLocalData(input: { confirmed: true; locale: "en" | "ar" }): Promise<{ ready: boolean; error?: string }>;
  completeOwnerSetup(input: { name: string; email: string; password: string; branchName: string; registerName: string; locale: "en" | "ar" }): Promise<void>;
  getRuntimeStatus(): Promise<{ state: "setup_required" | "starting" | "ready" | "failed"; version: string }>;
};

if (process.isMainFrame) {
  const bridge: DesktopBridge = {
    initializeLocalData: (input) => ipcRenderer.invoke("desktop:initialize-local-data", input),
    completeOwnerSetup: (input) => ipcRenderer.invoke("desktop:complete-owner-setup", input),
    getRuntimeStatus: () => ipcRenderer.invoke("desktop:runtime-status"),
  };
  contextBridge.exposeInMainWorld("fornoDesktop", bridge);
}
