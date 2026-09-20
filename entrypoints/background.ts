import { runAgent, type AgentEnv } from '@/lib/agent/loop';
import { RETRY_POLICY_KEY, resolvePolicy } from '@/lib/agent/retry';
import { isDomCondition, urlMatches, type WaitOutcome, type WaitSpec } from '@/lib/agent/wait';
import { gmValuesKey, loadGmValues, type GmMessage } from '@/lib/gm';
import { createExecAdapter } from '@/lib/exec/adapter';
import { wrapForExecution } from '@/lib/exec/wrap';
import { checkConnect, connectOf } from '@/lib/connect';
import { dependenciesChanged, fetchText, previewFromUrl, reparseEditedSource, resolveDependencies, toBase64 } from '@/lib/install';
import { UPDATED_MARK } from '@/lib/importreport';
import { scriptIdentity } from '@/lib/installurl';
import { resyncPlan } from '@/lib/resync';
import { mapStack, prepareRunScript, renderRunResult, type RunResult } from '@/lib/runscript';
import { shouldUpdate } from '@/lib/version';
import { loadMods, modFromProposal, modFromSource, parseHeader, previewFromSource, upsertMod, deleteMod, saveMods } from '@/lib/mods';
import { appendTurn, archiveChat, bulkChats, countTurns, createChat, deleteChat, getChat, hostFromUrl, isArchived, listChats, loadItems, loadMessages, markTitleRefreshed, renameChat, saveItems, saveMessages, setChatArtifact, setChatModel, setModelTitle, touchChat } from '@/lib/chats';
import { loadRuns, markInterrupted, pruneRuns, resumableRuns, saveRuns, type RunMap, type RunRecord } from '@/lib/runstate';
import { reduceItems } from '@/lib/transcript';
import { addVersion, adoptMod, currentVersion, detachFromMod, draftBlock, fromMod, loadArtifact, recordProposal, rollbackTo, saveArtifact, toProposal, toSource, type Artifact } from '@/lib/artifact';
import { draftStanding, duplicateOf, editModPlan, likelyUrlFor, modsBlock, modsForUrl, openModDecision, runsOnPage } from '@/lib/modmatch';
import { buildTitleInput, completedTurns, sanitizeTitle, titleDecision, TITLE_SYSTEM_PROMPT } from '@/lib/title';
import { createProvider } from '@/lib/providers';
import { VISION_FALLBACK_PANEL_NOTE, createVisionMemory, resolveImagesSetting, visionKeyFor } from '@/lib/providers/vision';
import { MAX_EDGE, SCREENSHOT_CAPTURE_FORMAT, SCREENSHOT_QUALITY, fitWithin, parseDataUrl } from '@/lib/images';
import { SUBSCRIPTIONS_OFF, isSubscriptionProvider, unavailableProviderMessage } from '@/lib/buildflags';
import { listFailureMessage, listWithFallback, modelsRequest, parseModelIds, type ModelListResult, type ModelListTarget } from '@/lib/modellist';
import type { OAuthKind } from '@/lib/oauth';
import type { AgentAttachState, AgentPortRequest, OAuthLoginState, RpcRequest } from '@/lib/rpc';
import { SessionMap } from '@/lib/sessions';
import { loadSettings } from '@/lib/settings';
import {
  effectiveSettings,
  loadConnections,
  loadModelChoice,
  loadSignedIn,
  mutateConnections,
  resolveSelection,
  sameSelection,
  selectionForChat,
  updateConnection,
  type ModelCache,
  type ModelSelection,
} from '@/lib/connections';
import { actionClickPlan, resolveScope, sidePanelAvailable, windowPanelPlan } from '@/lib/sidepanel';
import type { SidePanelScope } from '@/lib/types';
import { looksLikeZip, parseTampermonkeyJson, parseTampermonkeyZipEntries, type TmScript } from '@/lib/tampermonkey';
import type { AgentEvent, AgentEventBody, ChatItem, ContentRequest, Mod, ModProposal, Msg, Part, Settings, UserTurn } from '@/lib/types';

/**
 * The execution engine for this browser, picked once.
 *
 * Chrome and Firefox get `chrome.userScripts`; Safari gets the content-script runner. Everything
 * below talks to the adapter rather than to either API directly, so the difference lives in one
 * file (lib/exec/adapter.ts) instead of being spread through every call site.
 */
const exec = createExecAdapter({
  handleGm,
  loadMods,
  loadGmValues,
  onBlocked: (report) => {
    // A mod that a page refused to run is a failure the user can act on (switch the mod out of the
    // page world), so it is named in the log rather than dropped.
    console.warn(`[usermods] ${report.modId} was blocked on ${report.url}: ${report.reason}`);
  },
});

export default defineBackground(() => {
  // Before anything can await: MV3 only wakes a sleeping worker for listeners registered here.
  exec.install();

  // The window-level panel is configured from the stored scope, not unconditionally opened on every
  // tab: see applyPanelScope below and lib/sidepanel.ts for the two layers Chrome gives us.
  void applyPanelScope();
  // Any run the previous worker was in the middle of died with it. Say so in storage now, so the
  // panel can offer Resume the moment it asks (see recoverRuns and lib/runstate.ts).
  void recoverRuns();

  /**
   * Open the panel on the clicked tab alone.
   *
   * This listener only ever fires under 'tab' scope: under 'window', openPanelOnActionClick is on
   * and Chrome opens the window panel itself without firing onClicked.
   *
   * Everything here runs inside the click's gesture. The scope is read from an in-worker cache
   * rather than awaited from storage, because `open()` "may only be called in response to a user
   * action" and an await on chrome.storage is exactly the kind of hop that can cost the gesture.
   * The cache is filled at startup and kept current by the storage listener below. A click that
   * beats the first storage read reads the default, 'tab' — and that is safe rather than lucky:
   * under 'window' scope Chrome would not have fired onClicked at all, because openPanelOnActionClick
   * is part of Chrome's own persisted state for the extension and survives the worker sleeping. So
   * a click reaching this listener is already evidence the scope is 'tab'.
   */
  chrome.action.onClicked.addListener((tab) => {
    // With a popup in the manifest (Safari) the click opens the popup and this never fires; the
    // guard is for the case where a build has neither.
    if (!sidePanelAvailable()) return;
    const plan = actionClickPlan(panelScope, tab.id);
    if (!plan.setOptions || !plan.open) return;
    // No await between these two: setOptions is fire-and-forget so open() stays in the gesture.
    // Chrome queues extension API calls from one context in order, so the options are in place by
    // the time open() is serviced.
    chrome.sidePanel.setOptions(plan.setOptions).catch(() => {});
    chrome.sidePanel.open(plan.open).catch((e: unknown) => {
      console.warn('[usermods] sidePanel.open', e);
    });
  });

  // A scope change takes effect immediately, without a reload: Settings writes the whole settings
  // object, so any write is worth re-reading the scope from.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) void applyPanelScope();
  });

  chrome.runtime.onInstalled.addListener(() => void bootstrap());
  chrome.runtime.onStartup.addListener(() => void bootstrap());

  chrome.runtime.onMessage.addListener((msg: RpcRequest | { type?: string }, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.includes('.')) return false; // not an RPC (e.g. content events)
    handleRpc(msg as RpcRequest)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  });

  chrome.runtime.onConnect.addListener((port) => {
    // A mod's GM shim and the Safari runner both connect too; exec.install() registered their
    // listener, so anything that is not the panel's agent port is not ours to handle here.
    if (port.name !== 'agent') return;
    agentPorts.add(port);
    // A panel is listening again, so the transcript is its to write. Whatever was kept on its
    // behalf while nobody was (see recordDetached) goes to storage now, before it reads.
    void flushDetached();
    port.onMessage.addListener((req: AgentPortRequest) => {
      if (req.type === 'resume') {
        // Nothing to do if this chat is already running: the button was pressed twice, or in two
        // panels. A second run over the same conversation is exactly what this must never start.
        if (!sessions.isRunning(req.chatId)) void runChat(req.chatId, req.tabId, null);
        return;
      }
      if (req.type === 'abort') {
        // Only this chat. Stop used to abort whatever the port last started, which meant pressing
        // Stop in the chat you were reading killed a run belonging to a different tab.
        for (const id of sessions.abort(req.chatId)) postAgentEvent(req.chatId, { type: 'unqueued', id });
        return;
      }
      // `images` rides along with the turn. It is the only part of a message that is expensive to
      // move, and it moves exactly once: the panel has already downscaled and re-encoded it, the
      // loop turns it into image parts, and slimMessages decides how long the history keeps it.
      const turn: UserTurn = { id: req.id, text: req.text, refs: req.refs, images: req.images };
      const { start } = sessions.accept(req.chatId, req.tabId, turn);
      if (start) void runChat(req.chatId, req.tabId, turn);
    });
    // The panel going away does NOT stop a run. The model history is keyed by chat id and written
    // here, so a run that finishes with no panel attached still lands in the right chat; killing it
    // instead would throw away work the moment the user switched to a window without the side
    // panel. The TRANSCRIPT is normally the panel's to write, so while no panel is attached the
    // background keeps it instead (recordDetached), and a panel that comes back finds every row the
    // run produced rather than a conversation that stops where it was closed.
    port.onDisconnect.addListener(() => agentPorts.delete(port));
  });
});

// ---------- agent sessions ----------

/**
 * One run per chat, not one per panel. See lib/sessions.ts for why. The map is module-scoped so a
 * run survives the side panel closing and reopening (the panel reconnects and picks the stream up
 * by chat id).
 */
const sessions = new SessionMap();

/** Every open side-panel port. A chat's events go to all of them; each panel routes by chat id. */
const agentPorts = new Set<chrome.runtime.Port>();

