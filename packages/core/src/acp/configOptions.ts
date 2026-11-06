// What an agent advertises about its session over ACP besides the turn itself: session config
// options (session/new, session/set_config_option, the config_option_update notification) and
// how full its context is (the usage_update notification). Both are read defensively: anything
// malformed or of a kind Orka does not offer is dropped.
import type { AgentOption, ContextFill } from '../orchestrator/events';

const CATEGORIES = new Set(['model', 'thought_level']);
/** Ids and values Orka keeps (and may send back): short, printable, no markup. */
const TEXT = /^[\w.:/@ -]{1,160}$/;
const MAX_OPTIONS = 10;
const MAX_VALUES = 100;

function label(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : fallback;
}

/**
 * The model and thought-level choices among an agent's session config options (`select` options
 * only; grouped values are flattened). A current value that is not among the values drops the option.
 */
export function readConfigOptions(raw: unknown): AgentOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentOption[] = [];
  for (const item of raw.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (o.type !== 'select' || typeof o.category !== 'string' || !CATEGORIES.has(o.category)) continue;
    if (typeof o.id !== 'string' || !TEXT.test(o.id) || typeof o.currentValue !== 'string' || !Array.isArray(o.options)) continue;
    const values: AgentOption['options'] = [];
    const add = (v: unknown) => {
      if (!v || typeof v !== 'object' || values.length >= MAX_VALUES) return;
      const value = (v as Record<string, unknown>).value;
      if (typeof value === 'string' && TEXT.test(value) && !values.some((x) => x.value === value)) values.push({ value, name: label((v as Record<string, unknown>).name, value) });
    };
    for (const entry of o.options) {
      const group = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).options : undefined;
      if (Array.isArray(group)) group.forEach(add);
      else add(entry);
    }
    if (!values.some((v) => v.value === o.currentValue)) continue;
    out.push({ id: o.id, name: label(o.name, o.id), category: o.category as AgentOption['category'], currentValue: o.currentValue, options: values });
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

/** The context fill of a usage_update (tokens in context and the window), or undefined when malformed. */
export function readContextFill(update: Record<string, unknown>): ContextFill | undefined {
  const { used, size } = update;
  if (typeof used !== 'number' || typeof size !== 'number' || !Number.isFinite(used) || !Number.isFinite(size) || used < 0 || size <= 0) return undefined;
  return { used, size };
}

/**
 * The values to send before a prompt: each choice the user made for an option the agent
 * advertised, with a value it listed, that differs from the option's current value.
 */
export function pendingChoices(options: readonly AgentOption[], choices: Readonly<Record<string, string>> | undefined): Array<{ id: string; value: string }> {
  if (!choices) return [];
  const out: Array<{ id: string; value: string }> = [];
  for (const option of options) {
    const value = Object.prototype.hasOwnProperty.call(choices, option.id) ? choices[option.id] : undefined;
    if (value !== undefined && value !== option.currentValue && option.options.some((v) => v.value === value)) out.push({ id: option.id, value });
  }
  return out;
}
