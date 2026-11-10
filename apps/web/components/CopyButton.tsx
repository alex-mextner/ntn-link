'use client';

import { useEffect, useRef, useState } from 'react';
import { ru } from '@/lib/client/strings';

/** Copies `text` and announces the result in a polite live region (no layout shift: fixed label slot). */
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
        className="btn secondary"
        onClick={copy}
        aria-label={`${ru.copy}: ${label}`}
      >
        {status === 'copied' ? ru.copied : ru.copy}
      </button>
      <span className="visually-hidden" role="status">
        {status === 'copied' ? ru.copied : status === 'failed' ? ru.copyFailed : ''}
      </span>
      {status === 'failed' ? <span className="field-error">{ru.copyFailed}</span> : null}
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
