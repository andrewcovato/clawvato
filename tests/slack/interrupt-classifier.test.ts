import { describe, it, expect } from 'vitest';
import { classifyInterrupt, generateClarificationMessage } from '../../src/slack/interrupt-classifier.js';

describe('Interrupt Classifier', () => {
  // Mock classifier function that returns structured JSON
  function mockClassifier(type: string, confidence: number) {
    return async (_sys: string, _msg: string) => JSON.stringify({ type, confidence });
  }

  it('fast-path detects obvious cancels without LLM call', async () => {
    let llmCalled = false;
    const classifierFn = async () => { llmCalled = true; return '{}'; };

    const result = await classifyInterrupt('Finding meeting times', 'scratch that', classifierFn);
    expect(result.type).toBe('cancel');
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.shouldAsk).toBe(false);
    expect(llmCalled).toBe(false);
  });

  it('fast-path handles "never mind"', async () => {
    const classifierFn = async () => '{}';
    const result = await classifyInterrupt('Drafting email', 'never mind', classifierFn);
    expect(result.type).toBe('cancel');
  });

  it('fast-path handles "nvm"', async () => {
    const classifierFn = async () => '{}';
    const result = await classifyInterrupt('Searching files', 'nvm', classifierFn);
    expect(result.type).toBe('cancel');
  });

  it('classifies additive interrupts from LLM', async () => {
    const result = await classifyInterrupt(
      'Finding meeting times with Sarah',
      'also make it 30 minutes',
      mockClassifier('additive', 0.92),
    );
    expect(result.type).toBe('additive');
    expect(result.shouldAsk).toBe(false);
  });

  it('classifies redirect interrupts from LLM', async () => {
    const result = await classifyInterrupt(
      'Finding competitive websites',
      'actually make a reservation at Prato instead',
      mockClassifier('redirect', 0.88),
    );
    expect(result.type).toBe('redirect');
    expect(result.shouldAsk).toBe(false);
  });

  it('classifies unrelated interrupts from LLM', async () => {
    const result = await classifyInterrupt(
      'Summarizing Slack channel',
      'remind me to buy milk',
      mockClassifier('unrelated', 0.85),
    );
    expect(result.type).toBe('unrelated');
    expect(result.shouldAsk).toBe(false);
  });

  it('returns shouldAsk=true when confidence is low', async () => {
    const result = await classifyInterrupt(
      'Checking calendar',
      'what about thursday',
      mockClassifier('additive', 0.55),
    );
    expect(result.shouldAsk).toBe(true);
  });

  it('handles classifier failure gracefully', async () => {
    const failingClassifier = async () => { throw new Error('API error'); };
    const result = await classifyInterrupt(
      'Working on something',
      'some message',
      failingClassifier,
    );
    expect(result.shouldAsk).toBe(true);
    expect(result.confidence).toBe(0);
  });

  it('handles invalid JSON from classifier', async () => {
    const badJsonClassifier = async () => 'not json at all';
    const result = await classifyInterrupt(
      'Working on something',
      'some message',
      badJsonClassifier,
    );
    expect(result.shouldAsk).toBe(true);
  });

  it('handles invalid type from classifier', async () => {
    const badTypeClassifier = async () => JSON.stringify({ type: 'banana', confidence: 0.99 });
    const result = await classifyInterrupt(
      'Working on something',
      'some message',
      badTypeClassifier,
    );
    expect(result.shouldAsk).toBe(true);
  });
});

describe('generateClarificationMessage', () => {
  it('includes current task and new message', () => {
    const msg = generateClarificationMessage('Finding meeting times', 'what about thursday');
    expect(msg).toContain('Finding meeting times');
    expect(msg).toContain('what about thursday');
    expect(msg).toContain('Add this');
  });
});
