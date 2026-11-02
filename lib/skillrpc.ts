// The background's skills.* requests. What a page or a stranger's file can do is decided here and in
// lib/skills.ts, not in the panel: every path to storage parses the text again and refuses what the
// preview refuses. The run itself is the background's, which owns the sessions; it arrives as a dep.
import { ACT_OFF } from './buildflags';
import { skillInstallState } from './banner';
import { previewSkill, readSkillFacts, skillFromSource, type Skill, type SkillOrigin, type SkillPreview } from './skills';
import { removeAllowance, saveDraft, type DraftResult } from './skillcontroller';
import type { SaveCard, SaveDecisions } from './skillcompile';
import { deleteSkills, loadSkills, upsertSkill } from './skillstore';
import { fetchText } from './install';
import type { Artifact } from './artifact';

export type SkillsRpc =
  | { type: 'skills.list' }
  /** A hand edit, or Make it an input: the file is parsed again, and it is `edited` from now on. */
  | { type: 'skills.save'; id: string; source: string }
  | { type: 'skills.delete'; ids: string[] }
  | { type: 'skills.preview'; url: string }
  | { type: 'skills.preview'; source: string }
  /** Install from text the preview showed. `replaceId` updates an installed copy in place. */
  | { type: 'skills.install'; source: string; downloadUrl?: string; origin: Extract<SkillOrigin, 'installed' | 'imported'>; replaceId?: string }
  /** Is this file already installed, by download URL or namespace + name? The install page asks. */
  | { type: 'skills.findInstalled'; source: string; url: string }
  /** The Update button: check now. It never installs; the review screen does that. */
  | { type: 'skills.update'; id: string }
  /** RUN on the run card. `allowSite` when the card asked "operate this site?" too. With `draft`, the chat's draft. */
  | { type: 'skills.run'; chatId: string; tabId: number; skillId?: string; draft?: boolean; inputs: Record<string, string>; allowSite?: boolean; standing?: boolean }
  /** What the run card has to know before it can say what it asks. */
  | { type: 'skills.runInfo'; chatId?: string; host: string }
  /** SAVE AS SKILL: what the card asks about this run. */
  | { type: 'skills.saveCard'; chatId: string; run: string; title?: string }
  /** The card's answers, compiled into the chat's draft. `replace` says yes to losing a draft mod. */
  | { type: 'skills.draft'; chatId: string; run: string; decisions: SaveDecisions; replace?: boolean }
  /** SAVE on the draft: a skill made here. */
  | { type: 'skills.saveDraft'; chatId: string }
  /** Settings: stop allowing one step of one skill without asking. */
  | { type: 'skills.allowance-remove'; id: string; action: string };

export interface SkillsRpcResults {
  'skills.list': Skill[];
  'skills.save': Skill[];
  'skills.delete': Skill[];
  'skills.preview': SkillPreview;
  'skills.install': Skill[];
  'skills.findInstalled': { skillId: string; version: string; newer: boolean } | null;
  'skills.update': { version: string; available?: string };
  'skills.run': { ok: true };
  'skills.runInfo': { siteAllowed: boolean };
  'skills.saveCard': SaveCard;
  'skills.draft': DraftResult;
  'skills.saveDraft': { artifact: Artifact; skill: Skill };
  'skills.allowance-remove': Skill[];
}

export interface SkillRpcDeps {
  /** One skill, forced, as the row's Update asks of the update controller. */
  checkNow(id: string): Promise<{ available?: string; error?: string } | undefined>;
  run(req: Extract<SkillsRpc, { type: 'skills.run' }>): Promise<void>;
  siteAllowed(chatId: string | undefined, host: string): Promise<boolean>;
  saveCard(req: Extract<SkillsRpc, { type: 'skills.saveCard' }>): Promise<SaveCard>;
  draft(req: Extract<SkillsRpc, { type: 'skills.draft' }>): Promise<DraftResult>;
}

export async function handleSkillsRpc(req: SkillsRpc, deps: SkillRpcDeps): Promise<unknown> {
  if (ACT_OFF) throw new Error('Skills are not in this build.');
  switch (req.type) {
    case 'skills.list':
      return loadSkills();
    case 'skills.save': {
      const existing = (await loadSkills()).find((s) => s.id === req.id);
      if (!existing) throw new Error('That skill no longer exists.');
      return upsertSkill(skillFromSource(req.source, { existing, origin: 'edited' }));
    }
    case 'skills.delete':
      return deleteSkills(req.ids);
    case 'skills.preview':
      return 'url' in req ? previewSkill(await fetchText(req.url), req.url) : previewSkill(req.source);
    case 'skills.install': {
      const existing = req.replaceId ? (await loadSkills()).find((s) => s.id === req.replaceId) : undefined;
      if (req.replaceId && !existing) throw new Error('The installed copy of this skill is gone. Install it again.');
      return upsertSkill(skillFromSource(req.source, { origin: req.origin, ...(existing ? { existing } : {}), ...(req.downloadUrl ? { downloadUrl: req.downloadUrl } : {}) }));
    }
    case 'skills.findInstalled': {
      const f = readSkillFacts(req.source);
      const st = skillInstallState({ name: f?.name ?? '', namespace: f?.namespace ?? '', version: f?.version ?? '', installUrl: req.url, ...(f?.downloadUrl ? { downloadUrl: f.downloadUrl } : {}), skill: true }, await loadSkills());
      return st.kind === 'install' ? null : { skillId: st.modId, version: st.kind === 'update' ? st.from : st.version, newer: st.kind === 'update' };
    }
    case 'skills.update': {
      const skill = (await loadSkills()).find((s) => s.id === req.id);
      if (!skill) throw new Error('That skill no longer exists.');
      const sum = await deps.checkNow(req.id);
      if (sum?.error && !sum.available) throw new Error(`Could not check “${skill.name}” for updates: ${sum.error}.`);
      return { version: skill.version, ...(sum?.available ? { available: sum.available } : {}) };
    }
    case 'skills.run':
      await deps.run(req);
      return { ok: true };
    case 'skills.runInfo':
      return { siteAllowed: await deps.siteAllowed(req.chatId, req.host) };
    case 'skills.saveCard':
      return deps.saveCard(req);
    case 'skills.draft':
      return deps.draft(req);
    case 'skills.saveDraft':
      return saveDraft(req.chatId);
    case 'skills.allowance-remove':
      await removeAllowance(req.id, req.action);
      return loadSkills();
  }
}
