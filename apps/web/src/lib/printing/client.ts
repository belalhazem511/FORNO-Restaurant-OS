export type PrintPreviewOptions = {
  jobId: number;
  copyIndex?: number;
};

export interface PrintPreviewAdapter {
  readonly kind: "browser" | "local-bridge";
  reservePreview(): Window;
  showPreview(target: Window, options: PrintPreviewOptions): void;
}

export class PopupBlockedError extends Error {
  constructor() {
    super("PRINT_PREVIEW_POPUP_BLOCKED");
  }
}

export const browserPrintPreviewAdapter: PrintPreviewAdapter = {
  kind: "browser",
  reservePreview() {
    const popup = window.open("about:blank", "_blank");
    if (!popup) throw new PopupBlockedError();
    return popup;
  },
  showPreview(target, { jobId, copyIndex }) {
    target.opener = null;
    target.location.replace(`/print/${jobId}${copyIndex ? `?copy=${copyIndex}` : ""}`);
  },
};

// A trusted local bridge can implement PrintPreviewAdapter later. Order and financial
// data stay behind the authenticated print API instead of being sent by POS code.
