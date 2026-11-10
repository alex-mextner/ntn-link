'use client';

import { useEffect, useRef, useState } from 'react';
import { CLIPBOARD_TIMEOUT_MS, raceDeadline } from '@/lib/client/deadline';
import { en } from '@/lib/client/strings';
import { CheckIcon, CopyIcon, SpinnerIcon } from './icons';

/** Copies `text`, shows a check mark for a moment and announces the result in a polite live region. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    if (status === 'copying') return;
    // A reset timer of the previous copy must not end this one early.
    if (timer.current) clearTimeout(timer.current);
    setStatus('copying');
    try {
      // The clipboard can wait on a permission prompt that never comes: give up and say so.
      await raceDeadline(navigator.clipboard.writeText(text), CLIPBOARD_TIMEOUT_MS);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), 2500);
  }

  const copying = status === 'copying';
  const buttonLabel = status === 'copied' ? en.copied : copying ? en.copying : en.copy;
  return (
    <span className="copy">
      <button
        type="button"
        className="btn btn-secondary"
        data-state={status}
        data-return-focus=""
        onClick={copy}
        aria-busy={copying ? true : undefined}
        aria-disabled={copying ? true : undefined}
        aria-label={`${buttonLabel}: ${label}`}
      >
        {copying ? (
          <SpinnerIcon size={16} />
        ) : status === 'copied' ? (
          <CheckIcon size={16} />
        ) : (
          <CopyIcon size={16} />
        )}
        <span className="btn-label">{buttonLabel}</span>
      </button>
      <span className="visually-hidden" role="status">
        {copying
          ? en.announce.copying
          : status === 'copied'
            ? en.copied
            : status === 'failed'
              ? en.copyFailed
              : ''}
      </span>
      {status === 'failed' ? <span className="field-error">{en.copyFailed}</span> : null}
    </span>
  );
}

/**
 * A long value (link, code) shown in full: wraps instead of truncating like an <input> would at
 * 360 px. Focusable and read-only so keyboard users can reach and select it.
 */
export function ValueField({
  id,
  labelledBy,
  describedBy,
  value,
}: {
  id: string;
  labelledBy: string;
  describedBy?: string;
  value: string;
}) {
  return (
    <div
      id={id}
      className="input value mono"
      role="textbox"
      aria-readonly="true"
      aria-multiline="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      tabIndex={0}
    >
      {value}
    </div>
  );
}
