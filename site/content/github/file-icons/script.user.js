// ==UserScript==
// @name         Show file type icons on GitHub
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Replaces the plain file icon in GitHub's file lists with a colored badge for the file type (JS, TS, PY, MD and so on).
// @match        https://github.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/github/file-icons.user.js
// @updateURL    https://usermods.kennethballenegger.com/github/file-icons.user.js
// ==/UserScript==

// Each file type gets a small rounded badge with a short label, drawn as an inline SVG
// data URL, so nothing is downloaded. The script only tags GitHub's own file icon with
// the type (data-usermods-ext); the CSS below paints the badge over it. It never adds or
// removes elements, so GitHub's React views keep working.

// type: [label, background, text color]
const TYPES = {
  js: ['JS', '#f1e05a', '#000'], ts: ['TS', '#3178c6', '#fff'], jsx: ['JSX', '#087ea4', '#fff'],
  tsx: ['TSX', '#087ea4', '#fff'], json: ['{}', '#cb8a00', '#fff'], md: ['MD', '#083fa1', '#fff'],
  py: ['PY', '#3572a5', '#fff'], rb: ['RB', '#701516', '#fff'], go: ['GO', '#00add8', '#fff'],
  rs: ['RS', '#b7410e', '#fff'], c: ['C', '#555555', '#fff'], h: ['H', '#6e5494', '#fff'],
  cpp: ['C++', '#f34b7d', '#fff'], java: ['JV', '#b07219', '#fff'], kt: ['KT', '#7f52ff', '#fff'],
  swift: ['SW', '#f05138', '#fff'], php: ['PHP', '#4f5d95', '#fff'], cs: ['C#', '#178600', '#fff'],
  html: ['<>', '#e34c26', '#fff'], css: ['CSS', '#563d7c', '#fff'], scss: ['SC', '#c6538c', '#fff'],
  sh: ['SH', '#4eaa25', '#fff'], yml: ['YML', '#cb171e', '#fff'], toml: ['TML', '#9c4221', '#fff'],
  xml: ['XML', '#0060ac', '#fff'], svg: ['SVG', '#ff9a00', '#000'], img: ['IMG', '#a074c4', '#fff'],
  lock: ['LCK', '#6e7781', '#fff'], txt: ['TXT', '#6e7781', '#fff'], sql: ['SQL', '#e38c00', '#fff'],
  vue: ['VUE', '#41b883', '#fff'], lua: ['LUA', '#000080', '#fff'], dart: ['DT', '#00b4ab', '#fff'],
  zig: ['ZIG', '#ec915c', '#000'], ex: ['EX', '#6e4a7e', '#fff'], docker: ['DKR', '#2496ed', '#fff'],
  make: ['MK', '#427819', '#fff'], license: ['LIC', '#d4a72c', '#000'], git: ['GIT', '#f05032', '#fff'],
  npm: ['NPM', '#cb3837', '#fff'], config: ['CFG', '#6e7781', '#fff'],
};

const EXTENSIONS = {
  mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts', yaml: 'yml', cc: 'cpp', cxx: 'cpp', hpp: 'h', hh: 'h',
  htm: 'html', bash: 'sh', zsh: 'sh', kts: 'kt', exs: 'ex', markdown: 'md', mdx: 'md',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', ico: 'img', avif: 'img',
};

// Whole file names that say more than their extension.
const NAMES = {
  dockerfile: 'docker', makefile: 'make', gnumakefile: 'make', license: 'license', copying: 'license',
  'license.md': 'license', 'license.txt': 'license', '.gitignore': 'git', '.gitattributes': 'git',
  '.gitmodules': 'git', '.mailmap': 'git', 'package.json': 'npm', 'package-lock.json': 'npm',
  '.npmrc': 'npm', '.editorconfig': 'config', 'yarn.lock': 'lock', 'pnpm-lock.yaml': 'lock',
};

function typeOf(name) {
  const lower = name.toLowerCase();
  if (NAMES[lower]) return NAMES[lower];
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = lower.slice(dot + 1);
  if (TYPES[ext]) return ext;
  return EXTENSIONS[ext] || null;
}

function badge([label, bg, fg]) {
  const size = label.length > 2 ? 6.5 : label.length === 2 ? 8.5 : 10;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<rect width="16" height="16" rx="3" fill="${bg}"/>` +
    `<text x="8" y="8.5" fill="${fg}" font-family="Arial,Helvetica,sans-serif" font-weight="700" ` +
    `font-size="${size}" text-anchor="middle" dominant-baseline="middle">${label.replace('<', '&lt;').replace('>', '&gt;')}</text></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

let css = 'svg.octicon-file[data-usermods-ext] > * { display: none; }\n' +
  'svg.octicon-file[data-usermods-ext] { background: no-repeat center / 16px 16px; }\n';
for (const [type, spec] of Object.entries(TYPES)) {
  css += `svg.octicon-file[data-usermods-ext="${type}"] { background-image: ${badge(spec)}; }\n`;
}
GM_addStyle(css);

// File list rows (repository and folder pages) and the file tree beside the code view.
function nameFor(icon) {
  const row = icon.closest('tr.react-directory-row, li[role="treeitem"]');
  if (!row) return null;
  if (row.matches('tr')) return row.querySelector('a[title]')?.getAttribute('title') || null;
  return row.querySelector('[id$="-item-text"], .PRIVATE_TreeView-item-content-text')?.textContent.trim() || null;
}

function tagIcons() {
  for (const icon of document.querySelectorAll('svg.octicon-file')) {
    const name = nameFor(icon);
    const type = name ? typeOf(name) : null;
    if (type) {
      if (icon.getAttribute('data-usermods-ext') !== type) icon.setAttribute('data-usermods-ext', type);
    } else if (icon.hasAttribute('data-usermods-ext')) {
      icon.removeAttribute('data-usermods-ext');
    }
  }
}

// Folder pages load in place, so the icons are tagged again whenever the page changes.
let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; tagIcons(); });
}).observe(document, { childList: true, subtree: true });
