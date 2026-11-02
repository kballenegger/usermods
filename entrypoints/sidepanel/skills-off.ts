// What `./Skills` resolves to in a build with ACT_OFF. See the plugin in wxt.config.ts, and the note in
// operate-off.ts: every use is behind the flag already, and this keeps the components out of the chunks.
import type { Skill } from '@/lib/skills';

export const SkillPreviewCard = (_props: unknown) => null;
export const SkillCard = (_props: unknown) => null;
export const SkillRunCard = (_props: unknown) => null;
export const SaveSkillCard = (_props: unknown) => null;
export const SkillPicker = (_props: unknown) => null;
export const DraftSteps = (_props: unknown) => null;
export const SkillProposalRow = (_props: unknown) => null;
export const RepairCard = (_props: unknown) => null;
export const SkillsPanes = (_props: unknown) => null;
export const useSkillList = (): Skill[] => [];
export const useSkillShare = (_opts: unknown) => ({ items: () => [], prompt: null, notices: null });
export const skillsHere = (_skills: Skill[], _url: string) => ({ here: [] as Skill[], elsewhere: [] as Skill[] });
