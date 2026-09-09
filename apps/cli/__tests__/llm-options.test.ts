import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { addLlmOptions } from '../src/lib/llm-options.js';
import { resolveLlm } from '../src/lib/config.js';
import { memoryStore } from '../src/lib/credentials.js';
import { registerAuthCommand } from '../src/commands/auth.js';
import { createContext } from '../src/lib/context.js';

describe('addLlmOptions', () => {
  it('registers model/profile options without accepting secrets in argv', () => {
    const cmd = new Command('test');
    addLlmOptions(cmd);
    const optionNames = cmd.options.flatMap((option) => option.flags.split(' '));
    expect(optionNames).toContain('--model');
    expect(optionNames).toContain('--profile');
    expect(optionNames).not.toContain('--api-key');
    expect(cmd.options.find((option) => option.long === '--model')?.description)
      .toContain('anthropic/claude-sonnet-5');
  });

  it('returns the same Command instance for chaining', () => {
    const cmd = new Command('t2');
    const result = addLlmOptions(cmd);
    expect(result).toBe(cmd);
  });

  it('does not accept API keys through the auth command argv either', () => {
    const program = new Command();
    registerAuthCommand(program, createContext('en'));
    const auth = program.commands.find((command) => command.name() === 'auth');
    expect(auth?.options.map((option) => option.long)).not.toContain('--api-key');
  });
});

// argv no longer accepts secrets. Internal resolution still obtains keys from
// the configured keychain/environment path.
describe('internal LLM credential resolution', () => {
  const config = { models: { default: { primary: 'anthropic/claude-sonnet-4-5' } } };
  it('uses the keychain when no secret-bearing argv override exists', () => {
    const store = memoryStore({ 'anthropic:default': 'from-keychain' });
    const r = resolveLlm({ config, store, role: 'default' });
    expect(r.apiKey).toBe('from-keychain');
  });
});
