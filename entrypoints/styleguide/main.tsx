// The living specimen behind docs/design.md.
//
// Every component below is drawn by the REAL stylesheets (sidepanel/styles.css, activity.css,
// dashboard/dashboard.css), so this page cannot drift from the product. It is captured into
// docs/design/*.png by `node scripts/screenshots.mjs --styleguide`, and those captures are what
// the design doc embeds — the doc shows the system rather than describing it.
//
// It is unlisted: the dashboard links to it only in a dev build or behind ?styleguide=1, so it
// ships (a specimen kept out of the bundle is a specimen kept out of date) without appearing in
// the product's navigation.
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { applyStoredTheme } from '@/lib/theme';
import './styleguide.css';

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="sg-section">
      <h2>{title}</h2>
      {note ? <p className="sg-note">{note}</p> : null}
      {children}
    </section>
  );
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="sg-row">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** A colour swatch that reads its value back out of the live CSS, so it cannot be wrong. */
function Swatch({ token, use }: { token: string; use: string }) {
  const [hex, setHex] = useState('');
  useEffect(() => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    setHex(v);
  }, [token]);
  return (
    <div className="sg-swatch">
      <div className="chipcolor" style={{ background: `var(${token})` }} />
      <div className="meta">
        <b>{token}</b>
        {hex}
        <br />
        {use}
      </div>
    </div>
  );
}

const ROLE_SWATCHES: Array<[string, string]> = [
  ['--bg-app', 'the page'],
  ['--surface-1', 'reading panel'],
  ['--surface-2', 'raised panel'],
  ['--surface-well', 'inset well: code'],
  ['--text-1', 'body copy'],
  ['--text-2', 'descriptions, help'],
  ['--text-3', 'placeholders, meta'],
  ['--primary', 'primary text/border'],
  ['--primary-fill', 'primary fill'],
  ['--live', 'live / ok'],
  ['--accent', 'accent, hero edge'],
  ['--info', 'info + focus ring'],
  ['--warn', 'warning'],
  ['--error', 'error'],
  ['--border-strong', 'panel outline'],
  ['--border-hair', 'divider inside a panel'],
];

const PROSE =
  'The container is capped at about 1600px with the sidebar reserving space on the left. ' +
  'Hiding the sidebar and lifting the cap gives the article the full window. This paragraph is ' +
  'here so the transcript can be read at length rather than glanced at: a design that is ' +
  'comfortable for one line is not necessarily comfortable for ten.';

