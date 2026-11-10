'use client';

import { useEffect, useState } from 'react';
import type { Cleanup } from '@/lib/client/flow';
import type { Controller, WorkspaceLinks } from '@/lib/client/controller';
import { en } from '@/lib/client/strings';
import { plainText } from '@/lib/client/text';
import { CopyButton } from './CopyButton';
import { AlertIcon, ArrowUpRightIcon, CheckIcon, SpinnerIcon } from './icons';

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
  /** `workspace/slug` of the link whose deletion is in flight. */
  const [deleting, setDeleting] = useState<string | null>(null);
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
    setDeleting(`${workspace}/${slug}`);
    try {
      const failure = await controller.deleteLink(workspace, slug);
      setMessage(failure);
      const fresh = await controller.loadLinks(workspace);
      setItems((current) => current.map((item) => (item.workspace === workspace ? fresh : item)));
    } finally {
      setDeleting(null);
    }
  }

  function forget(workspace: string) {
    controller.forgetWorkspace(workspace);
    setItems((current) => current.filter((item) => item.workspace !== workspace));
  }

  if (items.length === 0 && cleanups.length === 0) return null;

  return (
    <section aria-labelledby="mylinks-heading" className="panel panel-links">
      <div className="panel-title">
        <h2 id="mylinks-heading">{en.myLinks}</h2>
      </div>
      {cleanups.map((cleanup) => (
        <CleanupNotice key={cleanup.workspace} cleanup={cleanup} controller={controller} />
      ))}
      <div className="msg-slot" aria-live="polite">
        {message ? <InlineError message={message} /> : null}
      </div>
      <p className="visually-hidden" role="status">
        {deleting ? en.announce.deleting : ''}
      </p>
      {items.map((item) => (
        <div key={item.workspace} className="workspace">
          <h3 className="subheading">{en.myLinksWorkspace(item.workspace)}</h3>
          {item.status === 'error' ? <InlineError message={item.error ?? ''} /> : null}
          {item.status === 'ready' && item.links.length === 0 ? (
            <p className="hint">{en.myLinksEmpty}</p>
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
                      className="link-path mono"
                    >
                      {`/${link.workspace}/${link.slug}`}
                      <ArrowUpRightIcon size={14} />
                    </a>
                    <span className="link-title">{plainText(link.card.title)}</span>
                  </div>
                  <div className="link-actions">
                    <CopyButton text={url} label={`/${link.workspace}/${link.slug}`} />
                    {confirming === key ? (
                      <span
                        className="confirm"
                        role="group"
                        aria-label={en.deleteConfirm(link.slug)}
                      >
                        <span>{en.deleteConfirm(link.slug)}</span>
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={() => void remove(link.workspace, link.slug)}
                        >
                          {en.confirmYes}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => setConfirming(null)}
                          autoFocus
                        >
                          {en.confirmNo}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        aria-label={`${deleting === key ? en.deleting : en.delete}: /${link.workspace}/${link.slug}`}
                        aria-busy={deleting === key ? true : undefined}
                        disabled={deleting !== null}
                        onClick={() => setConfirming(key)}
                      >
                        {deleting === key ? <SpinnerIcon /> : null}
                        <span className="btn-label">
                          {deleting === key ? en.deleting : en.delete}
                        </span>
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <button type="button" className="btn btn-link" onClick={() => forget(item.workspace)}>
            {en.forgetKey}
          </button>
        </div>
      ))}
    </section>
  );
}

function InlineError({ message, alert = true }: { message: string; alert?: boolean }) {
  return (
    <p className="field-error" role={alert ? 'alert' : undefined}>
      <AlertIcon size={16} />
      <span>{message}</span>
    </p>
  );
}

function CleanupNotice({ cleanup, controller }: { cleanup: Cleanup; controller: Controller }) {
  if (cleanup.status === 'done') {
    return (
      <p className="notice" role="status">
        <CheckIcon size={18} />
        <span>{cleanup.message}</span>
      </p>
    );
  }
  return (
    <div className="notice" role="group" aria-labelledby={`cleanup-heading-${cleanup.workspace}`}>
      <h3 id={`cleanup-heading-${cleanup.workspace}`} className="subheading">
        {en.cleanupHeading(cleanup.workspace)}
      </h3>
      <p>{en.cleanupBody(cleanup.removedLinks)}</p>
      <div className="msg-slot" aria-live="polite">
        {cleanup.message ? <InlineError message={cleanup.message} alert={false} /> : null}
      </div>
      {cleanup.status !== 'unsupported' ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={cleanup.status === 'running'}
          onClick={() => void controller.runCleanup(cleanup.workspace)}
        >
          {cleanup.status === 'running' ? <SpinnerIcon /> : null}
          <span className="btn-label">
            {cleanup.status === 'running' ? en.cleanupRunning : en.cleanupRun}
          </span>
        </button>
      ) : null}
    </div>
  );
}
