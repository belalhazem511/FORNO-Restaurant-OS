export {};

declare global {
  interface Window {
    fornoDesktop?: {
      initializeLocalData(input: { confirmed: true; locale: "en" | "ar" }): Promise<{ ready: boolean; error?: string }>;
      completeOwnerSetup(input: { name: string; email: string; password: string; branchName: string; registerName: string; locale: "en" | "ar" }): Promise<void>;
      getRuntimeStatus(): Promise<{ state: "setup_required" | "starting" | "ready" | "failed"; version: string }>;
    };
  }
}
