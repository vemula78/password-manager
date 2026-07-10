// Thin RPC wrapper: the popup never touches @pw/core or the vault directly — every action
// goes through the background worker, which is the only place the unlocked store lives.
import type { Req, Res } from "../lib/messages";

export async function call<T extends Res>(req: Req): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as Res;
  return res as T;
}

export async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}
