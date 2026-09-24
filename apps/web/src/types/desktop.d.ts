export {};

declare global {
  interface Window {
    fornoDesktop?: {
      initializeLocalData(input: { confirmed: true; locale: "en" | "ar" }): Promise<{ ready: boolean; error?: string }>;
      completeOwnerSetup(input: { name: string; email: string; password: string; branchName: string; registerName: string; locale: "en" | "ar" }): Promise<void>;
      getRuntimeStatus(): Promise<{ state: "setup_required" | "upgrade_required" | "starting" | "ready" | "failed"; version: string }>;
      getDeviceStatus(): Promise<{ deviceId: string; paired: boolean; remoteOrganizationId: string | null }>;
      pairDevice(input: { centralUrl: string; pairingCode: string; deviceName: string }): Promise<{ paired: true; deviceId: string; organizationId: string }>;
      getDeviceStatus(): Promise<{ deviceId: string; paired: boolean; remoteOrganizationId: string | null }>;
      pairDevice(input: { centralUrl: string; pairingCode: string; deviceName: string }): Promise<{ paired: true; deviceId: string; organizationId: string }>;
      upgradeLocalDatabase(confirmed: true): Promise<{ ready: boolean; backup?: string; error?: string }>;
    createBackup(): Promise<{ filename: string; path: string }>;
    restoreBackup(confirmed: true): Promise<{ restored: boolean; recoveryPath?: string }>;
    };
  }
}
