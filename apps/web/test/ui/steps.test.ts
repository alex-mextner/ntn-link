/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { flowSteps, initialState, type FlowState, type Phase } from '../../lib/client/flow';
import { challengeFixture, previewFixture } from './helpers';

function at(phase: Phase, overrides: Partial<FlowState> = {}): string {
  const state: FlowState = { ...initialState, phase, ...overrides };
  return flowSteps(state)
    .map((step) => `${step.id}:${step.status}`)
    .join(' ');
}

const highlighted = (state: FlowState) =>
  flowSteps(state)
    .filter((s) => s.status === 'current' || s.status === 'busy')
    .map((s) => s.id);
const unverified = previewFixture();
const verified = previewFixture({ needsVerification: false, suggestedAction: null });

describe('flowSteps', () => {
  test('an empty form starts at the preview step', () => {
    expect(at('idle')).toBe('preview:current verify:upcoming create:upcoming share:upcoming');
  });

  test('fetching the preview is the busy preview step', () => {
    expect(at('previewing')).toBe('preview:busy verify:upcoming create:upcoming share:upcoming');
  });

  test('a ready preview of an unverified workspace is waiting on verification, not on create', () => {
    expect(at('ready', { preview: unverified })).toBe(
      'preview:done verify:current create:upcoming share:upcoming',
    );
  });

  test('a stored key the preview did not carry keeps Create current: nothing proves it is bad yet', () => {
    expect(at('ready', { preview: unverified, keyUntested: true })).toBe(
      'preview:done verify:upcoming create:current share:upcoming',
    );
  });

  test('pressing Create on an unverified preview does not move the highlight to Create and back', () => {
    expect(at('creating', { preview: unverified })).toBe(
      'preview:done verify:busy create:upcoming share:upcoming',
    );
    expect(at('creating', { preview: unverified, keyUntested: true })).toBe(
      'preview:done verify:upcoming create:busy share:upcoming',
    );
  });

  test('a ready preview that needs no proof marks verification done', () => {
    expect(at('ready', { preview: verified })).toBe(
      'preview:done verify:done create:current share:upcoming',
    );
  });

  test('creating is busy on the create step', () => {
    expect(at('creating', { preview: verified })).toBe(
      'preview:done verify:done create:busy share:upcoming',
    );
  });

  test.each<Phase>(['needs_verification', 'awaiting_proof'])(
    '%s waits on verification',
    (phase) => {
      expect(
        at(phase, {
          preview: unverified,
          verification: phase === 'awaiting_proof' ? challengeFixture : null,
        }),
      ).toBe('preview:done verify:current create:upcoming share:upcoming');
    },
  );

  test.each<Phase>(['requesting_challenge', 'verifying'])('%s is busy on verification', (phase) => {
    expect(at(phase, { preview: unverified })).toBe(
      'preview:done verify:busy create:upcoming share:upcoming',
    );
  });

  test('a created link completes every step', () => {
    expect(at('created', { preview: verified })).toBe(
      'preview:done verify:done create:done share:done',
    );
  });

  test('exactly one step is current or busy before the end', () => {
    for (const phase of [
      'idle',
      'previewing',
      'ready',
      'creating',
      'needs_verification',
      'requesting_challenge',
      'awaiting_proof',
      'verifying',
    ] satisfies Phase[]) {
      const steps = flowSteps({ ...initialState, phase, preview: unverified });
      expect(steps.filter((s) => s.status === 'current' || s.status === 'busy')).toHaveLength(1);
    }
  });

  test('the create step is highlighted only once nothing is left to prove', () => {
    // Step 3 must not light up in every state: only for a workspace that needs no proof.
    for (const phase of [
      'idle',
      'previewing',
      'needs_verification',
      'requesting_challenge',
      'awaiting_proof',
      'verifying',
    ] satisfies Phase[]) {
      expect(highlighted({ ...initialState, phase, preview: unverified })).not.toContain('create');
    }
    expect(highlighted({ ...initialState, phase: 'ready', preview: unverified })).toEqual([
      'verify',
    ]);
    expect(highlighted({ ...initialState, phase: 'ready', preview: verified })).toEqual(['create']);
    expect(highlighted({ ...initialState, phase: 'creating', preview: verified })).toEqual([
      'create',
    ]);
    expect(highlighted({ ...initialState, phase: 'created', preview: verified })).toEqual([]);
  });
});
