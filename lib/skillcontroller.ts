// The background's half of making a skill: the journal in storage, the SAVE AS SKILL card, the draft,
// the save, and the bookkeeping that decides what a skill may hold. lib/skillcompile.ts and lib/skillrun.ts
// are the logic and have no chrome.* in them.
//
// Everything here is reached through `!ACT_OFF` in entrypoints/background.ts.

import { addVersion, createArtifact, currentVersion, loadArtifact, saveArtifact, type Artifact } from './artifact';
import { journalKey, loadMessages, setChatArtifact } from './chats';
import { MAX_JOURNAL, compileRecording, recordingOf, saveCardFor, valueIn, type JournalEntry, type SaveCard, type SaveDecisions } from './skillcompile';
import { holdsAllowances, stepsKey, type RunCarry } from './skillrun';
import { parseSkill, previewSkill, skillFromSource, type Skill } from './skills';
import { loadSkills, updateSkill, upsertSkill } from './skillstore';
import { withKey } from './storagequeue';
import type { NewJournalEntry } from './agent/driver';

async function loadJournal(chatId: string): Promise<JournalEntry[]> {
  const key = journalKey(chatId);
  return ((await chrome.storage.local.get(key))[key] as JournalEntry[] | undefined) ?? [];
}

/** One more thing a run did. Entries are numbered here, so two writers cannot share a number. */
export function appendJournal(chatId: string, entry: NewJournalEntry): Promise<void> {
  const key = journalKey(chatId);
  return withKey(key, async () => {
    const list = await loadJournal(chatId);
    list.push({ ...entry, n: (list.at(-1)?.n ?? 0) + 1 } as JournalEntry);
    await chrome.storage.local.set({ [key]: list.slice(-MAX_JOURNAL) });
  });
}

/** What the SAVE AS SKILL card asks about. The values are read from the saved conversation, here and nowhere else. */
export async function saveCard(chatId: string, run: string, title?: string): Promise<SaveCard> {
  const recording = recordingOf(await loadJournal(chatId), run);
  if (!recording.length) throw new Error('That run is no longer in this chat’s record.');
  const messages = await loadMessages(chatId);
  return saveCardFor(recording, run, (toolId, stepIndex) => valueIn(messages, toolId, stepIndex), title ? { title } : {});
}

const isSkillDraft = (a: Artifact | null) => a?.kind === 'skill';

export type DraftResult = { ok: true; artifact: Artifact } | { ok: false; errors: string[] } | { replaces: string };

/**
 * The card's answers become the chat's draft. A chat holds one draft, so a mod's is replaced only after
 * asking, as open_mod does. A skill's draft gets a new version.
 */
export async function draftFromRun(chatId: string, run: string, decisions: SaveDecisions, opts: { replace?: boolean; today: string }): Promise<DraftResult> {
  const existing = await loadArtifact(chatId);
  if (existing && !isSkillDraft(existing) && !opts.replace) return { replaces: existing.name };
  const recording = recordingOf(await loadJournal(chatId), run);
  const messages = await loadMessages(chatId);
  const compiled = compileRecording(recording, decisions, { today: opts.today, valueOf: (toolId, stepIndex) => valueIn(messages, toolId, stepIndex) });
  if (!compiled.ok) return compiled;
  // The card's own answers can make a file the preview refuses: a name with a space in an input's.
  const preview = previewSkill(compiled.source);
  if (!preview.ok) return { ok: false, errors: preview.refusals.map((r) => r.message) };
  const version = { code: compiled.source, name: compiled.skill.name, description: compiled.skill.description, matches: compiled.skill.matches, source: 'proposal' as const };
  const artifact: Artifact = existing && isSkillDraft(existing) ? addVersion(existing, version) : { ...createArtifact(chatId, version), kind: 'skill' };
  await saveArtifact(artifact);
  await setChatArtifact(chatId, artifact.id, artifact.versions.length);
  return { ok: true, artifact };
}

/** SAVE on a draft skill: made here, from its own journal, so it is `local`, and walked. */
export async function saveDraft(chatId: string): Promise<{ artifact: Artifact; skill: Skill }> {
  const artifact = await loadArtifact(chatId);
  const v = artifact && isSkillDraft(artifact) ? currentVersion(artifact) : undefined;
  if (!artifact || !v) throw new Error('This chat has no draft skill.');
  const existing = artifact.linkedSkillId ? (await loadSkills()).find((s) => s.id === artifact.linkedSkillId) : undefined;
  // Saving the same steps again, under a new name, is not an edit of what the skill does.
  const parsed = parseSkill(v.code);
  const sameSteps = !!existing && parsed.ok && stepsKey(parsed.skill.steps) === stepsKey(existing.steps);
  const skill = skillFromSource(v.code, { origin: 'local', ...(existing ? { existing, keepTrust: sameSteps } : {}) });
  await upsertSkill(skill);
  const next: Artifact = { ...artifact, linkedSkillId: skill.id, savedVersion: artifact.current };
  await saveArtifact(next);
  return { artifact: next, skill };
}

/** A draft as a record to run, which goes nowhere: it holds no allowance and has nothing to walk. */
export async function draftAsSkill(chatId: string): Promise<Skill> {
  const artifact = await loadArtifact(chatId);
  const v = artifact && isSkillDraft(artifact) ? currentVersion(artifact) : undefined;
  if (!v) throw new Error('This chat has no draft skill.');
  return { ...skillFromSource(v.code, { origin: 'edited', id: `draft:${chatId}` }), walked: true };
}

/** One complete first run: only for the same steps it was walked on. */
export function markWalked(id: string, key: string): Promise<void> {
  return updateSkill(id, (s) => (stepsKey(s.steps) === key ? { ...s, walked: true } : s));
}

/** Do not ask again for this step. Holds only for what was made here, and the store says so too. */
export function keepAllowance(id: string, action: string): Promise<void> {
  return updateSkill(id, (s) => (holdsAllowances(s) && !s.allowedSteps.includes(action) ? { ...s, allowedSteps: [...s.allowedSteps, action] } : s));
}

export function removeAllowance(id: string, action: string): Promise<void> {
  return updateSkill(id, (s) => ({ ...s, allowedSteps: s.allowedSteps.filter((a) => a !== action) }));
}

// ---------------------------------------------------------------------------
// What a run holds, for as long as it runs
// ---------------------------------------------------------------------------

const carryKey = (chatId: string) => `skillrun:${chatId}`;

/** In storage.session: memory, so a worker that dies can resume, and nothing typed reaches the disk. */
export function saveCarry(chatId: string, carry: RunCarry): Promise<void> {
  return chrome.storage.session.set({ [carryKey(chatId)]: carry });
}

export async function loadCarry(chatId: string): Promise<RunCarry> {
  const key = carryKey(chatId);
  const raw = (await chrome.storage.session.get(key).catch(() => ({}) as Record<string, unknown>))[key] as RunCarry | undefined;
  return { inputs: raw?.inputs ?? {}, outputs: raw?.outputs ?? {} };
}

export function dropCarry(chatId: string): Promise<void> {
  return chrome.storage.session.remove(carryKey(chatId)).catch(() => {});
}

