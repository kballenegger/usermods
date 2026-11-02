// The background's skills.* requests. What a page or a stranger's file can do is decided here and in
// lib/skills.ts, not in the panel: every path to storage parses the text again and refuses what the
// preview refuses. Run is not here: it comes with the runner.
import { ACT_OFF } from './buildflags';
import { skillInstallState } from './banner';
import { previewSkill, readSkillFacts, skillFromSource, type Skill, type SkillOrigin, type SkillPreview } from './skills';
import { deleteSkills, loadSkills, upsertSkill } from './skillstore';
import { fetchText } from './install';

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
  | { type: 'skills.update'; id: string };

export interface SkillsRpcResults {
  'skills.list': Skill[];
  'skills.save': Skill[];
  'skills.delete': Skill[];
  'skills.preview': SkillPreview;
  'skills.install': Skill[];
  'skills.findInstalled': { skillId: string; version: string; newer: boolean } | null;
  'skills.update': { version: string; available?: string };
}

export interface SkillRpcDeps {
  /** One skill, forced, as the row's Update asks of the update controller. */
  checkNow(id: string): Promise<{ available?: string; error?: string } | undefined>;
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
  }
}
