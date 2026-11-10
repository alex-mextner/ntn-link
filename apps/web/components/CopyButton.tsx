'use client';

import { useEffect, useRef, useState } from 'react';
import { en } from '@/lib/client/strings';
import { CheckIcon, CopyIcon } from './icons';

/** Copies `text`, shows a check mark for a moment and announces the result in a polite live region. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), 2500);
  }

  return (
    <span className="copy">
      <button
        type="button"
        className="btn btn-secondary"
        data-state={status}
        data-return-focus=""
        onClick={copy}
        aria-label={`${status === 'copied' ? en.copied : en.copy}: ${label}`}
      >
        {status === 'copied' ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
        <span className="btn-label">{status === 'copied' ? en.copied : en.copy}</span>
      </button>
      <span className="visually-hidden" role="status">
        {status === 'copied' ? en.copied : status === 'failed' ? en.copyFailed : ''}
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
