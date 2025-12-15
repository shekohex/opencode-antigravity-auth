import { execFile } from "node:child_process";

export function openBrowser(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (process.platform === "darwin") {
      execFile("open", [url], (error) => (error ? reject(error) : resolve()));
      return;
    }

    if (process.platform === "win32") {
      execFile("cmd", ["/c", "start", "", url], (error) => (error ? reject(error) : resolve()));
      return;
    }

    execFile("xdg-open", [url], (error) => (error ? reject(error) : resolve()));
  });
}
