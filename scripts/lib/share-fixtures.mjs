// Stand-ins for the signed-in pages the share flow fills: GitHub's new-gist and edit-gist forms,
// the gist page a save lands on, and Greasy Fork's post forms. Used by the `share` smoke flow
// (scripts/screenshots.mjs routes https://gist.github.com/* and https://greasyfork.org/* here) and
// by test/sharefill.test.ts.
//
// These are RECONSTRUCTIONS, not saved copies: those pages only exist for a signed-in account, and
// no account is used in testing. They follow the real structure where it matters to the filler —
//
//   gist.github.com  the class names gist.github.com's own script binds to (github.githubassets.com
//                    gist-*.js, read 2026-09-25): form.js-blob-form, .js-gist-file,
//                    input.js-gist-filename, textarea.js-blob-contents / .js-code-textarea under a
//                    .js-code-editor, the `gist:filedrop` CustomEvent it listens for, and a
//                    CodeMirror 5 editor over the textarea (instance on `.CodeMirror`.CodeMirror,
//                    input through a hidden textarea, paste read from clipboardData, Cmd/Ctrl+A)
//   greasyfork.org   app/views/script_versions/_form.html.erb in greasyfork-org/greasyfork (main,
//                    read 2026-09-25): textarea#script_version_code, the additional-info textarea
//                    #script-version-additional-info-0, #script_version_changelog on a new version,
//                    and `<input type="submit" name="commit" value="Post script">`
//
// — and `variant` switches parts off, so every path of the filler is exercised: 'noapi' hides the
// editor instance from the page world (the isolated fallbacks run), 'unknown' is a page whose
// markup matches none of it (the clipboard fallback runs).

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page-world emulation of GitHub's gist editor, as the page's own script. */
function editorScript(variant) {
  return `
(() => {
  const variant = ${JSON.stringify(variant)};
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  function mount(fileEl) {
    const ta = fileEl.querySelector('textarea.js-blob-contents');
    const wrap = fileEl.querySelector('.CodeMirror');
    const input = wrap.querySelector('textarea');
    const code = wrap.querySelector('.CodeMirror-code');
    let value = ta.value;
    let selectedAll = false;
    const render = () => {
      code.replaceChildren(...value.split('\\n').map((l) => { const d = document.createElement('pre'); d.className = 'CodeMirror-line'; d.textContent = l || ' '; return d; }));
      ta.value = value; // GitHub keeps the form's textarea in step with the editor
      window.__gistEditorChanges = (window.__gistEditorChanges || 0) + 1;
    };
    const cm = { getValue: () => value, setValue: (v) => { value = String(v); render(); }, setCode: (v) => { value = String(v); render(); }, save: () => { ta.value = value; } };
    if (variant !== 'noapi') wrap.CodeMirror = cm;
    fileEl.__editor = cm;
    input.addEventListener('keydown', (e) => {
      if ((mac ? e.metaKey : e.ctrlKey) && (e.keyCode === 65 || e.key === 'a')) { selectedAll = true; e.preventDefault(); }
    });
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData && e.clipboardData.getData('Text');
      if (!text) return;
      e.preventDefault();
      value = selectedAll ? text : value + text;
      selectedAll = false;
      render();
    });
    input.addEventListener('input', () => { if (input.value) { value = selectedAll ? input.value : value + input.value; selectedAll = false; input.value = ''; render(); } });
    render();
  }
  document.querySelectorAll('.js-gist-file').forEach(mount);
  // gist.js: a file dropped on the form goes into the first empty slot, named, via setCode().
  document.addEventListener('gist:filedrop', (e) => {
    const form = e.target.closest('.js-blob-form');
    if (!form || !e.detail) return;
    const slot = Array.from(form.querySelectorAll('.js-gist-file')).find((f) => !f.querySelector('.js-gist-filename').value && !f.querySelector('.js-blob-contents').value);
    if (!slot) return;
    const name = slot.querySelector('.js-gist-filename');
    name.value = e.detail.file.name;
    slot.__editor.setCode(e.detail.data);
    window.__gistFiledrop = true;
  });
})();`;
}

