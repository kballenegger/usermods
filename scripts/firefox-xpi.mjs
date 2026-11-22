// Rename the Firefox artifact WXT writes — usermods-<version>-firefox.zip — to the .xpi name
// Firefox loads from disk, so the artifact people click is called what they install.
//   npm run zip:firefox
import { readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const dir = '.output';
for (const name of readdirSync(dir)) {
  if (name.endsWith('.zip') && name.includes('firefox')) {
    const target = name.replace(/\.zip$/, '.xpi');
    renameSync(join(dir, name), join(dir, target));
    console.log(`Renamed ${name} -> ${target}`);
  }
}
