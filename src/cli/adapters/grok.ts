import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';

/**
 * Grok session sources. `new` is a fresh session, including /new and /clear.
 * `load` reopens a saved session. Claude's startup, resume, clear, and compact
 * never match a Grok SessionStart hook.
 */
const GROK_SESSION_SOURCES = new Set(['new', 'load']);

/**
 * Observe-only events. Grok reads a top-level systemMessage and ignores
 * hookSpecificOutput.additionalContext.
 */
const OBSERVE_ONLY_EVENTS = new Set(['SessionStart', 'Notification', 'PreCompact']);

function sessionSourceOf(raw: unknown): 'new' | 'load' | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const source = record.source ?? record.sessionSource;
  return typeof source === 'string' && GROK_SESSION_SOURCES.has(source)
    ? source as 'new' | 'load'
    : undefined;
}

function hookEventNameOf(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const name = (raw as Record<string, unknown>).hook_event_name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

function filled(value: string | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Grok Build hook adapter.
 *
 * Field names already match the Claude Code adapter, including camelCase.
 * This adapter adds Grok's session source and writes SessionStart context
 * where Grok reads it. It never returns updatedInput: a value that fails the
 * tool schema blocks the call.
 */
export const grokAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const normalized = claudeCodeAdapter.normalizeInput(raw);
    const sessionSource = sessionSourceOf(raw);
    if (sessionSource) normalized.sessionSource = sessionSource;
    const hookEventName = hookEventNameOf(raw);
    if (hookEventName) normalized.hookEventName = hookEventName;
    return normalized;
  },

  formatOutput(result): unknown {
    const hookResult = result ?? ({} as HookResult);
    const specific = hookResult.hookSpecificOutput;
    const eventName = specific?.hookEventName;

    if (eventName && OBSERVE_ONLY_EVENTS.has(eventName)) {
      const timeline = filled(specific?.additionalContext);
      const note = filled(hookResult.systemMessage);
      const systemMessage = timeline && note && !timeline.includes(note)
        ? `${timeline}\n\n${note}`
        : timeline ?? note;
      return systemMessage ? { systemMessage } : {};
    }

    const output: Record<string, unknown> = {};
    if (filled(hookResult.systemMessage)) output.systemMessage = hookResult.systemMessage;
    if (hookResult.continue !== undefined) output.continue = hookResult.continue;
    if (hookResult.decision) output.decision = hookResult.decision;
    if (filled(hookResult.reason)) output.reason = hookResult.reason;

    if (specific && eventName) {
      const clean: Record<string, unknown> = {
        hookEventName: eventName,
        additionalContext: specific.additionalContext ?? '',
      };
      if (specific.permissionDecision) clean.permissionDecision = specific.permissionDecision;
      if (filled(specific.permissionDecisionReason)) {
        clean.permissionDecisionReason = specific.permissionDecisionReason;
      }
      output.hookSpecificOutput = clean;
    }
    return output;
  },
};