/**
 * Which OpenAI-compatible endpoints have refused an image (lib/providers/vision.ts).
 *
 * One instance for the whole worker, so two chats running against the same endpoint at once share
 * what either of them learns rather than each paying for its own 400. It is backed by
 * chrome.storage.local, so the knowledge outlives the worker as well.
 */
const visionMemory = createVisionMemory();

/**
 * The single chokepoint where an agent event is stamped with its chat and put on the wire. The
 * agent loop emits AgentEventBody, which has no chat id at all, so no emitter can forget one.
 */
function postAgentEvent(chatId: string, body: AgentEventBody): void {
  const event: AgentEvent = { ...body, chatId };
  // What this chat's run last said it was doing, for a panel that opens mid-run ('agent.attach').
  if (body.type === 'status') {
    if (body.phase === 'idle') lastStatus.delete(chatId);
    else lastStatus.set(chatId, event as Extract<AgentEvent, { type: 'status' }>);
  }
  if (!agentPorts.size) recordDetached(chatId, body);
  for (const port of agentPorts) {
    try {
      port.postMessage(event);
    } catch {
      /* that panel closed; others still get it */
    }
  }
}

// ---------- the transcript, while no panel is open ----------

/** The last status event each running chat posted. Cleared by that chat's 'idle'. */
const lastStatus = new Map<string, Extract<AgentEvent, { type: 'status' }>>();

/**
 * Transcripts being kept on the panel's behalf, by chat id: the reduced items, and whether they
 * have changed since they were last written.
 *
 * The panel owns 'chat:<id>:items' whenever one is open — it holds the user's bubbles and applies
 * every event, for visible and off-screen chats alike. With NO panel open nobody did, and events
 * "went nowhere": a run that carried on after the panel was closed finished correctly in the model
 * history and left a transcript that stopped where the panel had been closed, tool rows and the
 * reply simply missing. This applies the same pure reduction the panel uses (lib/transcript.ts)
 * to the stored items for exactly that interval, and hands back the moment a port connects.
 */
const detached = new Map<string, { items: Promise<ChatItem[]>; latest: ChatItem[] | null; timer: ReturnType<typeof setTimeout> | null }>();

/** Text deltas arrive many times a second; everything else is written at once. */
const DETACHED_TEXT_DEBOUNCE_MS = 400;

function recordDetached(chatId: string, body: AgentEventBody): void {
  // These never change a transcript (reduceItems returns its input), so they need not load one.
  if (body.type === 'status' || body.type === 'chat_title' || body.type === 'done') {
    if (body.type === 'done') void flushDetachedChat(chatId);
    return;
  }
  let entry = detached.get(chatId);
  if (!entry) {
    entry = { items: loadItems(chatId).catch(() => [] as ChatItem[]), latest: null, timer: null };
    detached.set(chatId, entry);
  }
  const e = entry;
  e.items = e.items.then((items) => {
    const next = reduceItems(items, body);
    if (next === items) return items;
    e.latest = next;
    // Still the entry of record? A port may have connected and flushed while the load was pending.
    if (detached.get(chatId) !== e) {
      void saveItems(chatId, next).catch(() => {});
      return next;
    }
    if (e.timer) clearTimeout(e.timer);
    if (body.type === 'text') e.timer = setTimeout(() => void writeDetached(chatId, e), DETACHED_TEXT_DEBOUNCE_MS);
    else void writeDetached(chatId, e);
    return next;
  });
}

async function writeDetached(chatId: string, entry: { latest: ChatItem[] | null; timer: ReturnType<typeof setTimeout> | null }): Promise<void> {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  const items = entry.latest;
  entry.latest = null;
  if (items) await saveItems(chatId, items).catch(() => {});
}

async function flushDetachedChat(chatId: string): Promise<void> {
  const entry = detached.get(chatId);
  if (!entry) return;
  detached.delete(chatId);
  await entry.items.catch(() => {});
  await writeDetached(chatId, entry);
}

/** Write out everything being kept, and stop keeping it. Called when a panel connects. */
async function flushDetached(): Promise<void> {
  await Promise.all([...detached.keys()].map((id) => flushDetachedChat(id)));
}

// ---------- run records (lib/runstate.ts) ----------

/** One writer, one chain: two chats finishing at once must not lose each other's record. */
let runsChain: Promise<unknown> = Promise.resolve();

function updateRuns(fn: (runs: RunMap) => RunMap): Promise<void> {
  const next = runsChain
    .catch(() => {})
    .then(async () => {
      const runs = await loadRuns();
      const updated = fn(runs);
      if (updated !== runs) await saveRuns(updated);
    });
  runsChain = next;
  return next.catch(() => {});
}

function setRun(chatId: string, patch: Pick<RunRecord, 'state' | 'tabId'> & { error?: string }): Promise<void> {
  return updateRuns((runs) => {
    const now = Date.now();
    const prev = runs[chatId];
    const startedAt = patch.state === 'running' || !prev ? now : prev.startedAt;
    return { ...runs, [chatId]: { state: patch.state, tabId: patch.tabId, startedAt, updatedAt: now, ...(patch.error ? { error: patch.error } : {}) } };
  });
}

function clearRuns(ids: string[]): Promise<void> {
  return updateRuns((runs) => {
    if (!ids.some((id) => id in runs)) return runs;
    const next = { ...runs };
    for (const id of ids) delete next[id];
    return next;
  });
}

/**
 * Find the runs that died with a previous worker and mark them interrupted; forget records whose
 * chat is gone. Called at worker start, and again by 'agent.attach' so the panel never reads the
 * records before this has had its say. It never resumes anything: that takes a click.
 */
function recoverRuns(): Promise<void> {
  return (async () => {
    // An index that could not be read prunes nothing: a storage hiccup must not forget a run.
    const chats = await listChats().catch(() => null);
    const existing = chats ? new Set(chats.map((c) => c.id)) : null;
    await updateRuns((runs) => markInterrupted(existing ? pruneRuns(runs, existing) : runs, (id) => sessions.isRunning(id)).runs);
  })().catch((e) => console.warn('[usermods] recoverRuns', e));
}

/** The answer to 'agent.attach': see lib/rpc.ts. */
async function attachState(): Promise<AgentAttachState> {
  // Both must have settled before the panel reads storage on the strength of this answer.
  await Promise.all([flushDetached(), recoverRuns()]);
  await runsChain.catch(() => {});
  const runs = await loadRuns().catch(() => ({}) as RunMap);
  const running: AgentAttachState['running'] = {};
  for (const id of sessions.ids()) {
    if (!sessions.isRunning(id)) continue;
    const status = lastStatus.get(id);
    running[id] = { startedAt: runs[id]?.startedAt ?? Date.now(), ...(status ? { status } : {}) };
  }
  const resumable = resumableRuns(runs);
  // A chat that is running in THIS worker is not resumable, whatever an old record says.
  for (const id of Object.keys(running)) delete resumable[id];
  return { running, resumable };
}

/**
 * Keep the worker alive while a run is in flight.
 *
 * Chrome stops an extension service worker after 30 seconds without an extension event or API
 * call, and an in-flight fetch is neither. A model that thinks for a minute before its first byte
 * produces no events at all in that time (nothing is streaming to the panel, and with the panel
 * closed nothing would be posted anyway), so the worker could be stopped under a healthy request.
 * Calling a trivial extension API on a timer for the duration of the work is the pattern Chrome's
 * own migration guide gives for exactly this ("keep a service worker alive until a long-running
 * operation is finished"). It is scoped to running sessions and released when the last one ends.
 *
 * This is a reduction in how often a run is interrupted, not a guarantee against it: the browser
 * can still quit, the extension can be reloaded, the worker can be killed by hand. Those all land
 * on the interrupted path above.
 */
const KEEPALIVE_MS = 20_000;
let keepAliveHolds = 0;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

function holdWorker(): () => void {
  if (keepAliveHolds++ === 0) keepAliveTimer = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), KEEPALIVE_MS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--keepAliveHolds === 0 && keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  };
}

/**
 * One run of one chat. `turn` is the message that starts it, or null to RESUME: continue from the
 * saved conversation without adding anything to it (see AgentInput.turn).
 */
