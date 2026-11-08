import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { grokAdapter } from '../../../src/cli/adapters/grok.js';
import { getPlatformAdapter } from '../../../src/cli/adapters/index.js';
import { canonicalIntegrationId } from '../../../src/shared/integration-id.js';

const base = { sessionId: 's1', cwd: '/tmp' };

describe('grokAdapter', () => {
  it('registers grok and its aliases', () => {
    expect(canonicalIntegrationId('grok')).toBe('grok');
    expect(canonicalIntegrationId('grok-cli')).toBe('grok');
    expect(canonicalIntegrationId('grok-build')).toBe('grok');
    expect(getPlatformAdapter('grok')).toBe(grokAdapter);
  });

  it('maps Grok session sources and keeps Claude source names', () => {
    expect(grokAdapter.normalizeInput({ ...base, source: 'new' }).sessionSource).toBe('new');
    expect(grokAdapter.normalizeInput({ ...base, source: 'load' }).sessionSource).toBe('load');
    // The shared Claude parser maps these before the Grok override.
    // Grok does not send them. A load skip checks platform grok and source load.
    expect(grokAdapter.normalizeInput({ ...base, source: 'startup' }).sessionSource).toBe('startup');
    expect(grokAdapter.normalizeInput({ ...base, source: 'resume' }).sessionSource).toBe('resume');
  });

  it('reads camelCase tool fields and the PascalCase hook event name', () => {
    const normalized = grokAdapter.normalizeInput({
      ...base,
      hook_event_name: 'PreToolUse',
      hookEventName: 'pre_tool_use',
      toolName: 'read_file',
      toolInput: { target_file: 'src/a.ts' },
      toolResult: { ok: true },
      lastAssistantMessage: 'done',
    });
    expect(normalized.hookEventName).toBe('PreToolUse');
    expect(normalized.toolName).toBe('read_file');
    expect(normalized.toolInput).toEqual({ target_file: 'src/a.ts', file_path: 'src/a.ts' });
    expect(normalized.toolResponse).toEqual({ ok: true });
    expect(normalized.lastAssistantMessage).toBe('done');
    expect(normalized.stopHookActive).toBeUndefined();
  });

  it('puts SessionStart context in systemMessage and omits hookSpecificOutput', () => {
    const output = grokAdapter.formatOutput({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'timeline',
        updatedInput: { command: 'rm -rf /' },
      },
      systemMessage: 'worker notice',
    }) as Record<string, unknown>;
    expect(output).toEqual({ systemMessage: 'timeline\n\nworker notice' });
  });

  it('keeps an observe-only notice when the timeline is empty', () => {
    expect(grokAdapter.formatOutput({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      systemMessage: 'worker down',
    })).toEqual({ systemMessage: 'worker down' });
  });

  it('passes PreToolUse context and a deny, and drops updatedInput', () => {
    const output = grokAdapter.formatOutput({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'file history',
        permissionDecision: 'deny',
        permissionDecisionReason: 'too large',
        updatedInput: { file_path: '/etc/passwd' },
      },
    }) as { hookSpecificOutput: Record<string, unknown> };
    expect(output.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      additionalContext: 'file history',
      permissionDecision: 'deny',
      permissionDecisionReason: 'too large',
    });
    expect(output.hookSpecificOutput.updatedInput).toBeUndefined();
  });
});

describe('Grok hook manifest', () => {
  const hooks = JSON.parse(readFileSync(
    join(import.meta.dir, '../../../plugin/hooks/grok-hooks.json'),
    'utf8',
  )).hooks;

  it('fires SessionStart for new and load only', () => {
    expect(hooks.SessionStart[0].matcher).toBe('new|load');
    expect(hooks.SessionStart[0].hooks[0].command).toContain('hook grok context');
    expect(hooks.SessionStart[0].hooks[0].timeout).toBe(60);
  });

  it('records prompts and tool use, and injects file context before a read', () => {
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toContain('hook grok session-init');
    expect(hooks.PreToolUse[0].matcher).toContain('read_file');
    expect(hooks.PreToolUse[0].hooks[0].command).toContain('hook grok file-context');
    expect(hooks.PostToolUse[0].hooks[0].command).toContain('hook grok observation');
    expect(hooks.PostToolUseFailure[0].hooks[0].command).toContain('hook grok observation');
    expect(hooks.Stop[0].hooks[0].command).toContain('hook grok summarize');
    expect(hooks.SessionEnd[0].hooks[0].command).toContain('hook grok session-end');
  });
});