function Guide() {
  useEffect(() => {
    void applyStoredTheme();
  }, []);

  return (
    <div className="sg">
      <header className="sg-head">
        <h1>usermods</h1>
        <p>
          The living specimen. Every component here is drawn by the stylesheets the extension ships,
          so what you see is what users get.
        </p>
      </header>

      <Section
        title="Palette — roles"
        note="Components name a ROLE, never a hue. Re-tinting the brand is a change to tokens.css alone. Each swatch reads its own value out of the live CSS."
      >
        <div className="sg-swatches">
          {ROLE_SWATCHES.map(([t, u]) => (
            <Swatch key={t} token={t} use={u} />
          ))}
        </div>
      </Section>

      <Section
        title="Typography"
        note="Three families, and which one is used is a rule. The pixel display face is for short labels only, at its single 400 weight; anything you read a sentence of is set in the UI or mono text face. The glyph-pair row below is the test a display face has to pass: it replaced Pixelify Sans, whose C was a closed O, so CHAT read as OHAT."
      >
        <Row title="Display — Jersey 10. Labels, headings, the wordmark. Never a sentence, never below 12px.">
          <div className="sg-demo col">
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-title)' }}>
              usermods
            </div>
            <div className="label">Section label · 12px</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-stat)' }}>
              3/3 · stat number
            </div>
          </div>
        </Row>
        <Row title="Display — the glyph pairs that decide the face. Every one must be told apart at a glance, at the smallest size the system uses.">
          <div className="sg-demo col">
            {(['--fs-label', '--fs-btn', '--fs-ui', '--fs-stat', '--fs-title'] as const).map((t) => (
              <div
                key={t}
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: `var(${t})`,
                  letterSpacing: 'var(--lbl-tracking)',
                }}
              >
                CO GC 0O 8B 1Il 5S EF UV aoe · CHAT ARCHIVE ONCE
              </div>
            ))}
          </div>
        </Row>
        <Row title="UI text — all prose, every long-form reading surface. Body 13px / 1.6.">
          <p style={{ margin: 0, maxWidth: '64ch', lineHeight: 1.6 }}>{PROSE}</p>
        </Row>
        <Row title="Mono — identifiers, code, anything copyable. 12px minimum.">
          <div className="sg-demo col">
            <span className="chip">*://*.wikipedia.org/wiki/*</span>
            <pre style={{ margin: 0 }}>{`const toc = document.querySelector('#vector-toc');\nif (toc) toc.style.display = 'none';`}</pre>
          </div>
        </Row>
      </Section>

      <Section
        title="Buttons"
        note="Boldness is a hierarchy, not a volume setting. One primary per screen carries the fill, the bright outline and the hard offset shadow; everything beside it is a quiet outline."
      >
        <Row title="States">
          <div className="sg-demo">
            <button className="btn primary">Save &amp; enable</button>
            <button className="btn">Run once</button>
            <button className="btn danger">Delete</button>
            <button className="btn" disabled>
              Disabled
            </button>
            <button className="btn primary" disabled>
              Primary disabled
            </button>
            <button className="linklike">a text link</button>
          </div>
        </Row>
        <Row title="Do / don't">
          <div className="sg-pair">
            <div className="sg-do">
              <p className="sg-note">One primary, the rest outlined. The eye finds the action.</p>
              <div className="sg-demo">
                <button className="btn primary">Install</button>
                <button className="btn">Cancel</button>
              </div>
            </div>
            <div className="sg-dont">
              <p className="sg-note">
                Not every button filled. Nine equal blocks is a wall, not a hierarchy — this is the
                mistake the first pass of Settings actually made.
              </p>
              <div className="sg-demo">
                <button className="btn primary">Install</button>
                <button className="btn primary">Cancel</button>
              </div>
            </div>
          </div>
        </Row>
      </Section>

      <Section
        title="Status dots and the activity line"
        note="Only alive things glow or pulse, and alive is always lime. Warn and error carry a coloured left rail as well as a colour, because yellow and lime converge under the common colour-vision deficiencies — and every error carries a word."
      >
        <Row title="Dots">
          <div className="sg-demo">
            <span>
              <span className="dot" /> ok (glows)
            </span>
            <span>
              <span className="dot running" /> running
            </span>
            <span>
              <span className="dot error" /> error
            </span>
            <span>
              <span className="dot off" /> off
            </span>
          </div>
        </Row>
        <Row title="The activity line, in all four states">
          <div className="sg-demo col">
            <div className="activity">
              <span className="dot" />
              <span className="activity-label">
                thinking · <span className="activity-mono">get_page</span>
              </span>
              <span className="activity-sep">·</span>
              <span className="activity-seg">12s</span>
              <button className="activity-action">stop</button>
            </div>
            <div className="activity">
              <span className="dot" />
              <span className="activity-label">
                running <span className="activity-mono">find_elements</span>
              </span>
            </div>
            <div className="activity warn">
              <span className="dot" />
              <span className="activity-label">still waiting on the model — 45s</span>
              <button className="activity-action">retry</button>
            </div>
            <div className="activity error">
              <span className="dot" />
              <span className="activity-label">connection lost — the request failed</span>
              <button className="activity-action">retry</button>
            </div>
          </div>
        </Row>
      </Section>

      <Section
        title="Cards"
        note="A solid surface, a 2px outline and a hard offset shadow with no blur. One hero per screen takes the accent edge."
      >
        <Row title="Card, hero card, disabled card">
          <div className="sg-demo col">
            <div className="card hero">
              <div className="label">Proposed mod</div>
              <h4>Wikipedia: full-width article</h4>
              <div className="desc">
                Hides the pinned table of contents and lets the article body use the whole window.
              </div>
              <span className="chip">*://*.wikipedia.org/wiki/*</span>
              <div className="row">
                <button className="btn">Run once</button>
                <button className="btn primary">Save &amp; enable</button>
              </div>
            </div>
            <div className="card">
              <h4>An ordinary card</h4>
              <div className="desc">The same block, without the hero's accent edge.</div>
            </div>
            <div className="card disabled">
              <h4>A card that is switched off</h4>
              <div className="desc">
                It recedes by surface and edge, never by opacity — a fade on a saturated palette
                reads as broken rather than as off.
              </div>
            </div>
          </div>
        </Row>
      </Section>

      <Section title="Chips" note="Identifiers, squared off. The accent marks a thing the user pointed at.">
        <div className="sg-demo">
          <span className="chip">v1.0.0</span>
          <span className="chip ref">div.infobox</span>
          <span className="chip warn">not tested</span>
        </div>
      </Section>

      <Section
        title="Forms and toggles"
        note="Field labels are pixel type; the help text under them is prose, so it is the UI face at 12px. The toggle's 2px border carries its boundary — full lime on white is 1.23:1, so the fill alone could not."
      >
        <div className="sg-panelframe" style={{ padding: 16, background: 'var(--surface-1)' }}>
          <label className="field">
            Context budget (tokens)
            <input defaultValue="120000" />
            <span>
              How much conversation to send the model before usermods compacts it. Lower is cheaper
              and faster; higher keeps more of the chat in front of the model.
            </span>
          </label>
          <label className="toggle">
            <input type="checkbox" defaultChecked /> Name chats automatically
          </label>
          <div style={{ height: 10 }} />
          <label className="toggle">
            <input type="checkbox" /> Off, for comparison
          </label>
        </div>
      </Section>

      <Section title="Notices" note="A notice is prose on a panel. The three semantic tones each also carry a word, never colour alone.">
        {/*
          Wrapped in .install-col because that is one of the real containers the dashboard's banner
          rules are scoped to. Specimens have to be built the way the product builds them, or the
          page stops being evidence — these three are exactly the rules whose unscoped version was
          silently inflating the status dot.
        */}
        <div className="install-col">
          <div className="notice">
            usermods needs the userScripts API. Turn on Developer mode in chrome://extensions.
          </div>
          <div className="error">Error — the script could not be fetched.</div>
          <div className="ok">Saved and enabled.</div>
        </div>
        <div className="sg-demo col" style={{ marginTop: 10 }}>
          <div className="label untested">not tested on this page · the tab was closed</div>
        </div>
      </Section>

      <Section
        title="Transcript"
        note="The longest-form reading surface in the product: flat panel, no texture, body at 13px/1.6. This is where legibility outranks everything."
      >
        <div className="sg-panelframe" style={{ background: 'var(--surface-1)', padding: 16 }}>
          <div className="messages" style={{ padding: 0 }}>
            <div className="msg user">hide the sidebar and widen the article</div>
            <div className="msg assistant">{PROSE}</div>
            <details className="tool">
              <summary>
                <span className="dot" />
                <span>get_page</span>
              </summary>
              <pre>{'{ "url": "https://en.wikipedia.org/wiki/Common_kingfisher" }'}</pre>
            </details>
            <details className="tool error">
              <summary>
                <span className="dot error" />
                <span>find_elements — failed</span>
              </summary>
              <pre>No element matches ".does-not-exist".</pre>
            </details>
            <div className="msg user queued">and make the images smaller</div>
          </div>
        </div>
      </Section>

      <Section title="Empty state" note="A screen with nothing on it is where the brand gets to be playful.">
        <div className="sg-panelframe" style={{ background: 'var(--surface-1)' }}>
          <div className="empty">No mods on this site yet. Ask for one.</div>
        </div>
      </Section>

      <Section
        title="Dashboard rows"
        note="Dense lists stay scannable: the selected edge is the primary, and an archived row recedes by surface rather than by opacity."
      >
        <div className="rows">
          <button className="rowcard selected">
            <span className="body">
              <span className="title">renamed by the dashboard</span>
              <span className="meta">en.wikipedia.org · 5m ago · 1 turn</span>
            </span>
            <span className="actions">
              <span className="pill">Open</span>
              <span className="pill">Rename</span>
            </span>
          </button>
          <button className="rowcard">
            <span className="body">
              <span className="title">dim the infobox images</span>
              <span className="meta">en.wikipedia.org · 40m ago · 1 turn</span>
            </span>
          </button>
          <button className="rowcard dimmed">
            <span className="body">
              <span className="title">an archived chat</span>
              <span className="meta">
                news.ycombinator.com · 2h ago · <span className="badge">archived</span>
              </span>
            </span>
          </button>
        </div>
      </Section>

      <Section title="Tabs" note="The active tab is a solid lime block with an ink label: the loudest thing in the bar, because which screen you are on is the bar's only real question.">
        <div className="sg-panelframe">
          <div className="tabs">
            <button className="active">Chat</button>
            <button>Mods</button>
            <button>Settings</button>
            <span className="spacer" />
            <span className="status">en.wikipedia.org</span>
          </div>
        </div>
      </Section>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Guide />
  </React.StrictMode>,
);
