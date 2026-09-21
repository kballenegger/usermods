// The first-run data notice. Shown over the whole panel before the first message is ever sent, and
// again from Settings → "Review data notice". Plain words, no dark patterns: the only way past it
// is the button that says the user understands.
import { SUBSCRIPTIONS_OFF } from '@/lib/buildflags';
import { acceptConsent } from '@/lib/consent';
import { useShell } from './shell';

export function Consent({ onAccept, onDismiss }: { onAccept: () => void; onDismiss?: () => void }) {
  // The notice has to point at where the provider is actually named, and the compact (iPhone,
  // iPad) shell names it in the top bar rather than under the message box.
  const modelWhere = useShell().compact ? 'at the top of the chat' : 'under the message box';
  async function accept() {
    await acceptConsent().catch(() => {});
    onAccept();
  }

  return (
    <div className="view view-form stack">
      <div>
        <div className="label">Before your first message</div>
        <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 'var(--fs-meta)' }}>
          To change a page, usermods has to show the model what is on it. Here is exactly what that means.
        </p>
      </div>

      <div className="card">
        <h4>What gets sent</h4>
        <ul className="steps" style={{ color: 'var(--text-1)' }}>
          <li>Your messages, and the address and title of the page you are on.</li>
          <li>A pruned copy of the page's HTML: text and structure, with scripts and styles stripped out.</li>
          <li>Details of elements you point at, or that the model looks up by selector.</li>
          <li>A screenshot of the visible part of the tab, but only when the model asks for one.</li>
        </ul>
        <span className="muted" style={{ fontSize: 'var(--fs-meta)' }}>
          If the page holds something private — a mailbox, a bank page, a medical record — that content goes to the
          model along with everything else. Close the panel on pages you would rather not share.
        </span>
      </div>

      <div className="card">
        <h4>Where it goes</h4>
        <p style={{ margin: 0 }}>
          To the model provider <b>you</b> connect in Settings and pick for that chat, and nowhere else. That is your
          own API key at Anthropic, OpenAI, OpenRouter or any compatible service
          {SUBSCRIPTIONS_OFF ? '' : ', your ChatGPT or SuperGrok subscription'}, or a model running on your own machine.
          With more than one connected, each message goes only to the one named {modelWhere}.
        </p>
        <span className="muted" style={{ fontSize: 'var(--fs-meta)' }}>
          Nothing is sent to the author of usermods. There is no usermods account, no usermods server, and no
          analytics or telemetry of any kind.
        </span>
      </div>

      <div className="card">
        <h4>What stays here</h4>
        <p style={{ margin: 0 }}>
          Your API keys{SUBSCRIPTIONS_OFF ? '' : ' and subscription tokens'}, your saved mods, their stored values and your
          chat history all live in this extension's local storage on this device. Each credential is sent only to the
          provider it belongs to, to authenticate you.
        </p>
      </div>

      <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-meta)' }}>
        usermods is open source and MIT licensed, so you can read all of this in the code.
      </p>

      <div className="row">
        <button className="btn primary" onClick={() => void accept()}>I understand</button>
        {onDismiss && (
          <button className="btn" onClick={onDismiss}>Close</button>
        )}
      </div>
    </div>
  );
}
