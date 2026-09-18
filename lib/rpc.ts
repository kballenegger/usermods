import type { AgentEvent, Mod, PickedElement } from './types';

/** Request/response messages from the side panel to the background worker. */
export type RpcRequest =
  | { type: 'mods.list' }
  | { type: 'mods.save'; mod: Mod }
  | { type: 'mods.delete'; id: string }
  | { type: 'mods.toggle'; id: string; enabled: boolean }
  | { type: 'mods.try'; tabId: number; code: string }
  | { type: 'userScripts.status' }
  | { type: 'page.pick'; tabId: number }
  | { type: 'page.info'; tabId: number }
  | { type: 'chat.reset'; tabId: number }
  | { type: 'chat.hasHistory'; tabId: number };

export type RpcResponse<T extends RpcRequest['type']> = T extends 'mods.list' | 'mods.save' | 'mods.delete' | 'mods.toggle'
  ? Mod[]
  : T extends 'mods.try'
    ? { ok: boolean; result?: string; logs: string[]; error?: string }
    : T extends 'userScripts.status'
      ? { available: boolean; message: string }
      : T extends 'page.info'
        ? { url: string; title: string }
        : T extends 'chat.hasHistory'
          ? boolean
          : { ok: true };

export async function rpc<T extends RpcRequest['type']>(req: Extract<RpcRequest, { type: T }>): Promise<RpcResponse<T>> {
  const res = (await chrome.runtime.sendMessage(req)) as { ok: true; data: RpcResponse<T> } | { ok: false; error: string };
  if (!res) throw new Error('No response from background worker');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/** Messages over the long-lived "agent" port. */
export type AgentPortRequest = { type: 'send'; tabId: number; text: string; picked?: PickedElement } | { type: 'abort' };
export type AgentPortEvent = AgentEvent;