async function runChat(chatId: string, tabId: number, turn: UserTurn | null): Promise<void> {
  const session = sessions.ensure(chatId, tabId);
  session.running = true;
  session.controller = new AbortController();
  const signal = session.controller.signal;
  const post = (e: AgentEventBody) => postAgentEvent(chatId, e);
  const release = holdWorker();
  // Written before anything else happens, so there is no moment at which a run exists and storage
  // does not know. It also replaces a 'failed' or 'interrupted' record: whether this is a resume or
  // a new message, that run is no longer the thing to resume.
  await setRun(chatId, { state: 'running', tabId: session.tabId });
  // Only a turn that finished cleanly is worth naming: an aborted or failed one has nothing
  // the model could summarise, and the user's own message is already the placeholder title.
  let succeeded = false;
  let settings: Settings | null = null;
  // Held outside the try so the catch can still write the conversation back. runAgent only
  // returns messages on success, so a provider error (429, a bad key) would otherwise leave
  // the whole chat unsaved and the user's turn lost.
  let history: Msg[] = [];
  /** The page this turn was sent from, recorded on the chat so the dashboard can reopen it there. */
  let url = '';
  /** Set when the run stopped short with its conversation saved, which is what Resume needs. */
  let failed: string | null = null;
  /** Whether the loop has written the conversation back at least once (see onCheckpoint). */
  let checkpointed = false;
  try {
    if (!turn) post({ type: 'status', phase: 'model', detail: 'resuming' });
    // Which model this run talks to: the chat's own selection, resolved NOW. That one read is what
    // makes a swap in the composer apply to the next turn, a queued message use whatever is selected
    // when it starts, and a Resume continue on the chat's current model rather than the one that
    // failed. A selection that cannot be used throws here, before anything is sent anywhere — it is
    // reported, never replaced with another provider.
    const resolved = await resolveChatModel(chatId);
    settings = resolved.settings;
    post({ type: 'model', connectionId: resolved.selection.connectionId, label: resolved.selection.label ?? '', model: resolved.selection.model });
    history = await loadMessages(chatId);
    if (!turn && !history.length) throw new Error('There is nothing to resume in this chat. Send your message again.');
    const retryPolicy = resolvePolicy((await chrome.storage.local.get(RETRY_POLICY_KEY).catch(() => ({}) as Record<string, unknown>))[RETRY_POLICY_KEY]);
    // The chat's draft mod, read once at the top of the turn and kept up to date by the recorder
    // below. renderTurn asks for it on every user message, including ones queued mid-run, so a
    // proposal made in step 3 is what a message queued in step 4 is answered against.
    let artifact = await loadArtifact(chatId);
    // The first message of a chat names it. Every message records the page it was sent from, so
    // the dashboard can reopen the chat on that page rather than the site's front door.
    url = await tabUrl(session.tabId);
    // The mods on this page, read once at the top of the turn. Once per turn and not once per
    // message is the right granularity: a mod installed mid-turn is not something the model is
    // owed mid-sentence, and re-reading the whole mod list for every queued message would put a
    // storage read (and every mod's full source) on the hot path of a streaming reply.
    const installedMods = await loadMods().catch(() => [] as Mod[]);
    await touchChat(chatId, history.length || !turn ? { url } : { title: turn.text, url });
    const outcome = await runAgent({
      settings,
      history,
      turn,
      pullQueued: () => session.queue.splice(0),
      env: envForTab(session.tabId),
      emit: post,
      signal,
      // Built here rather than inside the loop so it carries the two things only the background
      // has: the persistent record of which endpoints refuse images, and a way to tell the user
      // when one just did. Both are inert for every provider but the OpenAI-compatible one.
      provider: createProvider(settings, {
        memory: visionMemory,
        // Once per run, not once per request: a turn with four screenshots in it against a
        // text-only endpoint discovers the same fact four times, and the transcript only needs to
        // say it once. The reducer dedupes consecutive notes as well, which covers the case where
        // two chats learn it at the same moment.
        onVisionUnsupported: () => post({ type: 'note', text: VISION_FALLBACK_PANEL_NOTE }),
      }),
      // How `screenshot` is described to the model. Only the OpenAI-compatible adapter can ever
      // answer no, and only once it has learned so — every other backend shows images to every
      // model it serves, so the question never arises for them.
      canSeeImages: () =>
        settings!.provider !== 'openai-compatible' ||
        (resolveImagesSetting(settings!.images) !== 'never' && !visionMemory.isUnsupportedNow(visionKeyFor(settings!))),
      // The compaction summary is the same one tool-free call the chat titler uses, with its own
      // deadline: a summariser that hangs must not hold up the user's turn, and compact() falls
      // back to dropping the oldest turns when this rejects.
      complete: (system, user, sig) => completeWithTimeout(settings!, system, user, COMPACT_TIMEOUT_MS, sig),
      // With a draft, the summary is asked for its history rather than its code: the code itself is
      // re-attached to every turn, so copying it into a 1500-token summary buys a worse copy of
      // something the model can already see. See SUMMARY_SYSTEM_PROMPT_WITH_DRAFT.
      hasDraft: () => artifact != null,
      // A compacted history is written back immediately. The next turn then starts from the small
      // version even if this one later dies mid-run, which is the whole point: the chat that was
      // too big to send must not stay too big to send.
      onCompacted: (msgs) => saveMessages(chatId, msgs),
      // The conversation is written back after every completed step, not only at the end. If the
      // worker is evicted half-way through a twenty-step run, nineteen steps are on disk.
      onCheckpoint: async (msgs) => {
        await saveMessages(chatId, msgs);
        checkpointed = true;
      },
      retry: { policy: retryPolicy },
      draft: () => (artifact ? draftBlock(artifact) : ''),
      // Which mods already run on the page this turn is being sent from. Read fresh each time it is
      // asked for rather than captured once: open_mod links this chat to one of them mid-turn, and
      // the queued message that follows must see "THIS CHAT IS EDITING THIS ONE" against it.
      installed: () => modsBlock(modsForUrl(installedMods, url, artifact?.linkedModId)),
      onOpenMod: async (modId, replace) => {
        const mod = (await loadMods()).find((m) => m.id === modId);
        // The id came from a list this same worker wrote, so a miss means the mod was deleted
        // between the turn opening and the call. Naming the ones that are there beats "not found".
        if (!mod) {
          const here = modsForUrl(await loadMods(), url);
          return {
            ok: false,
            reason: here.length
              ? `There is no installed mod with id ${modId}. The ids on this page are: ${here.map((m) => m.id).join(', ')}.`
              : `There is no installed mod with id ${modId}, and nothing is installed on this page.`,
          };
        }
        const decision = openModDecision(draftStanding(artifact), { replace, alreadyLinked: artifact?.linkedModId === mod.id });
        if (!decision.ok) return { ok: false, reason: decision.reason };
        if (!decision.noop) {
          // Adopt, rather than replace: the versions this chat already held stay in the strip, so
          // a chat that opened the wrong mod is one rollback away from where it was.
          artifact = artifact ? adoptMod(artifact, mod) : fromMod(chatId, mod);
          await saveArtifact(artifact);
          await setChatArtifact(chatId, artifact.id, artifact.versions.length);
          // The panel re-reads the artifact on this event, which is how the "Editing <name>" line
          // and the draft's code appear while the run is still going.
          post({ type: 'artifact', version: artifact.current });
        }
        return {
          ok: true,
          version: artifact ? artifact.current : null,
          text: [
            decision.noop
              ? `This chat is already editing \u201C${mod.name}\u201D. Its current script is below.`
              : `\u201C${mod.name}\u201D is now this chat's draft (v${artifact!.current}), and Save will write over that mod in place. Its current script is below \u2014 read it before you change anything, and keep what it already does.`,
            mod.grants.length ? `It is granted: ${mod.grants.join(', ')}.` : '',
            mod.requires.length ? `It loads ${mod.requires.length} @require script(s), which are kept for you.` : '',
            'Its ==UserScript== metadata block is kept and re-attached on save, so do NOT write one into your code.',
            '```javascript',
            mod.source,
            '```',
          ]
            .filter(Boolean)
            .join('\n'),
        };
      },
      onProposal: async (proposal) => {
        artifact = await recordProposal(chatId, proposal);
        // The index carries only the flag, so the dashboard can badge a chat without reading every
        // artifact. It is written through setChatArtifact rather than touchChat, because proposing
        // is not activity the switcher should reorder on.
        await setChatArtifact(chatId, artifact.id, artifact.versions.length);
        return artifact.current;
      },
    });
    // Whatever happened, the loop hands back a valid conversation holding everything it completed:
    // every assistant message, every tool call and every tool result up to the step that failed.
    const messages = outcome.messages;
    await saveMessages(chatId, messages);
    await touchChat(chatId, { url, turns: countTurns(messages) });
    if (outcome.failure) failed = outcome.failure.message;
    succeeded = !signal.aborted && !outcome.failure;
  } catch (e) {
    // The run never reached the loop (no API key, no model, storage unreadable). The turn is still
    // recorded, so fixing the setting and pressing Resume continues without retyping anything.
    failed = e instanceof Error ? e.message : String(e);
    try {
      // Once the loop has checkpointed, what is in storage is at least as complete as anything that
      // could be rebuilt here, so it is left alone.
      const kept = checkpointed ? await loadMessages(chatId) : turn ? appendTurn(history, turn) : history;
      if (turn && !checkpointed) await saveMessages(chatId, kept);
      await touchChat(chatId, { url, turns: countTurns(kept) });
      if (!kept.length) failed = null;
    } catch {
      /* storage failed too; the error below is still reported */
    }
    if (failed === null) post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
  if (failed !== null && !signal.aborted) {
    // The record goes in BEFORE the event, so a panel that reloads on seeing the error finds it.
    await setRun(chatId, { state: 'failed', tabId: session.tabId, error: failed });
    post({ type: 'error', message: failed, resumable: true });
  } else {
    await clearRuns([chatId]);
  }
  release();
  session.running = false;
  // Stop clears the queue; otherwise anything still waiting starts the next turn.
  const next = session.queue.shift();
  if (next && !signal.aborted) {
    void runChat(chatId, session.tabId, next);
  } else {
    // The panel's activity line watches for this: 'idle' is what makes this chat's indicator
    // disappear. It goes through the same post() as everything else, so it is stamped with this
    // chat's id and cannot switch off the indicator of a chat that is still running.
    post({ type: 'status', phase: 'idle', detail: 'done' });
    post({ type: 'done' });
    sessions.release(chatId);
    // Naming the chat is a second, tool-free model call. It runs only after 'done' has been
    // posted and its result is never awaited by the turn, so a slow or failing title call cannot
    // delay, break or fail what the user actually asked for. Errors are swallowed and logged.
    // It posts through this chat's own post(), so the rename lands on this chat and no other.
    if (succeeded && settings) void nameChat(chatId, settings, post);
  }
}

/**
 * The scope the action-click listener reads, cached in the worker.
 *
 * Defaulting to 'tab' matches resolveScope's answer for a profile that has stored nothing, so a
 * click that beats the first storage read behaves the same as one after it.
 */
let panelScope: SidePanelScope = 'tab';

/**
 * Put Chrome's window-level panel into the shape the stored scope asks for.
 *
 * Under 'tab' this DISABLES the window panel. That is the half of the fix that stops the panel
 * appearing on tabs the user never opened it on: a tab with no per-tab options falls back to the
 * window default, so with the default disabled, every other tab has no panel at all. The per-tab
 * options the action click sets override it for the one tab that asked.
 */
async function applyPanelScope() {
  try {
    const r = await chrome.storage.local.get('settings');
    panelScope = resolveScope(r.settings as Partial<Settings> | undefined);
  } catch {
    panelScope = 'tab';
  }
  if (!sidePanelAvailable()) return;
  const plan = windowPanelPlan(panelScope);
  try {
    await chrome.sidePanel.setOptions(plan.options);
  } catch (e) {
    console.warn('[usermods] sidePanel.setOptions', e);
  }
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: plan.openPanelOnActionClick });
  } catch (e) {
    console.warn('[usermods] sidePanel.setPanelBehavior', e);
  }
}

