'use client';

import { useEffect, useState } from 'react';
import type { Cleanup } from '@/lib/client/flow';
import type { Controller, WorkspaceLinks } from '@/lib/client/controller';
import { ru } from '@/lib/client/strings';
import { plainText } from '@/lib/client/text';
import { CopyButton } from './CopyButton';

/** Links of every workspace this browser holds a key for (spec section 6, "My links"). */
export function MyLinks({
  controller,
  cleanups,
  version,
}: {
  controller: Controller;
  cleanups: Cleanup[];
  version: number;
}) {
  const [items, setItems] = useState<WorkspaceLinks[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  useEffect(() => {
    let cancelled = false;
    const workspaces = controller.listWorkspaces();
    void Promise.all(workspaces.map((ws) => controller.loadLinks(ws))).then((loaded) => {
      if (!cancelled) setItems(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [controller, version]);

  async function remove(workspace: string, slug: string) {
    setConfirming(null);
    const failure = await controller.deleteLink(workspace, slug);
    setMessage(failure);
    const fresh = await controller.loadLinks(workspace);
    setItems((current) => current.map((item) => (item.workspace === workspace ? fresh : item)));
  }

  function forget(workspace: string) {
    controller.forgetWorkspace(workspace);
    setItems((current) => current.filter((item) => item.workspace !== workspace));
  }

  if (items.length === 0 && cleanups.length === 0) return null;

  return (
    <section aria-labelledby="mylinks-heading" className="panel">
      <h2 id="mylinks-heading">{ru.myLinks}</h2>
      {cleanups.map((cleanup) => (
        <CleanupNotice key={cleanup.workspace} cleanup={cleanup} controller={controller} />
      ))}
      <div className="msg-slot" aria-live="polite">
        {message ? (
          <p className="field-error" role="alert">
            {message}
          </p>
        ) : null}
      </div>
      {items.map((item) => (
        <div key={item.workspace} className="workspace">
          <h3 className="subheading">{ru.myLinksWorkspace(item.workspace)}</h3>
          {item.status === 'error' ? (
            <p className="field-error" role="alert">
              {item.error}
            </p>
          ) : null}
          {item.status === 'ready' && item.links.length === 0 ? (
            <p className="hint">{ru.myLinksEmpty}</p>
          ) : null}
          <ul className="links">
            {item.links.map((link) => {
              const url = `${origin}/${link.workspace}/${link.slug}`;
              const key = `${link.workspace}/${link.slug}`;
              return (
                <li key={key}>
                  <div className="link-main">
                    <a
                      href={`/${encodeURIComponent(link.workspace)}/${encodeURIComponent(link.slug)}`}
                      className="mono"
                    >
                      {`/${link.workspace}/${link.slug}`}
                    </a>
                    <span className="link-title">{plainText(link.card.title)}</span>
                  </div>
                  <div className="link-actions">
                    <CopyButton text={url} label={`/${link.workspace}/${link.slug}`} />
                    {confirming === key ? (
                      <span
                        className="confirm"
                        role="group"
                        aria-label={ru.deleteConfirm(link.slug)}
                      >
                        <span>{ru.deleteConfirm(link.slug)}</span>
                        <button
                          type="button"
                          className="btn danger"
                          onClick={() => void remove(link.workspace, link.slug)}
                        >
                          {ru.confirmYes}
                        </button>
                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() => setConfirming(null)}
                          autoFocus
                        >
                          {ru.confirmNo}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn secondary"
                        aria-label={`${ru.delete}: /${link.workspace}/${link.slug}`}
                        onClick={() => setConfirming(key)}
                      >
                        {ru.delete}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <button type="button" className="btn link" onClick={() => forget(item.workspace)}>
            {ru.forgetKey}
          </button>
        </div>
      ))}
    </section>
  );
}

function CleanupNotice({ cleanup, controller }: { cleanup: Cleanup; controller: Controller }) {
  if (cleanup.status === 'done') {
    return (
      <p className="notice" role="status">
        {cleanup.message}
      </p>
    );
  }
  return (
    <div className="notice" role="group" aria-labelledby={`cleanup-heading-${cleanup.workspace}`}>
      <h3 id={`cleanup-heading-${cleanup.workspace}`} className="subheading">
        {ru.cleanupHeading(cleanup.workspace)}
      </h3>
      <p>{ru.cleanupBody(cleanup.removedLinks)}</p>
      <div className="msg-slot" aria-live="polite">
        {cleanup.message ? <p className="field-error">{cleanup.message}</p> : null}
      </div>
      {cleanup.status !== 'unsupported' ? (
        <button
          type="button"
          className="btn primary"
          disabled={cleanup.status === 'running'}
          onClick={() => void controller.runCleanup(cleanup.workspace)}
        >
          {cleanup.status === 'running' ? ru.cleanupRunning : ru.cleanupRun}
        </button>
      ) : null}
    </div>
  );
}
