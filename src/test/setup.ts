import "@testing-library/jest-dom/vitest";

// jsdom's Blob predates Blob.arrayBuffer(), which every browser (and Tauri's
// webview) has had for years and which the XLSX exports use to get their bytes.
// Fill it in from FileReader so those code paths run under test unchanged.
if (typeof Blob !== "undefined" && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}