async function bootstrap() {
  try {
    await exec.configure();
    await syncRegistrations();
  } catch (e) {
    console.warn('[usermods] bootstrap', e);
  }
  try {
    await installUserJsRedirect();
  } catch (e) {
    console.warn('[usermods] .user.js redirect', e);
  }
}

/**
 * Clicking a .user.js link should open our install page rather than showing the raw source, which
 * is what Tampermonkey does. \0 in the substitution is the whole matched URL.
 *
 * The matched URL goes in the FRAGMENT, not a query parameter. A query parameter is parsed by the
 * install page, so an attacker URL carrying its own `&url=…` would decide what the page previewed;
 * everything after the first '#' is taken verbatim instead, which nothing can smuggle past. It also
 * means a script URL with a fragment of its own survives, because we never parse the remainder.
 */
const USER_JS_RULE_ID = 1;

async function installUserJsRedirect(): Promise<void> {
  const target = chrome.runtime.getURL('install.html');
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [USER_JS_RULE_ID],
    addRules: [
      {
        id: USER_JS_RULE_ID,
        priority: 1,
        action: { type: 'redirect', redirect: { regexSubstitution: `${target}#\\0` } },
        condition: {
          regexFilter: String.raw`^https?://[^?#]+\.user\.js([?#].*)?$`,
          isUrlFilterCaseSensitive: false,
          resourceTypes: ['main_frame'],
        },
      },
    ],
  });
}

// ---------- chat titles ----------

/**
 * One tool-free model call: ask the provider for a short answer to a system prompt.
 *
 * This deliberately reuses Provider.chat with an empty tool list rather than adding a method to the
 * Provider interface — every adapter already omits the tools field when there are none, so all four
 * backends get this for free and none of them grew an API.
 */
async function complete(settings: Settings, system: string, user: string, signal?: AbortSignal): Promise<string> {
  const res = await createProvider(settings).chat({
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    tools: [],
    signal,
    callbacks: { onText: () => {} },
  });
  return res.content
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
}

/** A title call that hangs must not keep the worker alive, so it gets its own deadline. */
const TITLE_TIMEOUT_MS = 20_000;

/**
 * The compaction summary reads a long conversation and writes a long answer, so it gets more room
 * than a title call. Past this the loop stops waiting and drops the oldest turns instead.
 */
const COMPACT_TIMEOUT_MS = 60_000;

/**
 * `complete` with a deadline of its own, and with the caller's signal still able to cancel it:
 * pressing Stop mid-summary aborts the summary too.
 */
async function completeWithTimeout(
  settings: Settings,
  system: string,
  user: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) ac.abort();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await complete(settings, system, user, ac.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Give the chat a model-written name, if it is due one.
 *
 * Called after 'done' has already been posted, so nothing here is on the user's critical path.
 * Every failure — no provider, a 429, a nonsense reply, the chat being deleted meanwhile — leaves
 * the existing title in place and is logged, never surfaced as a chat error.
 */
async function nameChat(chatId: string, settings: Settings, post: (e: AgentEventBody) => void): Promise<void> {
  try {
    if (settings.autoNameChats === false) return;
    const chat = await getChat(chatId);
    const messages = await loadMessages(chatId);
    const decision = titleDecision(chat, completedTurns(messages), true);
    if (decision.kind === 'none') return;
    const refresh = decision.kind === 'refresh';
    // The first title reads the whole first exchange; the refresh reads what the chat has become,
    // which is the last three things the user asked for.
    const input = buildTitleInput(messages, refresh ? { userMessages: 3, includeAssistant: false } : { userMessages: 1, includeAssistant: true });
    if (!input) return;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TITLE_TIMEOUT_MS);
    let raw: string;
    try {
      raw = await complete(settings, TITLE_SYSTEM_PROMPT, input, ac.signal);
    } finally {
      clearTimeout(timer);
    }

    const title = sanitizeTitle(raw);
    // An empty or refusal-shaped reply means keep what we have. The refresh is still spent, so a
    // model that will not name this chat is not asked again on every later turn.
    if (!title) {
      if (refresh) await markTitleRefreshed(chatId);
      return;
    }
    const stored = await setModelTitle(chatId, title, { refresh });
    // The panel may be closed, in which case the title is simply stored and read back next open.
    if (stored) post({ type: 'chat_title', title: stored });
  } catch (e) {
    console.warn('[usermods] chat title', e);
  }
}

// ---------- RPC ----------

async function handleRpc(req: RpcRequest): Promise<unknown> {
  switch (req.type) {
    case 'mods.list':
      return loadMods();
    case 'mods.save': {
      const mods = await upsertMod(req.mod);
      await syncRegistrations();
      return mods;
    }
    case 'mods.delete': {
      const mods = await deleteMod(req.id);
      await syncRegistrations();
      return mods;
    }
    case 'mods.toggle': {
      const mods = await loadMods();
      const m = mods.find((x) => x.id === req.id);
      if (m) {
        m.enabled = req.enabled;
        m.updatedAt = Date.now();
      }
      await saveMods(mods);
      await syncRegistrations();
      return mods;
    }
    case 'mods.preview':
      return 'url' in req ? previewFromUrl(req.url) : previewFromSource(req.source);
    case 'mods.install': {
      const mod = await installSource(req.source, { downloadUrl: req.downloadUrl, enabled: req.enabled, values: req.values });
      const mods = await upsertMod(mod);
      await syncRegistrations();
      return mods;
    }
    case 'mods.saveSource': {
      const mods = await upsertMod(await saveEditedSource(req.id, req.source));
      await syncRegistrations();
      return mods;
    }
    case 'mods.update':
      return updateMod(req.id);
    case 'mods.importBackup':
      return importBackup(req);
    case 'mods.try': {
      // A saved mod runs exactly as it would on a page load: GM shim, @require bodies, its world.
      if ('modId' in req) {
        const mod = (await loadMods()).find((m) => m.id === req.modId);
        if (!mod) throw new Error('That mod no longer exists.');
        const code = await exec.buildModCode(mod, await loadGmValues(mod.id), { tabId: req.tabId, frameId: 0 });
        return legacyRunShape(await executeInTab(req.tabId, code, { world: mod.world, raw: true }));
      }
      return legacyRunShape(await executeInTab(req.tabId, req.code, { raw: true }));
    }
    case 'userScripts.status':
      return exec.status();
    case 'page.pick':
      await sendToContent(req.tabId, { type: 'pick' });
      return { ok: true };
    case 'page.info': {
      const tab = await chrome.tabs.get(req.tabId);
      return { url: tab.url ?? '', title: tab.title ?? '' };
    }
    case 'chats.list':
      return listChats(req.host);
    case 'chats.listAll':
      return listChats();
    case 'chats.transcript':
      return loadItems(req.id);
    case 'chats.create':
      return createChat(req.host, req.model);
    case 'chats.setModel':
      await setChatModel(req.id, req.model);
      return { ok: true };
    case 'agent.attach':
      return attachState();
    case 'chats.delete':
      await deleteChat(req.id);
      await clearRuns([req.id]);
      return { ok: true };
    case 'chats.archive':
      await archiveChat(req.id, req.archived);
      return { ok: true };
    case 'chats.rename':
      await renameChat(req.id, req.title);
      return { ok: true };
    case 'chats.bulk':
      await bulkChats(req.ids, req.action);
      if (req.action === 'delete') await clearRuns(req.ids);
      return { ok: true };
    case 'mods.bulk': {
      const wanted = new Set(req.ids);
      let mods = await loadMods();
      if (req.action === 'delete') {
        mods = mods.filter((m) => !wanted.has(m.id));
        await saveMods(mods);
        // Each deleted mod's GM value store goes with it, the way deleteMod does it one at a time.
        await chrome.storage.local.remove([...wanted].map((id) => gmValuesKey(id)));
      } else {
        const enabled = req.action === 'enable';
        const now = Date.now();
        for (const m of mods) {
          if (!wanted.has(m.id) || m.enabled === enabled) continue;
          m.enabled = enabled;
          m.updatedAt = now;
        }
        await saveMods(mods);
      }
      await syncRegistrations();
      return mods;
    }
    case 'oauth.status': {
      if (SUBSCRIPTIONS_OFF) return { signedIn: false };
      const t = await (await oauthModule()).loadTokens(req.kind);
      return { signedIn: !!t, label: t?.label };
    }
    case 'oauth.start':
      if (SUBSCRIPTIONS_OFF) return { status: 'error', message: unavailableProviderMessage(req.kind) };
      return startLogin(req.kind);
    case 'oauth.poll':
      if (SUBSCRIPTIONS_OFF) return { status: 'error', message: unavailableProviderMessage(req.kind) };
      return logins.get(req.kind)?.state ?? { status: 'idle' };
    case 'oauth.cancel':
      if (SUBSCRIPTIONS_OFF) return { ok: true };
      logins.get(req.kind)?.controller.abort();
      logins.delete(req.kind);
      return { ok: true };
    case 'oauth.signout':
      if (SUBSCRIPTIONS_OFF) return { ok: true };
      logins.get(req.kind)?.controller.abort();
      logins.delete(req.kind);
      await (await oauthModule()).saveTokens(req.kind, null);
      return { ok: true };
    case 'models.list':
      return listModels(req.connectionId);
    case 'artifact.get':
      return loadArtifact(req.chatId);
    case 'artifact.rollback': {
      const a = await requireArtifact(req.chatId);
      const next = rollbackTo(a, req.version);
      await saveArtifact(next);
      await setChatArtifact(req.chatId, next.id, next.versions.length);
      return next;
    }
    case 'artifact.rename': {
      const a = await requireArtifact(req.chatId);
      const name = req.name.trim();
      const v = currentVersion(a);
      if (!name || !v || name === v.name) return a;
      // A rename is a version like any other, so the strip shows when the draft was renamed and a
      // rollback can undo it. addVersion dedupes an identical one, so this cannot make an empty step.
      const next = addVersion(a, { code: v.code, name, description: v.description, matches: v.matches, source: 'user-edit', untestedReason: a.untestedReason });
      await saveArtifact(next);
      await setChatArtifact(req.chatId, next.id, next.versions.length);
      return next;
    }
    case 'artifact.save':
      return saveArtifactAsMod(req.chatId, req.overwriteModId);
    case 'artifact.detach': {
      const a = await requireArtifact(req.chatId);
      const next = detachFromMod(a);
      await saveArtifact(next);
      // null, not undefined: the link is gone, and the index must stop claiming this chat edits
      // anything. The mod itself is untouched — nothing here loads, writes or deletes it.
      await setChatArtifact(req.chatId, next.id, next.versions.length, null);
      return next;
    }
    case 'mods.edit':
      return editModInChat(req.modId, req.currentChatId ?? null, req.host, req.model ?? null);
  }
}

