// A build with ACT_OFF must hold none of the code the flag names: "removes the code, not only the
// controls" (docs/specs/browser-use.md, section 5.9). This reads the packages themselves.
//
// Run through `npm run check:act-bundle`, which builds them first. The strings below are ones that
// exist only in flagged code. They are looked for in the test build too, the one with the flag on,
// so a string that a refactor removed fails here instead of quietly proving nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FLAGGED = [
  'usermods:bar-stop', // the bar's message, lib/pageui.ts
  'usermods:bar-done',
  'I HAVE DONE IT', // the bar itself
  'kept moving', // lib/interact/actions.ts
  'Nothing to operate here', // lib/interact/view.ts
  'one-time code', // lib/interact/describe.ts
  'find_elements to get refs', // lib/interact/delta.ts
  'Carry out steps on the page', // the act tool, lib/agent/tools.ts
  'ask_user', // wait_for's handoff, and the prompt
  '## Operating the page', // the prompt section, lib/agent/prompt.ts
  'it leaves this site', // the gate, lib/agent/gate.ts
  'act.answer', // the panel's answer, lib/drive.ts and Chat.tsx
  'Let usermods operate', // the questions, entrypoints/sidepanel/Operate.tsx
  'I have done it',
  'The page left',
  'Your turn',
  'Operating pages', // Settings
  'waiting for you', // the activity line, lib/agent/questions.ts
  'you left the tab', // lib/agent/driver.ts
  'page_card', // the events and rows
  'act_step',
  'question_done',
  'keeping a note', // lib/agent/loop.ts
  'usermods-skill', // the format, lib/skills.ts, and the banner's detection
  '.skill.md', // the file name, the Export menu
  'skill\\\\.md', // the redirect's pattern, as it sits in a built string
  'skills.list', // the RPCs, lib/skillrpc.ts
  'A skill has no network', // the preview's SENDS line
  'Install skill', // the install page's skill mode
  'You review updates to browser automations', // lib/updates.ts
  'in the notes, ', // lib/leakscan.ts
  'mod-kind', // the dashboard's kind filter
  'Skills on this site', // the Mods tab's headings
  'usermods is running', // the bar's words, lib/skillrun.ts
  'Run a skill', // the + menu and the picker, entrypoints/sidepanel/Chat.tsx
  'Save as skill', // the card, entrypoints/sidepanel/Operate.tsx
  'Did this happen', // a pending step on resume
  'Which of these change each time', // the save card
  'Steps you allowed without asking', // Settings
  'skills.saveDraft', // the draft's save
  'Made with usermods', // lib/skillcompile.ts
  'Run the rest without asking', // the walk
  'run_skill', // the transcript row, entrypoints/background.ts
  'propose_skill', // the tools and the prompt, lib/agent/tools.ts
  'open_skill',
  'You cannot write steps', // the prompt's sentence, lib/agent/prompt.ts
  'tool calls. Reply', // a bounded loop's refusal, lib/agent/loop.ts
  'repairing one broken step', // lib/skillrepair.ts
  'skills.repairApply', // the RPC
  'skills.edit',
  'Update skill with the repair', // the card, Operate.tsx
  'Repair broken steps with the model', // Settings
  'skill_proposal', // the event and the row
  'proposed skill', // the hero card, Skills.tsx
  'not available during a repair', // lib/agent/driver.ts
];

function bundleText(dir) {
  const full = path.join(ROOT, '.output', dir);
  if (!fs.existsSync(path.join(full, 'manifest.json'))) throw new Error(`${dir} has not been built`);
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html|json|css)$/.test(e.name)) out.push([path.relative(full, p), fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(full);
  return out;
}

let failed = 0;
const on = bundleText('test-chrome-mv3');
for (const s of FLAGGED) {
  if (!on.some(([, text]) => text.includes(s))) {
    console.error(`[act-bundle] "${s}" is not in the flag-on build, so finding it absent elsewhere would prove nothing`);
    failed++;
  }
}
for (const dir of ['store-chrome-mv3', 'safari-mv3', 'store-safari-mv3']) {
  const files = bundleText(dir);
  for (const s of FLAGGED) {
    for (const [file, text] of files) {
      if (text.includes(s)) {
        console.error(`[act-bundle] ${dir}/${file} holds "${s}"`);
        failed++;
      }
    }
  }
  const content = files.find(([f]) => f.endsWith('content-scripts/content.js'));
  console.log(`[act-bundle] ${dir}: ${files.length} files, content script ${content ? content[1].length : '?'} bytes`);
}
if (failed) {
  console.error(`[act-bundle] ${failed} problem(s)`);
  process.exit(1);
}
console.log(`[act-bundle] ok: none of ${FLAGGED.length} flagged strings in the three flag-off builds`);
