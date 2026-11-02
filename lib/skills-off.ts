// What lib/skills.ts resolves to in a build with ACT_OFF. See the plugin in wxt.config.ts. Everything
// that calls these is behind the flag, and the bundler drops the calls, but the parser stayed in a
// chunk the pages share with nothing calling it. A build without skills should not hold it at all.
const none = () => null;

export const looksLikeSkill = () => false;
export const isInputRef = () => false;
export const readSkillFacts = none;
export const parseSkill = () => ({ ok: false as const, errors: [] });
export const previewSkill = none;
export const recordedReasons = () => [];
export const stepLine = () => '';
export const setSkillFields = (source: string) => source;
export const skillFileName = () => '';
export const skillHosts = () => [];
export const skillStepWords = () => '';
export const addressedHosts = () => [];
export const pinAddress = () => '';
export const skillFromSource = none;
export const skillMatchesUrl = () => false;
export const serialiseSkill = () => '';
export const isHistoryGo = () => false;
export const parseTarget = none;
export const resolveGo = none;
export const summariseSteps = () => '';
export const atStart = () => false;
export const skillForModel = () => '';
export const skillsBlock = () => '';
