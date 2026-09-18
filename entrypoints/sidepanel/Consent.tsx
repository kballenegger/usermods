// The first-run data notice. Shown over the whole panel before the first message is ever sent, and
// again from Settings → "Review data notice". Plain words, no dark patterns: the only way past it
// is the button that says the user understands.
import { STORE_BUILD } from '@/lib/buildflags';
import { acceptConsent } from '@/lib/consent';

export function Consent({ onAccept, onDismiss }: { onAccept: () => void; onDismiss?: () => void }) {
  async function accept() {
    await acceptConsent().catch(() => {});
    onAccept();
  }

  return (
    <div className="view">
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Before your first message</h3>
      <p style={{ marginTop: 0 }}>
        To change a page, usermods has to show the model what is on it. Here is exactly what that means.
      </p>

      <div className="card" style={{ marginBottom: 10 }}>
        <h4>What gets sent</h4>
        <ul className="steps" style={{ color: 'inherit' }}>
          <li>Your messages, and the address and title of the page you are on.</li>
          <li>A pruned copy of the page's HTML: text and structure, with scripts and styles stripped out.</li>
          <li>Details of elements you point at, or that the model looks up by selector.</li>
          <li>A screenshot of the visible part of the tab, but only when the model asks for one.</li>
        </ul>
        <span className="muted">
          If the page holds something private — a mailbox, a bank page, a medical record — that content goes to the
          model along with everything else. Close the panel on pages you would rather not share.
        </span>
      </div>

      <div className="card" style={{ marginBottom: 10 }}>
        <h4>Where it goes</h4>
        <p style={{ margin: 0 }}>
          To the model endpoint <b>you</b> configure in Settings, and nowhere else. That is your own API key at
          Anthropic, OpenAI, OpenRouter or any compatible service
          {STORE_BUILD ? '' : ', your ChatGPT or SuperGrok subscription'}, or a model running on your own machine.
        </p>
        <span className="muted">
          Nothing is sent to the author of usermods. There is no usermods account, no usermods server, and no
          analytics or telemetry of any kind.
        </span>
      </div>

      <div className="card" style={{ marginBottom: 10 }}>
        <h4>What stays here</h4>
        <p style={{ margin: 0 }}>
          Your API keys{STORE_BUILD ? '' : ' and subscription tokens'}, your saved mods, their stored values and your
          chat history all live in this extension's local storage on this device. Credentials are sent only to the
          endpoint they belong to, to authenticate you.
        </p>
      </div>

      <p className="muted">
        usermods is open source and MIT licensed, so you can read all of this in the code.
      </p>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={() => void accept()}>I understand</button>
        {onDismiss && (
          <button className="btn" onClick={onDismiss}>Close</button>
        )}
      </div>
    </div>
  );
}
