import type { Artifact } from './artifact';
import type { Chat } from './chats';
import type { ResumableRun } from './runstate';
import type { AgentEvent, ChatItem, Mod, ScriptPreview, UserTurn } from './types';

export type OAuthKind = 'chatgpt' | 'xai';
export type OAuthLoginState =
  | { status: 'idle' }
  | { status: 'pending'; userCode: string; verificationUri: string; expiresAt: number }
  | { status: 'done' }
  | { status: 'error'; message: string };

/** Request/response messages from the side panel to the background worker. */
export type RpcRequest =
  | { type: 'mods.list' }
  | { type: 'mods.save'; mod: Mod }
  | { type: 'mods.delete'; id: string }
  | { type: 'mods.toggle'; id: string; enabled: boolean }
  /** Run a draft once. With `modId`, runs that saved mod through the GM wrapper in its own world. */
  | { type: 'mods.try'; tabId: number; code: string }
  | { type: 'mods.try'; tabId: number; modId: string }
  /** Describe a script before installing it, from a URL or from text the user picked. */
  | { type: 'mods.preview'; url: string }
  | { type: 'mods.preview'; source: string }
  /** Install an outside userscript: parse, fetch @require/@resource, save, register. */
  | { type: 'mods.install'; source: string; downloadUrl?: string; enabled?: boolean; values?: Record<string, unknown> }
  /**
   * Save an edited source over an existing mod: re-parse the header, refetch @require/@resource if
   * and only if the header's dependency lines changed, keep the mod's id, enabled flag, GM values
   * and provenance, and re-register. This is what a source editor saves through — mods.save takes a
   * caller-built Mod and does no dependency resolution at all.
   */
  | { type: 'mods.saveSource'; id: string; source: string }
  /** Refetch from downloadUrl and replace the source if @version moved. */
  | { type: 'mods.update'; id: string }
  /** Import a Tampermonkey backup (JSON text, or a base64 ZIP). */
  | { type: 'mods.importBackup'; json: string }
  | { type: 'mods.importBackup'; zipBase64: string }
  | { type: 'userScripts.status' }
  | { type: 'page.pick'; tabId: number }
  | { type: 'page.info'; tabId: number }
  | { type: 'chats.list'; host: string }
  /** Every chat on every host, for the dashboard. */
  | { type: 'chats.listAll' }
  /** One chat's stored panel transcript, read-only — the dashboard's preview pane. */
  | { type: 'chats.transcript'; id: string }
  | { type: 'chats.create'; host: string }
  | { type: 'chats.delete'; id: string }
  /** Archive (or unarchive) a chat: it leaves the main switcher list but stays readable. */
  | { type: 'chats.archive'; id: string; archived: boolean }
  | { type: 'chats.rename'; id: string; title: string }
  /** The dashboard's bulk archive / unarchive / delete, applied in a single index write. */
  | { type: 'chats.bulk'; ids: string[]; action: 'archive' | 'unarchive' | 'delete' }
  /** The dashboard's bulk enable / disable / delete for mods, in a single mods write. */
  | { type: 'mods.bulk'; ids: string[]; action: 'enable' | 'disable' | 'delete' }
  /** One chat's draft mod, or null when it has none yet. */
  | { type: 'artifact.get'; chatId: string }
  /** Roll the draft back to a version, which APPENDS that version's code as the newest one. */
  | { type: 'artifact.rollback'; chatId: string; version: number }
  /** The user renaming the draft in the panel: a 'user-edit' version carrying the new name. */
  | { type: 'artifact.rename'; chatId: string; name: string }
  /**
   * Save the draft's current version as a mod. The first save creates one and records its id on the
   * artifact; every later save rewrites THAT mod in place through the same path the source editor
   * uses (header re-parsed, dependencies resolved), so a chat never accumulates copies of its own
   * mod. A linked mod that has since been deleted falls back to creating a new one, and says so.
   */
  | { type: 'artifact.save'; chatId: string }
  | { type: 'oauth.status'; kind: OAuthKind }
  | { type: 'oauth.start'; kind: OAuthKind }
  | { type: 'oauth.poll'; kind: OAuthKind }
  | { type: 'oauth.cancel'; kind: OAuthKind }
  | { type: 'oauth.signout'; kind: OAuthKind }
  | { type: 'models.list' }
  /**
   * What the panel asks the moment it has opened its port: which chats are running right now (and
   * what each is doing), and which have a run that stopped short and can be resumed. Answered only
   * after the background has written out any transcript it was keeping while no panel was open, so
   * the panel can read storage afterwards and trust it.
   */
  | { type: 'agent.attach' };

/** Response shape per request type. Anything not listed here answers { ok: true }. */
interface RpcResults {
  'mods.list': Mod[];
  'mods.save': Mod[];
  'mods.delete': Mod[];
  'mods.toggle': Mod[];
  'mods.install': Mod[];
  'mods.saveSource': Mod[];
  'mods.preview': ScriptPreview;
  'mods.update': { updated: boolean; version: string };
  'mods.importBackup': { imported: number; skipped: string[]; mods: Mod[] };
  'mods.try': { ok: boolean; result?: string; logs: string[]; error?: string };
  'userScripts.status': { available: boolean; message: string };
  'page.info': { url: string; title: string };
  'oauth.status': { signedIn: boolean; label?: string };
  'oauth.start': OAuthLoginState;
  'oauth.poll': OAuthLoginState;
  'models.list': string[];
  'chats.list': Chat[];
  'chats.listAll': Chat[];
  'chats.transcript': ChatItem[];
  'chats.create': Chat;
  'mods.bulk': Mod[];
  'artifact.get': Artifact | null;
  'artifact.rollback': Artifact;
  'artifact.rename': Artifact;
  'artifact.save': { artifact: Artifact; mod: Mod; created: boolean; relinked: boolean };
  'agent.attach': AgentAttachState;
}

/** See 'agent.attach'. `status` is the last status event the run posted, if it has posted one. */
export interface AgentAttachState {
  running: Record<string, { startedAt: number; status?: Extract<AgentEvent, { type: 'status' }> }>;
  resumable: Record<string, ResumableRun>;
}

export type RpcResponse<T extends RpcRequest['type']> = T extends keyof RpcResults ? RpcResults[T] : { ok: true };

export async function rpc<T extends RpcRequest['type']>(req: Extract<RpcRequest, { type: T }>): Promise<RpcResponse<T>> {
  const res = (await chrome.runtime.sendMessage(req)) as { ok: true; data: RpcResponse<T> } | { ok: false; error: string };
  if (!res) throw new Error('No response from background worker');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/**
 * Messages over the long-lived "agent" port. Both carry the chat they are about: one port serves
 * the whole panel, and the panel may be looking at a different chat than the one that is running,
 * so nothing may be inferred from "the port's current chat".
 */
export type AgentPortRequest =
  | ({ type: 'send'; tabId: number; chatId: string } & UserTurn)
  | { type: 'abort'; chatId: string }
  /**
   * Carry on a run that failed or was interrupted, from the conversation as it was saved. No text
   * travels with this, deliberately: nothing is added to the conversation, so the prompt cannot be
   * sent twice.
   */
  | { type: 'resume'; tabId: number; chatId: string };
export type AgentPortEvent = AgentEvent;