function page(title, body, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; background: #fff; color: #1f2328; }
header { background: #f6f8fa; border-bottom: 1px solid #d1d9e0; padding: 12px 24px; font-weight: 600; }
main { max-width: 980px; margin: 24px auto; padding: 0 24px; }
input.form-control, textarea { width: 100%; box-sizing: border-box; padding: 5px 12px; border: 1px solid #d1d9e0; border-radius: 6px; font: inherit; }
.file { border: 1px solid #d1d9e0; border-radius: 6px; margin: 16px 0; }
.file-header { background: #f6f8fa; padding: 8px; border-bottom: 1px solid #d1d9e0; display: flex; gap: 8px; align-items: center; }
.CodeMirror { position: relative; min-height: 240px; font: 12px/20px ui-monospace, Menlo, monospace; padding: 8px 16px; }
.CodeMirror-line { margin: 0; white-space: pre; }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; margin: 16px 0 240px; }
.btn { padding: 5px 16px; border: 1px solid #d1d9e0; border-radius: 6px; background: #f6f8fa; font: 500 14px/20px system-ui; cursor: pointer; }
.btn-primary { background: #1f883d; color: #fff; border-color: #1a7f37; }
label { display: block; font-weight: 600; margin: 16px 0 6px; }
.blob-code { font: 12px/20px ui-monospace, Menlo, monospace; white-space: pre; }
</style></head><body><header>${esc(title.split(' · ').pop() || title)}</header><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

/**
 * The gist editor: the new-gist form at gist.github.com/, or /<user>/<id>/edit with the gist's
 * files in it. `files` is [{ name, content }]; a new gist has one empty slot.
 */
export function gistEditorPage({ mode = 'new', files = [{ name: '', content: '' }], description = '', action = '/', variant = 'default', visibility = 'secret' } = {}) {
  if (variant === 'unknown') {
    // Somebody redesigned the page: nothing the filler knows is here.
    return page('Create a new Gist', `<div class="new-editor"><div contenteditable="true" class="mystery-editor" style="min-height:200px;border:1px solid #ccc"></div><button class="btn btn-primary">Save</button></div>`);
  }
  const verb = mode === 'new' ? 'Create' : 'Update';
  const fileHtml = files
    .map(
      (f) => `<div class="js-gist-file"><div class="file js-code-editor">
  <div class="file-header"><div class="input-group gist-filename-input"><input type="text" name="gist[contents][][name]" class="form-control filename js-gist-filename js-blob-filename" placeholder="Filename including extension…" aria-label="Filename including extension…" value="${esc(f.name)}"></div></div>
  <div class="commit-create position-relative">
    <textarea name="gist[contents][][value]" class="form-control file-editor-textarea js-blob-contents js-code-textarea" hidden>${esc(f.content)}</textarea>
    <div class="CodeMirror"><div style="overflow:hidden;position:relative;width:3px;height:0"><textarea autocorrect="off" autocapitalize="off" spellcheck="false" tabindex="0" style="position:absolute;bottom:-1em;padding:0;width:1000px;height:1em;outline:none"></textarea></div><div class="CodeMirror-code" role="presentation"></div></div>
  </div></div></div>`,
    )
    .join('\n');
  const body = `<form class="js-blob-form" id="${mode === 'new' ? 'new_gist' : 'edit_gist'}" data-turbo="false" action="${esc(action)}" accept-charset="UTF-8" method="post">
  <input type="text" name="gist[description]" id="gist_description" class="form-control input-block input-contrast" placeholder="Gist description…" aria-label="Gist description" value="${esc(description)}">
  <div class="js-gist-files">${fileHtml}</div>
  <div class="form-actions">
    <button type="button" class="btn js-add-gist-file">Add file</button>
    ${
      mode === 'new'
        ? `<button type="submit" class="btn btn-primary js-gist-create" name="gist[public]" value="0">Create secret gist</button>
    <button type="submit" class="btn js-gist-create" name="gist[public]" value="1">Create public gist</button>`
        : `<button type="submit" class="btn btn-primary">${verb} ${visibility} gist</button>`
    }
  </div>
</form>`;
  return page(mode === 'new' ? 'Create a new Gist' : 'Editing gist', body, editorScript(variant));
}

/** A gist's own page after a save: one `.file` per file, each with a Raw link pinned to a revision. */
export function gistViewPage({ user, id, sha = 'a'.repeat(40), files }) {
  const body = files
    .map((f) => {
      const anchor = `file-${f.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
      const lines = f.content
        .split('\n')
        .map((l, i) => `<tr><td id="${anchor}-L${i + 1}" class="blob-num js-line-number" data-line-number="${i + 1}"></td><td class="blob-code blob-code-inner js-file-line">${esc(l)}</td></tr>`)
        .join('');
      return `<div id="${anchor}" class="file my-2"><div class="file-header"><div class="file-actions"><a href="/${user}/${id}/raw/${sha}/${encodeURIComponent(f.name)}" class="Button">Raw</a></div><div class="file-info"><strong class="gist-blob-name">${esc(f.name)}</strong></div></div><div class="Box-body blob-wrapper"><table>${lines}</table></div></div>`;
    })
    .join('\n');
  return page(`${user}/${id}`, body);
}

export function gist404Page() {
  return page('Page not found · GitHub', `<div id="parallax_wrapper"><h1>404</h1><p>This is not the web page you are looking for.</p></div>`);
}

/** Greasy Fork's post form: a new script, or (with `scriptId`) a new version of one. */
export function greasyForkFormPage({ scriptId = null } = {}) {
  const action = scriptId ? `/en/scripts/${scriptId}/versions` : '/en/script_versions';
  const body = `<p>Before posting, read the rules.</p>
<form enctype="multipart/form-data" action="${action}" accept-charset="UTF-8" method="post" id="${scriptId ? 'edit_script_version' : 'new_script_version'}">
  <div class="form-section"><div class="form-control">
    <label for="script_version_code">Code</label> <span class="label-note" style="display: none"><input type="checkbox" id="enable-source-editor-code" name="enable-source-editor-code" class="enable-source-editor" data-related-editor="script_version_code" data-editor-language="javascript"><label for="enable-source-editor-code" class="checkbox-label">Enable syntax-highlighting source editor</label></span><br>
    <textarea name="script_version[code]" id="script_version_code" rows="16"></textarea>
    <div>Or upload: <input type="file" name="code_upload" id="code-upload" accept="text/javascript,application/javascript"></div>
  </div></div>
  <div class="form-section"><div class="form-control">
    <label for="script-version-additional-info-0">Additional info</label>
    <textarea name="script_version[additional_info][0][attribute_value]" id="script-version-additional-info-0" rows="4"></textarea>
  </div>
  <div class="form-control"><button id="add-additional-info" name="add-additional-info" value="1" type="submit">Add a localized additional info</button></div></div>
  ${scriptId ? `<div class="form-section"><div class="form-control"><label for="script_version_changelog">Changelog</label><textarea name="script_version[changelog]" id="script_version_changelog" rows="5"></textarea></div></div>` : ''}
  <p><input type="submit" name="commit" value="${scriptId ? 'Post new version' : 'Post script'}" data-disable-with="${scriptId ? 'Post new version' : 'Post script'}"></p>
</form>`;
  return page(scriptId ? 'Update script · Greasy Fork' : 'Post a new script · Greasy Fork', body);
}

export function greasyForkScriptPage({ id, slug, name }) {
  return page(`${name} · Greasy Fork`, `<h2>${esc(name)}</h2><p>Script ${id}-${esc(slug)}</p>`);
}

export function greasyForkSignInPage() {
  return page('Sign in to Greasy Fork', `<form action="/en/users/sign_in" method="post"><label>Email</label><input class="form-control" name="user[email]"><input type="submit" value="Log in"></form>`);
}
