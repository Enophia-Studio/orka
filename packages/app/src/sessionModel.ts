// The composer's model menu: what one session runs on. A session copies the settings when it
// starts (model, effort, Claude Code profile); the menu changes that copy only, and "Use as
// default" writes it back to the settings for sessions started later. Pure: no UI, no Node APIs.
import type { AppSettings } from './settings';

/** The model menu's choice for one session, made for the main agent's provider `provider`. */
export interface SessionChoice {
  provider: string;
  /** '' = the provider's default model. */
  model: string;
  /** '' = the provider's own default (nothing is sent). */
  effort: string;
  /** Claude Code profile id ('' = the default profile, no CLAUDE_CONFIG_DIR). */
  profile: string;
  /** An agent CLI: values the user picked for options the agent advertised (option id -> value). */
  options?: Record<string, string>;
}

/** The setting each provider kind keeps its default effort in. */
export const EFFORT_SETTING: Readonly<Record<string, string>> = {
  claude: 'claude.effort',
  'claude-code': 'claudeCode.effort',
  gemini: 'gemini.thinkingLevel',
  openai: 'openai.reasoningEffort',
};

/** The effort levels a provider takes ('' first where the provider has a default of its own); none for the others. */
export function effortLevels(provider: string): string[] {
  switch (provider) {
    case 'claude':
      return ['low', 'medium', 'high', 'xhigh', 'max'];
    case 'claude-code':
      return ['', 'low', 'medium', 'high', 'xhigh', 'max'];
    case 'gemini':
    case 'openai':
      return ['', 'low', 'medium', 'high'];
    default:
      return [];
  }
}

/** The default effort the settings hold for a provider ('' for one without effort levels). */
export function settingsEffort(settings: AppSettings, provider: string): string {
  switch (provider) {
    case 'claude':
      return settings.claude.effort;
    case 'claude-code':
      return settings.claudeCode.effort ?? '';
    case 'gemini':
      return settings.gemini.thinkingLevel ?? '';
    case 'openai':
      return settings.openai.reasoningEffort ?? '';
    default:
      return '';
  }
}

const OPTION_TEXT = /^[\w.:/@ -]{1,160}$/;

/** A choice read back from a saved task (anything malformed is dropped). */
export function readChoice(raw: unknown): SessionChoice | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.length <= 200 ? v : undefined);
  const provider = text(c.provider);
  if (!provider) return undefined;
  const options: Record<string, string> = {};
  if (c.options && typeof c.options === 'object') {
    for (const [id, value] of Object.entries(c.options as Record<string, unknown>).slice(0, 20)) {
      if (OPTION_TEXT.test(id) && typeof value === 'string' && OPTION_TEXT.test(value)) options[id] = value;
    }
  }
  return {
    provider,
    model: text(c.model) ?? '',
    effort: text(c.effort) ?? '',
    profile: text(c.profile) ?? '',
    ...(Object.keys(options).length ? { options } : {}),
  };
}

/** An option id or value an agent may advertise and the page may send back. */
export function isOptionText(value: unknown): value is string {
  return typeof value === 'string' && OPTION_TEXT.test(value);
}
