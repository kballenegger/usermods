// The `skills` storage key, as lib/mods.ts holds `mods`. A skill is never registered with anything:
// it sits in storage until it is run, and lib/exec does not know it exists.
//
// Every write goes through skillFromSource first, so a record in storage came from a file previewSkill
// accepted. A test that forces a bad one in is what the run-time denials are for.
import { withKey } from './storagequeue';
import type { Skill } from './skills';

export const SKILLS_KEY = 'skills';

export async function loadSkills(): Promise<Skill[]> {
  const r = await chrome.storage.local.get(SKILLS_KEY);
  return (r[SKILLS_KEY] as Skill[] | undefined) ?? [];
}

export function upsertSkill(skill: Skill): Promise<Skill[]> {
  return withKey(SKILLS_KEY, async () => {
    const skills = await loadSkills();
    const i = skills.findIndex((s) => s.id === skill.id);
    if (i >= 0) skills[i] = skill;
    else skills.push(skill);
    await chrome.storage.local.set({ [SKILLS_KEY]: skills });
    return skills;
  });
}

/** A change to the bookkeeping of one skill, on the record as it is now. */
export function updateSkill(id: string, fn: (s: Skill) => Skill): Promise<void> {
  return withKey(SKILLS_KEY, async () => {
    const skills = await loadSkills();
    const i = skills.findIndex((s) => s.id === id);
    if (i < 0) return;
    const next = fn(skills[i]!);
    if (next === skills[i]) return;
    skills[i] = next;
    await chrome.storage.local.set({ [SKILLS_KEY]: skills });
  });
}

export function deleteSkills(ids: string[]): Promise<Skill[]> {
  return withKey(SKILLS_KEY, async () => {
    const skills = (await loadSkills()).filter((s) => !ids.includes(s.id));
    await chrome.storage.local.set({ [SKILLS_KEY]: skills });
    return skills;
  });
}
