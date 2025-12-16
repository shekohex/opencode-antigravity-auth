import open from "open";

export async function openBrowser(url: string): Promise<void> {
  await open(url);
}