/**
 * Bring a mod into a chat — the one mechanism behind "Edit in chat" on the Mods tab and in the
 * dashboard, the empty state's shortcuts, the composer's picker, and (through onOpenMod) the
 * open_mod tool.
 *
 * It returns the chat to show and what it did, and never destroys anything: an existing editing
 * chat is reused (unarchived if it was archived), an empty chat on screen is seeded, and anything
 * else gets a chat of its own — which is what keeps an unsaved draft in the current chat safe.
 *
 * The decision itself is `editModPlan` in lib/modmatch.ts, so it is testable without storage; this
 * function is the I/O around it.
 */
async function editModInChat(
  modId: string,
  currentChatId: string | null,
  host: string,
  /**
   * The model the composer was showing, when the caller has a composer. A chat CREATED here starts
   * on it, exactly as a chat created by a first message does. Callers without one (the Mods tab, the
   * dashboard) pass nothing, and the chat takes the new-chat default on its first run
   * (resolveChatModel). A reused or seeded chat keeps the model it already has.
   */
  model: ModelSelection | null = null,
): Promise<{ chatId: string; host: string; created: boolean; reused: boolean; unarchived: boolean; mod: Mod; artifact: Artifact; runsHere: boolean; likelyUrl: string }> {
  const mod = (await loadMods()).find((m) => m.id === modId);
  if (!mod) throw new Error('That mod no longer exists.');
  const chats = await listChats();
  // The page in front of the user, read once: it decides which host a new chat is filed under and
  // whether the panel has to say "this mod does not run here".
  const url = await activeUrl();
  const runsHere = runsOnPage(mod, url);
  const likelyUrl = likelyUrlFor([...mod.matches, ...mod.includeGlobs]);
  // Whether a chat counts as "empty" needs its draft and its transcript, and asking that of 200
  // chats would be 400 storage reads. It is only ever asked of the ONE chat on screen.
  const current = currentChatId ? (chats.find((c) => c.id === currentChatId) ?? null) : null;
  const currentCandidate = current
    ? {
        id: current.id,
        host: current.host,
        archived: isArchived(current),
        updatedAt: current.updatedAt,
        editingModId: current.editingModId,
        ...(await chatStanding(current.id)),
      }
    : null;
  const plan = editModPlan(
    modId,
    chats.map((c) => ({ id: c.id, host: c.host, archived: isArchived(c), updatedAt: c.updatedAt, editingModId: c.editingModId })),
    currentCandidate,
  );

  let chatId: string;
  let created = false;
  let unarchived = false;
  if (plan.action === 'reuse') {
    chatId = plan.chatId;
    if (plan.unarchive) {
      await archiveChat(chatId, false);
      unarchived = true;
    }
  } else if (plan.action === 'seed') {
    chatId = plan.chatId;
  } else {
    // Which host a new chat belongs to.
    //
    // The page in front of the user wins whenever the mod actually runs there. A mod matching
    // `*://*.wikipedia.org/wiki/*` read on en.wikipedia.org belongs in en.wikipedia.org's switcher,
    // not under a bare "wikipedia.org" the user has never been on — and a chat filed under a host
    // the panel is not showing is a chat the panel cannot open, because the switcher is per host.
    //
    // Only when the mod does NOT run here is a host derived from its patterns, which is the case
    // where the current page is genuinely the wrong answer: editing a Reddit mod from a Wikipedia
    // tab should not leave its chat filed under Wikipedia forever.
    const derived = runsHere ? hostFromUrl(url) : hostFromUrl(likelyUrl);
    chatId = (await createChat(derived || host, model)).id;
    created = true;
  }

  // Reuse keeps whatever draft that chat has — it is already this mod's, and a chat mid-revision
  // must not be rewound to what is installed. Every other path seeds or adopts.
  const existing = await loadArtifact(chatId);
  let artifact: Artifact;
  if (plan.action === 'reuse' && existing?.linkedModId === modId) artifact = existing;
  else {
    artifact = existing ? adoptMod(existing, mod) : fromMod(chatId, mod);
    await saveArtifact(artifact);
  }
  await setChatArtifact(chatId, artifact.id, artifact.versions.length, { id: mod.id, name: mod.name });
  return {
    chatId,
    // Read back rather than remembered: a reuse landed on a chat whose host this function never
    // chose, and a handoff addressed to the wrong host is one the panel silently ignores.
    host: (await getChat(chatId))?.host ?? host,
    created,
    reused: plan.action === 'reuse',
    unarchived,
    mod,
    artifact,
    runsHere,
    likelyUrl,
  };
}

/** Whether a chat has nothing in it, and whether what it has is saved anywhere. Two storage reads. */
async function chatStanding(chatId: string): Promise<{ empty: boolean; unsaved: boolean }> {
  const [artifact, items] = await Promise.all([loadArtifact(chatId), loadItems(chatId).catch(() => [] as ChatItem[])]);
  return { empty: !artifact && !items.length, unsaved: draftStanding(artifact) === 'unsaved' };
}

/** The URL of the tab the user is looking at, or '' when there is not one. */
async function activeUrl(): Promise<string> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url ?? '';
  } catch {
    return '';
  }
}

// ---------- the chat's draft mod ----------

async function requireArtifact(chatId: string): Promise<Artifact> {
  const a = await loadArtifact(chatId);
  if (!a) throw new Error('This chat has no draft mod yet.');
  return a;
}

/**
 * Save a chat's draft as a mod — the panel's Save, and its Update after the first one.
 *
 * The whole point of linkedModId is here. The first save creates a mod and records its id on the
 * artifact; every later save finds that mod and rewrites it in place. Before drafts, the panel
 * matched a proposal to a mod BY NAME (findByName), which meant renaming a mod in the dashboard,
 * or a model that retyped the name differently, quietly minted a second copy — and both copies ran
 * on the page. An id cannot drift.
 *
 * The rewrite goes through saveEditedSource, the same path the dashboard's source editor uses, so
 * the header is re-parsed from what is being saved (a draft whose matches changed re-registers on
 * the new ones) and @require/@resource are refetched if and only if the header's dependency lines
 * moved. A draft written by the model declares none of those, but a mod that was IMPORTED and then
 * edited in a chat can, and saving it through mods.save would have re-registered it with the
 * dependency missing.
 *
 * `relinked` says the link was broken and remade: the mod this artifact pointed at is gone (deleted
 * in the dashboard), so a new one was created. The panel tells the user rather than silently
 * appearing to update something that no longer exists.
 */
/**
 * What the panel's "Keep both" sends as `overwriteModId`: save a new mod and do not ask again.
 *
 * It is exported-by-convention rather than by module (the panel holds its own copy as NEW_MOD)
 * because lib/rpc.ts is the contract between the two and a shared constant would make this file an
 * import target for the panel, which it is not. The value is not a UUID, so it can never collide
 * with a real mod id.
 */
const KEEP_BOTH = 'new';

async function saveArtifactAsMod(
  chatId: string,
  overwriteModId?: string,
): Promise<{ artifact: Artifact; mod: Mod; created: boolean; relinked: boolean } | { duplicate: { id: string; name: string } }> {
  const artifact = await requireArtifact(chatId);
  const proposal = toProposal(artifact);
  if (!proposal) throw new Error('This draft has no versions to save.');

  const mods = await loadMods();
  const linked = artifact.linkedModId ? mods.find((m) => m.id === artifact.linkedModId) : undefined;
  const relinked = !!artifact.linkedModId && !linked;

  // The duplicate guard. An UNLINKED save has no id to aim at, so a mod with the same name and the
  // same reach is almost certainly the thing being revised rather than something to sit beside —
  // two identical mods both run, fight each other, and are indistinguishable in the list. The
  // choice is the user's, so this returns the question rather than picking an answer; the panel
  // asks, and calls back with overwriteModId (update) or with the flag cleared (keep both).
  //
  // A LINKED save never asks: it has an id and updates in place, which is already the right thing.
  // The user's answer to the duplicate question, when there was one. KEEP_BOTH is "neither of the
  // installed ones": it suppresses the guard without naming a mod to write, which is the only one
  // of the three answers a mod id cannot express. Any other value must name a mod that exists —
  // a stale id (the twin was deleted while the question was on screen) falls through to creating a
  // new mod rather than throwing, which is what "keep both" would have done anyway.
  const target = overwriteModId && overwriteModId !== KEEP_BOTH ? mods.find((m) => m.id === overwriteModId) : undefined;
  if (!linked && !overwriteModId) {
    const twin = duplicateOf(mods, { name: proposal.name, matches: proposal.matches });
    if (twin) return { duplicate: { id: twin.id, name: twin.name } };
  }

  // `into` is the mod being written: the chat's link, or the one the user chose to overwrite.
  const into = linked ?? target;
  let mod: Mod;
  if (into) {
    // In place: same id, same enabled flag, same GM value store, same createdAt. This is also what
    // keeps a DISABLED mod disabled when it is edited in chat and saved.
    mod = await saveEditedSource(into.id, toSource(artifact));
  } else {
    mod = modFromProposal(proposal as ModProposal);
    await resolveDependencies(mod);
  }
  await upsertMod(mod);
  await syncRegistrations();

  // Which version the mod now holds, not merely that a save happened. The panel and the transcript
  // both read this to tell the version that is installed from the one the model has since proposed.
  const next: Artifact = { ...artifact, linkedModId: mod.id, savedVersion: artifact.current };
  await saveArtifact(next);
  // The index mirror follows the link, so the switcher's "Editing" label and the dashboard's chat
  // list are right the moment a first save creates the link.
  await setChatArtifact(chatId, next.id, next.versions.length, { id: mod.id, name: mod.name });
  return { artifact: next, mod, created: !into, relinked };
}

