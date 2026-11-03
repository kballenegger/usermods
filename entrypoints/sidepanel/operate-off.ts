// What `./Operate` resolves to in a build with ACT_OFF. See the plugin in wxt.config.ts.
//
// Every use of Operate.tsx is already behind the flag, and the bundler drops the uses, but it decides
// what a chunk exports before it folds them: the components would stay in a shared chunk with nothing
// calling them. A build without acting should not hold them at all, so the file never enters it.

export const QuestionRow = () => null;
export const TouchedSteps = () => null;
export const TouchedScript = () => null;
export const PageCardRow = () => null;
export const OperatingPages = () => null;
