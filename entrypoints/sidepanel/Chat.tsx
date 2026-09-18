import { useEffect, useRef, useState } from 'react';
import { modFromProposal } from '@/lib/mods';
import { rpc, type AgentPortRequest } from '@/lib/rpc';
import type { AgentEvent, ContentEvent, ModProposal, PickedElement } from '@/lib/types';

type Item =
  | { kind: 'user'; text: string; picked?: PickedElement }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; summary?: string; isError?: boolean }
  | { kind: 'proposal'; proposal: ModProposal; saved?: boolean }
  | { kind: 'error'; text: string };

export function Chat({ tabId, pageUrl }: { tabId: number | null; pageUrl: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [picking, setPicking] = useState(false);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [hasHistory, setHasHistory] = useState(false);

  useEffect(() => {
    if (tabId == null) return;
    rpc({ type: 'chat.hasHistory', tabId }).then(setHasHistory).catch(() => {});
  }, [tabId]);

  useEffect(() => {
    const onMsg = (msg: ContentEvent) => {
      if (msg?.type === 'picked') {
        setPicked(msg.element);
        setPicking(false);
      } else if (msg?.type === 'pick-cancelled') setPicking(false);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [items]);

  function connect(): chrome.runtime.Port {
    if (portRef.current) return portRef.current;
    const port = chrome.runtime.connect({ name: 'agent' });
    port.onMessage.addListener((e: AgentEvent) => {
      setItems((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        switch (e.type) {
          case 'text':
            if (last?.kind === 'assistant') next[next.length - 1] = { ...last, text: last.text + e.delta };
            else next.push({ kind: 'assistant', text: e.delta });
            return next;
          case 'tool_call':
            next.push({ kind: 'tool', id: e.id, name: e.name, input: e.input });
            return next;
          case 'tool_result': {
            const i = next.findIndex((x) => x.kind === 'tool' && x.id === e.id);
            if (i >= 0) next[i] = { ...(next[i] as Extract<Item, { kind: 'tool' }>), summary: e.summary, isError: e.isError };
            return next;
          }
          case 'proposal':
            next.push({ kind: 'proposal', proposal: e.proposal });
            return next;
          case 'error':
            next.push({ kind: 'error', text: e.message });
            return next;
          case 'done':
            return next;
        }
      });
      if (e.type === 'done' || e.type === 'error') {
        setBusy(false);
        setHasHistory(true);
      }
    });
    port.onDisconnect.addListener(() => {
      portRef.current = null;
      setBusy(false);
    });
    portRef.current = port;
    return port;
  }

  function send() {
    const t = text.trim();
    if (!t || busy || tabId == null) return;
    setItems((prev) => [...prev, { kind: 'user', text: t, picked: picked ?? undefined }]);
    setText('');
    setBusy(true);
    const req: AgentPortRequest = { type: 'send', tabId, text: t, picked: picked ?? undefined };
    setPicked(null);
    connect().postMessage(req);
  }

  function abort() {
    portRef.current?.postMessage({ type: 'abort' } satisfies AgentPortRequest);
  }

  async function pick() {
    if (tabId == null) return;
    setPicking(true);
    try {
      await rpc({ type: 'page.pick', tabId });
    } catch (e) {
      setPicking(false);
      setItems((prev) => [...prev, { kind: 'error', text: `Could not start the picker: ${e instanceof Error ? e.message : String(e)}` }]);
    }
  }

  async function reset() {
    if (tabId == null) return;
    abort();
    await rpc({ type: 'chat.reset', tabId });
    setItems([]);
    setHasHistory(false);
  }

  async function tryProposal(p: ModProposal) {
    if (tabId == null) return;
    const r = await rpc({ type: 'mods.try', tabId, code: p.code });
    setItems((prev) => [...prev, { kind: 'tool', id: crypto.randomUUID(), name: 'try', input: { description: 'Ran the proposed mod once' }, summary: r.ok ? `OK${r.logs.length ? ': ' + r.logs.join(' | ') : ''}` : r.error, isError: !r.ok }]);
  }

  async function saveProposal(p: ModProposal, idx: number) {
    await rpc({ type: 'mods.save', mod: modFromProposal(p) });
    setItems((prev) => prev.map((it, i) => (i === idx && it.kind === 'proposal' ? { ...it, saved: true } : it)));
  }

  const unsupported = !pageUrl || /^(chrome|edge|about|chrome-extension|devtools):/.test(pageUrl);

  return (
    <div className="chat">
      <div className="messages">
        {items.length === 0 && (
          <div className="empty">
            {unsupported ? (
              <>Open a regular web page to start.</>
            ) : (
              <>
                Describe how you want this page to change.
                <br />
                <span className="muted">e.g. "hide the sidebar", "make the font bigger", "add a button that copies the title"</span>
                {hasHistory && (
                  <>
                    <br />
                    <br />
                    <span className="muted">This tab has an earlier conversation. The model remembers it.</span>
                  </>
                )}
              </>
            )}
          </div>
        )}
        {items.map((it, i) => {
          switch (it.kind) {
            case 'user':
              return (
                <div key={i} className="msg user">
                  {it.picked && <div className="chip" title={it.picked.selector}>⌖ {it.picked.selector}</div>}
                  {it.text}
                </div>
              );
            case 'assistant':
              return <div key={i} className="msg assistant">{it.text}</div>;
            case 'tool':
              return (
                <details key={i} className={`tool${it.isError ? ' error' : ''}`}>
                  <summary>
                    {it.summary === undefined ? '⏳ ' : it.isError ? '✗ ' : '✓ '}
                    {it.name}
                    {typeof it.input.description === 'string' ? `: ${it.input.description}` : typeof it.input.selector === 'string' ? ` ${it.input.selector}` : ''}
                  </summary>
                  {typeof it.input.code === 'string' && <pre>{it.input.code}</pre>}
                  {it.summary && <pre>{it.summary}</pre>}
                </details>
              );
            case 'proposal':
              return (
                <div key={i} className="card">
                  <h4>{it.proposal.name}</h4>
                  <div className="desc">{it.proposal.description}</div>
                  <div className="row">{it.proposal.matches.map((m) => <span key={m} className="chip">{m}</span>)}</div>
                  <details>
                    <summary className="muted">Show code</summary>
                    <pre>{it.proposal.code}</pre>
                  </details>
                  <div className="row">
                    <button className="btn" onClick={() => void tryProposal(it.proposal)} disabled={tabId == null}>Try now</button>
                    <button className="btn primary" onClick={() => void saveProposal(it.proposal, i)} disabled={it.saved}>
                      {it.saved ? 'Saved & enabled' : 'Save & enable'}
                    </button>
                  </div>
                </div>
              );
            case 'error':
              return <div key={i} className="error">{it.text}</div>;
          }
        })}
        <div ref={bottomRef} />
      </div>
      <div className="composer">
        {picked && (
          <div className="row">
            <span className="chip grow" title={picked.selector}>⌖ {picked.selector}</span>
            <button className="btn" onClick={() => setPicked(null)}>×</button>
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={unsupported ? 'Open a web page first' : 'What should this page do differently?'}
          disabled={unsupported}
        />
        <div className="row">
          <button className="btn" onClick={() => void pick()} disabled={picking || unsupported || tabId == null}>
            {picking ? 'Click an element…' : '⌖ Pick element'}
          </button>
          <button className="btn" onClick={() => void reset()} disabled={items.length === 0 && !hasHistory}>New chat</button>
          <span className="grow" />
          {busy ? (
            <button className="btn danger" onClick={abort}>Stop</button>
          ) : (
            <button className="btn primary" onClick={send} disabled={!text.trim() || unsupported}>Send</button>
          )}
        </div>
      </div>
    </div>
  );
}