// ---------- installing outside userscripts ----------

/**
 * Parse a userscript, fetch its dependencies and seed its GM store. Shared by URL install, file
 * import and Tampermonkey migration so all three behave identically.
 */
async function installSource(
  source: string,
  opts: { downloadUrl?: string; enabled?: boolean; values?: Record<string, unknown>; existing?: Mod } = {},
): Promise<Mod> {
  const mod = modFromSource(source, opts.existing);
  if (opts.downloadUrl) mod.downloadUrl = opts.downloadUrl;
  if (opts.enabled !== undefined) mod.enabled = opts.enabled;
  if (!mod.matches.length && !mod.includeGlobs.length) {
    throw new Error(`"${mod.name}" has no @match or @include lines, so it would never run.`);
  }
  await resolveDependencies(mod);
  if (opts.values && Object.keys(opts.values).length) {
    const existing = opts.existing ? await loadGmValues(mod.id) : {};
    await chrome.storage.local.set({ [gmValuesKey(mod.id)]: { ...existing, ...opts.values } });
  }
  return mod;
}

/**
 * Save an edited source over an existing mod — what the dashboard's source editor saves through.
 *
 * The two things this does that mods.save cannot. First, the header is re-parsed from the edited
 * text, so the name, patterns, grants, world and run-at all follow what the user actually wrote.
 * Second, @require and @resource are refetched when (and only when) the header's dependency lines
 * moved: re-registering with stale or empty bodies under a header that names new ones is exactly
 * how an edited mod starts throwing ReferenceError at page load with nothing on screen to say why.
 * A fetch failure throws before anything is written, so a broken mod is never saved — the editor
 * shows the error and the installed mod is left as it was.
 *
 * The mod's identity survives untouched: same id, so its registration and its gm:<id> value store
 * are the same ones; same enabled flag, same createdAt, same downloadUrl (so the Update button does
 * not vanish because the edit dropped the @downloadURL comment).
 */
async function saveEditedSource(id: string, source: string): Promise<Mod> {
  const existing = (await loadMods()).find((m) => m.id === id);
  if (!existing) throw new Error('That mod no longer exists.');
  const mod = reparseEditedSource(existing, source);
  if (!mod.matches.length && !mod.includeGlobs.length) {
    throw new Error(`"${mod.name}" has no @match or @include lines, so it would never run.`);
  }
  if (dependenciesChanged(source, existing)) await resolveDependencies(mod);
  return mod;
}

/** Refetch from @downloadURL and swap in the new source when the remote @version is newer. */
async function updateMod(id: string): Promise<{ updated: boolean; version: string }> {
  const mods = await loadMods();
  const mod = mods.find((m) => m.id === id);
  if (!mod) throw new Error('That mod no longer exists.');
  if (!mod.downloadUrl) throw new Error(`"${mod.name}" has no @downloadURL, so there is nothing to update from.`);
  const source = await fetchText(mod.downloadUrl);
  if (!/\/\/\s*==UserScript==/.test(source)) throw new Error(`${mod.downloadUrl} did not return a userscript.`);
  const next = parseHeader(source);
  // Versions are compared ordinally, so a downgrade (1.9 published after 1.10 was installed, or a
  // rolled-back file) does not overwrite what is installed. With no version on either side there
  // is nothing to order by, so the source text decides.
  if (!shouldUpdate({ version: mod.version, source: mod.source }, { version: next.version, source })) {
    return { updated: false, version: mod.version || next.version };
  }
  // Keep identity, enabled state and GM values; replace source and dependencies.
  const fresh = await installSource(source, { downloadUrl: mod.downloadUrl, enabled: mod.enabled, existing: mod });
  await upsertMod(fresh);
  await syncRegistrations();
  return { updated: true, version: fresh.version || next.version };
}

