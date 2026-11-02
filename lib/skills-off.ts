// What lib/skills.ts resolves to in a build with ACT_OFF. See the plugin in wxt.config.ts. Everything
// that calls these is behind the flag, and the bundler drops the calls, but the parser stayed in a
// chunk the pages share with nothing calling it. A build without skills should not hold it at all.
const none = () => null;

export const looksLikeSkill = () => false;
export const readSkillFacts = none;
export const parseSkill = () => ({ ok: false as const, errors: [] });
export const previewSkill = none;
export const recordedReasons = () => [];
export const stepLine = () => '';
export const setSkillFields = (source: string) => source;
export const skillFileName = () => '';
export const skillHosts = () => [];
export const skillFromSource = none;