/** Import a Tampermonkey backup: JSON text, or a base64-encoded ZIP. */
async function importBackup(req: { json: string } | { zipBase64: string }): Promise<{ imported: number; skipped: string[]; mods: Mod[] }> {
  let parsed: { scripts: TmScript[]; skipped: string[] };
  if ('zipBase64' in req) {
    const bytes = Uint8Array.from(atob(req.zipBase64), (c) => c.charCodeAt(0));
    if (!looksLikeZip(bytes)) throw new Error('That file is not a ZIP archive.');
    const { unzipSync, strFromU8 } = await import('fflate');
    const entries = unzipSync(bytes);
    const text: Record<string, string> = {};
    for (const [path, data] of Object.entries(entries)) {
      if (!data.length) continue;
      try {
        text[path] = strFromU8(data);
      } catch {
        /* binary entry, not a script */
      }
    }
    parsed = parseTampermonkeyZipEntries(text);
  } else {
    parsed = parseTampermonkeyJson(req.json);
  }

  const mods = await loadMods();
  const skipped = [...parsed.skipped];
  let imported = 0;
  // Identity is @downloadURL, else @namespace + @name — never name + version, which treated every
  // new version of a script as a different script and installed a second copy of it.
  const byIdentity = new Map<string, Mod>();
  for (const m of mods) {
    byIdentity.set(scriptIdentity({ downloadUrl: m.downloadUrl, raw: parseHeader(m.source).raw, name: m.name }), m);
  }

  for (const s of parsed.scripts) {
    const header = parseHeader(s.source);
    const existing = byIdentity.get(scriptIdentity({ downloadUrl: s.downloadUrl, raw: header.raw, name: s.name }));
    try {
      // A duplicate updates in place: same mod id, so its registration and its gm:<id> store are
      // kept, and the backup's values are merged over what is there (the backup wins for the keys
      // it carries, other keys survive).
      const mod = await installSource(s.source, { downloadUrl: s.downloadUrl, enabled: s.enabled, values: s.values, existing });
      if (existing) {
        const i = mods.findIndex((m) => m.id === existing.id);
        if (i >= 0) mods[i] = mod;
        else mods.push(mod);
        skipped.push(`${s.name} (already installed — ${UPDATED_MARK})`);
      } else {
        mods.push(mod);
        imported++;
      }
      byIdentity.set(scriptIdentity({ downloadUrl: mod.downloadUrl, raw: parseHeader(mod.source).raw, name: mod.name }), mod);
    } catch (e) {
      skipped.push(`${s.name} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  await saveMods(mods);
  await syncRegistrations();
  return { imported, skipped, mods };
}

// ---------- GM API host ----------

/**
 * Re-register a mod after its GM store changes, so a page loaded later sees the new values.
 * Only that mod is updated: a full syncRegistrations() unregisters and re-registers every script,
 * which is both slower and a window in which nothing is registered. Install, delete and toggle
 * still go through the full sync, because those change which scripts exist.
 */
const gmResyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleResync(modId: string): void {
  clearTimeout(gmResyncTimers.get(modId));
  gmResyncTimers.set(
    modId,
    setTimeout(() => {
      gmResyncTimers.delete(modId);
      void resyncOne(modId);
    }, 500),
  );
}

async function resyncOne(modId: string): Promise<void> {
  // Under the content-script engine nothing is registered ahead of time: a mod's code and its GM
  // values are built when a document claims it, so the next page to load already has the new value
  // and there is nothing here to refresh.
  if (exec.engine !== 'user-scripts' || !userScriptsAvailable()) return;
  try {
    const mod = (await loadMods()).find((m) => m.id === modId);
    const registered = (await chrome.userScripts.getScripts({ ids: [modId] })).length > 0;
    const plan = resyncPlan(mod, registered);
    if (plan === 'none') return;
    if (plan === 'full') return void (await syncRegistrations());
    await exec.refresh(mod!, await loadGmValues(modId));
  } catch (e) {
    console.warn('[usermods] resync', modId, e);
  }
}

// ---------- live GM value changes (CONTRACT C3) ----------

/*
 * When one frame writes a GM value, every OTHER frame running that mod is told, so
 * GM_addValueChangeListener fires with remote: true the way Tampermonkey's does. Which ports carry
 * that is engine-specific, one per mod on Chrome and one per document on Safari, so it lives behind
 * exec.broadcast() in lib/exec/adapter.ts.
 */

async function handleGm(msg: GmMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'gm.setValue':
    case 'gm.deleteValue': {
      const key = gmValuesKey(msg.modId);
      const values = await loadGmValues(msg.modId);
      const name = String(msg.key);
      const oldValue = values[name];
      if (msg.type === 'gm.setValue') values[name] = msg.value;
      else delete values[name];
      await chrome.storage.local.set({ [key]: values });
      exec.broadcast(msg.modId, name, oldValue, msg.type === 'gm.setValue' ? msg.value : undefined, sender);
      scheduleResync(msg.modId);
      return true;
    }
    case 'gm.xhr': {
      const d = msg.details;
      if (!d?.url) throw new Error('GM_xmlhttpRequest needs a url');
      // @connect gates which hosts a script may reach (CONTRACT C1). A script that declared
      // nothing can still talk to the sites it runs on only if it said "self".
      const mod = (await loadMods()).find((m) => m.id === msg.modId);
      const check = checkConnect(d.url, connectOf(mod), mod ? [...mod.matches, ...mod.includeGlobs] : []);
      if (!check.allowed) throw new Error(check.reason);
      const controller = new AbortController();
      const timer = d.timeout ? setTimeout(() => controller.abort(), d.timeout) : undefined;
      try {
        const res = await fetch(d.url, {
          method: d.method || 'GET',
          headers: d.headers ?? {},
          body: d.data ?? null,
          signal: controller.signal,
          credentials: 'omit',
        });
        const responseHeaders = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\r\n');
        const base = { status: res.status, statusText: res.statusText, responseHeaders, finalUrl: res.url || d.url };
        // Binary responses cannot cross the messaging boundary, so they travel as base64 and the
        // shim rebuilds the ArrayBuffer or Blob on the other side (CONTRACT C2).
        if (d.responseType === 'arraybuffer' || d.responseType === 'blob') {
          const buf = new Uint8Array(await res.arrayBuffer());
          return { ...base, base64: toBase64(buf) };
        }
        const responseText = await res.text();
        let response: unknown = responseText;
        if (d.responseType === 'json') {
          try {
            response = JSON.parse(responseText) as unknown;
          } catch {
            response = null;
          }
        }
        // 'document' and '' both come back as text; the shim runs DOMParser where it can.
        return { ...base, responseText, response };
      } finally {
        clearTimeout(timer);
      }
    }
    case 'gm.openInTab': {
      if (!msg.url) throw new Error('GM_openInTab needs a url');
      const tab = await chrome.tabs.create({ url: msg.url, active: msg.active !== false, openerTabId: sender.tab?.id });
      return { id: tab.id };
    }
    case 'gm.log':
      console.log(`[usermods ${msg.modId}]`, ...(msg.args ?? []));
      return true;
    default:
      throw new Error(`Unknown GM call: ${String((msg as { type: string }).type)}`);
  }
}

// ---------- subscription sign-in (device code) ----------

const logins = new Map<OAuthKind, { state: OAuthLoginState; controller: AbortController }>();

/**
 * lib/oauth, loaded on demand. Every call site is behind `if (SUBSCRIPTIONS_OFF)`, so the bundler drops
 * this import — and the vendor auth endpoints it reaches — from the store build. See lib/buildflags.
 */
function oauthModule() {
  return import('@/lib/oauth');
}

async function startLogin(kind: OAuthKind): Promise<OAuthLoginState> {
  logins.get(kind)?.controller.abort();
  const controller = new AbortController();
  const entry = { state: { status: 'idle' } as OAuthLoginState, controller };
  logins.set(kind, entry);
  try {
    const o = await oauthModule();
    const login = kind === 'chatgpt' ? await o.startChatgptLogin() : await o.startXaiLogin();
    entry.state = { status: 'pending', userCode: login.userCode, verificationUri: login.verificationUri, expiresAt: login.expiresAt };
    void login
      .poll(controller.signal)
      .then(async (tokens) => {
        await o.saveTokens(kind, tokens);
        entry.state = { status: 'done' };
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        entry.state = { status: 'error', message: e instanceof Error ? e.message : String(e) };
      });
  } catch (e) {
    entry.state = { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  return entry.state;
}

/**
 * The connection and model a chat's next run uses, as the `Settings` every model-facing function
 * takes (lib/connections.ts effectiveSettings).
 *
 * A chat with no selection of its own — one from before connections existed — takes the default a
 * new chat would, and has it written onto the chat here, so it does not drift with the "last model
 * picked" from then on. A chat WITH a selection that cannot be used (its provider was removed, signed
 * out, lost its key, or is not in this build) throws the sentence the composer shows for the same
 * state. Loading the connections comes first because that is what migrates a legacy profile.
 */
async function resolveChatModel(chatId: string): Promise<{ settings: Settings; selection: ModelSelection }> {
  const connections = await loadConnections();
  const [prefs, last, signedIn, chat] = await Promise.all([loadSettings(), loadModelChoice(), loadSignedIn(), getChat(chatId)]);
  const resolved = resolveSelection(selectionForChat(chat, connections, last, signedIn), connections, signedIn);
  if (!resolved.ok) throw new Error(resolved.message);
  if (!sameSelection(chat?.model, resolved.selection) || chat?.model?.label !== resolved.selection.label) await setChatModel(chatId, resolved.selection);
  return { settings: effectiveSettings(prefs, resolved.connection, resolved.model), selection: resolved.selection };
}

/**
 * List one connection's models, and cache the answer on the connection.
 *
 * The request and the parsing are lib/modellist.ts (pure, unit tested); all that happens here is
 * fetching the sign-in headers a subscription provider needs, doing the I/O and writing the cache.
 * A subscription provider whose listing fails answers with a built-in list and the reason, so
 * signing in never leaves the picker with nothing to offer. A key-based one that fails throws, and
 * the failure is recorded beside whatever was cached before, so the picker keeps offering those.
 */
async function listModels(connectionId: string): Promise<ModelListResult> {
  const conn = (await loadConnections()).list.find((c) => c.id === connectionId);
  if (!conn) throw new Error('That provider was removed.');
  const target: ModelListTarget = { kind: conn.kind, baseUrl: conn.baseUrl, apiKey: conn.apiKey.trim() };
  // Outside the fallback: "not available in this build" is not a listing failure to paper over.
  if (SUBSCRIPTIONS_OFF && isSubscriptionProvider(target.kind)) throw new Error(unavailableProviderMessage(target.kind));
  const cache = (models: ModelCache) => mutateConnections((state) => updateConnection(state, connectionId, { models }));
  try {
    const result = await listWithFallback(target.kind, async () => {
      let auth: Record<string, string> = {};
      if (!SUBSCRIPTIONS_OFF && target.kind === 'chatgpt') {
        const o = await oauthModule();
        auth = o.chatgptHeaders(await o.getValidTokens('chatgpt'));
      } else if (!SUBSCRIPTIONS_OFF && target.kind === 'xai') {
        const o = await oauthModule();
        auth = o.xaiProxyHeaders('', (await o.getValidTokens('xai')).access);
      }
      const { url, headers } = modelsRequest(target, auth);
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(listFailureMessage(r.status, await r.text().catch(() => '')));
      return parseModelIds(await r.json());
    });
    await cache({ ids: result.models, fetchedAt: Date.now(), ...(result.fallback ? { fallback: true } : {}), ...(result.error ? { error: result.error } : {}) });
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await cache({ ids: conn.models?.ids ?? [], fetchedAt: Date.now(), error }).catch(() => {});
    throw e;
  }
}

// ---------- userScripts ----------

function userScriptsAvailable(): boolean {
  try {
    // Throws when the permission toggle is off.
    chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-register every enabled mod. What that means depends on the engine, so the work is the
 * adapter's; this stays as the one name the rest of the background calls after any change to the
 * mod list.
 */
async function syncRegistrations(): Promise<void> {
  await exec.sync(await loadMods(), loadGmValues);
}


/**
 * Run code once in a tab, in the USER_SCRIPT world. The wrapper captures console output, the
 * returned value (awaiting promises) and a count of what the DOM did, then reports back over
 * runtime messaging so async code works.
 *
 * `raw: true` injects the code exactly as given — that is the path `mods.try` uses, where the code
 * is a whole registered userscript and a last-expression rewrite would be wrong.
 */
async function executeInTab(
  tabId: number,
  code: string,
  opts: { world?: Mod['world']; timeoutMs?: number; raw?: boolean } = {},
): Promise<RunResult> {
  const { world = 'USER_SCRIPT', timeoutMs = 20_000, raw = false } = opts;
  const status = exec.status();
  if (!status.available) throw new Error(status.message);

  let source = code;
  if (!raw) {
    const prepared = prepareRunScript(code);
    // Injecting code we know does not parse wastes a round trip and reports the failure as a
    // runtime error from inside the wrapper; saying so here is both faster and more precise.
    if (!prepared.ok) return { outcome: { kind: 'threw', error: prepared.message }, logs: [] };
    source = prepared.code;
  }

  const runId = crypto.randomUUID();
  const { wrapped, lineOffset } = wrapForExecution(source, runId, exec.reportTransport);
  const codeLines = source.split('\n').length;

  // Watching the tab is how a lost result stops looking like a timeout. The wrapper reports over
  // chrome.runtime.sendMessage; a navigation or unload between the script finishing and that
  // message flushing drops it silently, and the model used to be told only that 20s had passed.
  const result = new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      exec.removeResultListener(listener);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(r);
    };

    const timer = setTimeout(() => finish({ outcome: { kind: 'timeout', seconds: timeoutMs / 1000 }, logs: [] }), timeoutMs);

    const listener = (msg: { type?: string; runId?: string } & Record<string, unknown>) => {
      if (msg?.type !== 'usermods:run-result' || msg.runId !== runId) return;
      const logs = (msg.logs as string[]) ?? [];
      if (msg.ok) {
        finish({
          outcome: {
            kind: 'ok',
            returnedValue: !!msg.returnedValue,
            result: msg.result as string | undefined,
            dom: msg.dom as { added: number; removed: number; attributes: number } | undefined,
          },
          logs,
        });
      } else {
        const stack = String(msg.error ?? '');
        finish({ outcome: { kind: 'threw', error: mapStack(stack, lineOffset, codeLines) }, logs });
      }
    };
    exec.addResultListener(listener);

    const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (id !== tabId || change.status !== 'loading') return;
      finish({ outcome: { kind: 'navigated', url: change.url ?? tab.url ?? 'a new page' }, logs: [] });
    };
    chrome.tabs.onUpdated.addListener(onUpdated);

    const onRemoved = (id: number) => {
      if (id === tabId) finish({ outcome: { kind: 'navigated', url: 'a closed tab' }, logs: [] });
    };
    chrome.tabs.onRemoved.addListener(onRemoved);

    // An injection that never starts is its own failure, and saying "timed out" for it is a lie.
    exec
      .injectOnce(tabId, wrapped, world)
      .catch((e: unknown) => finish({ outcome: { kind: 'injection-failed', reason: e instanceof Error ? e.message : String(e) }, logs: [] }));
  });

  return result;
}

/** The `{ok, result, logs, error}` shape `mods.try` and the panel have always spoken. */
function legacyRunShape(r: RunResult): { ok: boolean; result?: string; logs: string[]; error?: string } {
  const rendered = renderRunResult(r);
  if (r.outcome.kind === 'ok') return { ok: true, result: r.outcome.result ?? 'undefined', logs: r.logs };
  return { ok: false, error: rendered.text, logs: r.logs };
}

// ---------- content script plumbing ----------

async function sendToContent<T = unknown>(tabId: number, req: ContentRequest): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, req)) as T;
  } catch {
    // Content script not present (tab opened before install, or a reload). Inject and retry once.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/content.js'] });
    return (await chrome.tabs.sendMessage(tabId, req)) as T;
  }
}

/**
 * The URL of a tab, or '' if it has gone away. Used to stamp a chat with the page it was used on;
 * a turn must never fail because the tab closed mid-run, so this swallows the lookup error.
 */
async function tabUrl(tabId: number): Promise<string> {
  try {
    return (await chrome.tabs.get(tabId)).url ?? '';
  } catch {
    return '';
  }
}

/**
 * Wait until a condition holds in `tabId`, or until the timeout, Stop, or the tab going away.
 *
 * The split is by where the truth lives. A selector, page text or DOM quiet is only observable
 * from inside the page, so it goes to the content script (lib/waitdom.ts). A URL or a finished
 * navigation is only observable from here, because the content script that would have watched it
 * is destroyed by the very navigation being waited for — which is also why a url/load wait
 * re-injects the content script before returning, so the NEXT tool call works instead of paying
 * for a re-injection round trip of its own.
 *
 * Never rejects. Everything that can go wrong (a closed tab, a page that will not take a message)
 * is reported as an outcome, because the model can act on "the tab closed" and cannot act on a
 * rejected promise that the loop turns into a bare error string.
 */
async function waitInTab(tabId: number, spec: WaitSpec, signal: AbortSignal): Promise<WaitOutcome> {
  const startedAt = Date.now();
  const c = spec.condition;

  if (signal.aborted) return { matched: false, elapsedMs: 0, failure: 'The wait was stopped.' };

  // A plain delay needs nothing but a timer — and an abort, so Stop does not sit through it.
  if (c.kind === 'ms') {
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, c.ms);
      const onAbort = () => done();
      function done() {
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        resolve();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const elapsedMs = Date.now() - startedAt;
    if (signal.aborted) return { matched: false, elapsedMs, failure: 'The wait was stopped.' };
    return { matched: true, elapsedMs, detail: `waited ${elapsedMs}ms` };
  }

  if (isDomCondition(c)) {
    const id = crypto.randomUUID();
    // Stop cannot abort a message already in flight, so it is delivered as a second message the
    // content script matches by id (see `waits` in entrypoints/content.ts).
    const onAbort = () => void sendToContent(tabId, { type: 'wait-cancel', id }).catch(() => {});
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const outcome = await sendToContent<WaitOutcome>(tabId, { type: 'wait', id, condition: c, timeoutMs: spec.timeoutMs });
      // A cancel races the wait's own resolution; if Stop won, say so whatever came back.
      if (signal.aborted) return { matched: false, elapsedMs: Date.now() - startedAt, failure: 'The wait was stopped.' };
      return outcome;
    } catch (e) {
      const elapsedMs = Date.now() - startedAt;
      if (signal.aborted) return { matched: false, elapsedMs, failure: 'The wait was stopped.' };
      // The page went away or would not take the message: a clear outcome, not a hang.
      const gone = await chrome.tabs.get(tabId).then(() => false).catch(() => true);
      return {
        matched: false,
        elapsedMs,
        failure: gone
          ? 'The tab was closed while waiting.'
          : `The page could not be reached while waiting (it may have navigated): ${e instanceof Error ? e.message : String(e)}`,
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  // url / load: watched from here, because the navigation destroys the content script.
  return await new Promise<WaitOutcome>((resolve) => {
    let settled = false;
    const finish = (o: WaitOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      signal.removeEventListener('abort', onAbort);
      // The content script is gone after a navigation. Re-injecting here, on the way out, means
      // the model's next get_page or wait_for does not spend a failed round trip discovering that.
      // sendToContent's own fallback would recover anyway; this just makes the next step cheap.
      if (o.matched) void sendToContent(tabId, { type: 'ping' }).catch(() => {});
      resolve(o);
    };
    const elapsed = () => Date.now() - startedAt;

    const satisfied = (url: string | undefined, status: string | undefined): string | null => {
      if (c.kind === 'url') return url && urlMatches(url, c) ? `the URL is now ${url}` : null;
      // 'domcontentloaded' has no distinct tabs.onUpdated status: Chrome reports 'loading' then
      // 'complete'. 'complete' satisfies both, and for domcontentloaded a URL change with the page
      // already past loading is the closest honest signal.
      if (status === 'complete') return `the page finished loading: ${url ?? ''}`.trim();
      return null;
    };

    const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      const detail = satisfied(change.url ?? tab.url, change.status ?? tab.status);
      if (detail) finish({ matched: true, elapsedMs: elapsed(), detail });
    };
    chrome.tabs.onUpdated.addListener(onUpdated);

    const onRemoved = (id: number) => {
      if (id === tabId) finish({ matched: false, elapsedMs: elapsed(), failure: 'The tab was closed while waiting.' });
    };
    chrome.tabs.onRemoved.addListener(onRemoved);

    const onAbort = () => finish({ matched: false, elapsedMs: elapsed(), failure: 'The wait was stopped.' });
    signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(async () => {
      // The diagnostics a url/load timeout can offer: where the tab actually is now. That is what
      // separates "the SPA route never changed" from "it changed to somewhere unexpected".
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return finish({ matched: false, elapsedMs: elapsed(), failure: 'The tab was closed while waiting.' });
      finish({
        matched: false,
        elapsedMs: elapsed(),
        diagnostics: [`the tab is at ${tab.url ?? 'an unknown URL'}; tab status=${tab.status ?? 'unknown'}.`],
      });
    }, spec.timeoutMs);

    // Already true? A SPA that routed synchronously, or a page that is already loaded, must cost
    // ~0ms rather than the full timeout.
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        const detail = satisfied(tab.url, tab.status);
        if (detail) finish({ matched: true, elapsedMs: elapsed(), detail });
      })
      .catch(() => finish({ matched: false, elapsedMs: elapsed(), failure: 'The tab was closed while waiting.' }));
  });
}

/**
 * A captured tab, brought down to the size a vision model actually reads (lib/images.ts).
 *
 * captureVisibleTab hands back the viewport at the display's device pixel ratio, which on any
 * modern laptop is two or three times what the model will use: everything above MAX_EDGE is
 * downscaled by the provider on arrival, so sending it buys nothing and costs bandwidth, tokens
 * and — on a local model with a small window — the conversation itself.
 *
 * A capture that is already inside the box is still re-encoded, because the JPEG is what makes it
 * small: a PNG screenshot of a photo-heavy page is several megabytes at any resolution.
 *
 * Never throws. A worker without OffscreenCanvas, or a decode that fails, falls back to the
 * original bytes — a large screenshot is worse than a small one, and much better than a tool that
 * errors where it used to work.
 */
async function shrinkCapture(dataUrl: string): Promise<{ mediaType: 'image/jpeg' | 'image/png'; data: string }> {
  const parsed = parseDataUrl(dataUrl);
  const original: { mediaType: 'image/jpeg' | 'image/png'; data: string } = {
    mediaType: parsed?.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    data: parsed?.data ?? dataUrl.replace(/^data:image\/[a-z+]+;base64,/, ''),
  };
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return original;
    const res = await fetch(dataUrl);
    const bitmap = await createImageBitmap(await res.blob());
    try {
      const target = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);
      const canvas = new OffscreenCanvas(target.width, target.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return original;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // A page's own background can be transparent (a PDF viewer, an empty tab), and a JPEG has no
      // alpha: without this the transparent parts composite onto black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, target.width, target.height);
      ctx.drawImage(bitmap, 0, 0, target.width, target.height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: SCREENSHOT_QUALITY });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
      const data = btoa(binary);
      // A re-encode that came out bigger than what we started with (a tiny viewport, a flat page
      // that PNG compresses better than JPEG) is not worth taking.
      return data.length < original.data.length ? { mediaType: 'image/jpeg', data } : original;
    } finally {
      bitmap.close?.();
    }
  } catch {
    return original;
  }
}

function envForTab(tabId: number): AgentEnv {
  return {
    sendToContent: (req) => sendToContent(tabId, req as ContentRequest),
    runScript: (code) => executeInTab(tabId, code),
    wait: (spec, signal) => waitInTab(tabId, spec, signal),
    async screenshot() {
      const tab = await chrome.tabs.get(tabId);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: SCREENSHOT_CAPTURE_FORMAT });
      return shrinkCapture(dataUrl);
    },
    async pageInfo() {
      const tab = await chrome.tabs.get(tabId);
      return { url: tab.url ?? '', title: tab.title ?? '' };
    },
  };
}
