export const SIEVE_CAPABILITY = 'urn:ietf:params:jmap:sieve';
export const MANAGED_SCRIPT_NAME = 'Stormbox Mail Rules';
export const MANAGED_SCRIPT_MARKER = '# stormbox-managed: mail-rules/v1';

const DATA_PREFIX = '# stormbox-data: ';
const DATA_CHUNK_SIZE = 72;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export type RuleMatch = 'all' | 'any';
export type RuleField = 'from' | 'to' | 'toCc' | 'subject' | 'header';
export type RuleOperator = 'is' | 'contains' | 'matches';

export interface MailRuleCondition {
  id: string;
  field: RuleField;
  operator: RuleOperator;
  value: string;
  headerName?: string;
}

export type MailRuleAction =
  | { id: string; type: 'move'; mailboxId: string; mailboxName: string }
  | { id: string; type: 'markRead' }
  | { id: string; type: 'star' }
  | { id: string; type: 'redirect'; address: string }
  | { id: string; type: 'discard' };

export interface MailRule {
  id: string;
  name: string;
  enabled: boolean;
  match: RuleMatch;
  conditions: MailRuleCondition[];
  actions: MailRuleAction[];
  stopProcessing: boolean;
}

export interface MailRuleDocument {
  version: 1;
  rules: MailRule[];
}

export interface SieveRuleCapabilities {
  sieveExtensions: string[];
  maxSizeScript?: number | null;
  maxNumberRedirects?: number | null;
}

export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleValidationError';
  }
}

export function emptyRuleDocument(): MailRuleDocument {
  return { version: 1, rules: [] };
}

export function newRuleId(prefix = 'rule'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createEmptyRule(): MailRule {
  return {
    id: newRuleId(),
    name: 'New rule',
    enabled: true,
    match: 'all',
    conditions: [{
      id: newRuleId('condition'),
      field: 'from',
      operator: 'contains',
      value: '',
    }],
    actions: [{ id: newRuleId('action'), type: 'markRead' }],
    stopProcessing: true,
  };
}

export function cloneRuleDocument(document: MailRuleDocument): MailRuleDocument {
  return {
    version: 1,
    rules: document.rules.map((rule) => ({
      ...rule,
      conditions: rule.conditions.map((condition) => ({ ...condition })),
      actions: rule.actions.map((action) => ({ ...action })),
    })),
  };
}

export function normalizeRuleDocument(input: unknown): MailRuleDocument {
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.rules)) {
    throw new RuleValidationError('The managed rule data has an unsupported format.');
  }

  const seenRuleIds = new Set<string>();
  const rules = input.rules.map((value, ruleIndex) => {
    if (!isRecord(value)) {
      throw new RuleValidationError(`Rule ${ruleIndex + 1} is malformed.`);
    }
    const id = requiredId(value.id, `Rule ${ruleIndex + 1}`, seenRuleIds);
    const name = requiredText(value.name, `Rule ${ruleIndex + 1} needs a name.`);
    const match = value.match === 'all' || value.match === 'any' ? value.match : null;
    if (!match) throw new RuleValidationError(`Rule “${name}” has an invalid match mode.`);
    if (!Array.isArray(value.conditions) || value.conditions.length === 0) {
      throw new RuleValidationError(`Rule “${name}” needs at least one condition.`);
    }
    if (!Array.isArray(value.actions) || value.actions.length === 0) {
      throw new RuleValidationError(`Rule “${name}” needs at least one action.`);
    }

    const seenConditionIds = new Set<string>();
    const conditions = value.conditions.map((condition, conditionIndex) =>
      normalizeCondition(condition, name, conditionIndex, seenConditionIds));
    const seenActionIds = new Set<string>();
    const actions = value.actions.map((action, actionIndex) =>
      normalizeAction(action, name, actionIndex, seenActionIds));

    return {
      id,
      name,
      enabled: value.enabled !== false,
      match,
      conditions,
      actions,
      stopProcessing: value.stopProcessing === true,
    } satisfies MailRule;
  });

  return { version: 1, rules };
}

export function isManagedRulesScript(script: string): boolean {
  return script.split(/\r?\n/).some((line) => line.trimEnd() === MANAGED_SCRIPT_MARKER);
}

/**
 * Return null for a foreign script. A script carrying Stormbox's marker
 * is owned by this editor; malformed metadata throws so callers never
 * silently replace a managed script they can no longer understand.
 */
export function parseManagedRules(script: string): MailRuleDocument | null {
  if (!isManagedRulesScript(script)) return null;
  const chunks = script
    .split(/\r?\n/)
    .filter((line) => line.startsWith(DATA_PREFIX))
    .map((line) => line.slice(DATA_PREFIX.length).trim());
  if (chunks.length === 0 || chunks.some((chunk) => !/^[A-Za-z0-9_-]+$/.test(chunk))) {
    throw new RuleValidationError('The Stormbox rule metadata is missing or malformed.');
  }
  try {
    const json = new TextDecoder().decode(decodeBase64Url(chunks.join('')));
    return normalizeRuleDocument(JSON.parse(json));
  } catch (error) {
    if (error instanceof RuleValidationError) throw error;
    throw new RuleValidationError('The Stormbox rule metadata could not be decoded.');
  }
}

export function compileRules(
  input: unknown,
  capabilities: SieveRuleCapabilities,
): string {
  const document = normalizeRuleDocument(input);
  validateRedirectBudget(document, capabilities.maxNumberRedirects);
  const extensions = new Set(capabilities.sieveExtensions ?? []);
  const required = new Set<string>();
  const blocks: string[] = [];

  for (const rule of document.rules) {
    if (!rule.enabled) continue;
    const test = compileRuleTest(rule);
    const actionLines = rule.actions.map((action) =>
      `  ${compileAction(action, extensions, required)}`);
    if (rule.stopProcessing) actionLines.push('  stop;');
    const label = rule.name.replace(/[\r\n]+/g, ' ').trim();
    blocks.push([
      `# Rule: ${label}`,
      `if ${test} {`,
      ...actionLines,
      '}',
    ].join('\r\n'));
  }

  const encoded = encodeBase64Url(new TextEncoder().encode(JSON.stringify(document)));
  const metadataLines = chunkString(encoded, DATA_CHUNK_SIZE)
    .map((chunk) => `${DATA_PREFIX}${chunk}`);
  const lines = [
    '# Stormbox managed mail rules. Edit these rules in Stormbox.',
    MANAGED_SCRIPT_MARKER,
    ...metadataLines,
    '',
  ];
  if (required.size > 0) {
    lines.push(`require [${[...required].sort().map(sieveString).join(', ')}];`, '');
  }
  if (blocks.length > 0) {
    lines.push(blocks.join('\r\n\r\n'));
  } else {
    lines.push('# No enabled rules.', 'keep;');
  }
  lines.push('', '# End Stormbox managed mail rules.', '');
  const script = lines.join('\r\n');
  const maxSize = capabilities.maxSizeScript;
  if (typeof maxSize === 'number' && maxSize >= 0) {
    const size = new TextEncoder().encode(script).byteLength;
    if (size > maxSize) {
      throw new RuleValidationError(`The generated script is ${size} bytes; the server limit is ${maxSize}.`);
    }
  }
  return script;
}

function validateRedirectBudget(document: MailRuleDocument, limit: number | null | undefined): void {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) return;

  let redirectsOnContinuingPath = 0;
  let maximumRedirects = 0;
  for (const rule of document.rules) {
    if (!rule.enabled) continue;
    const redirectsInRule = rule.actions.filter((action) => action.type === 'redirect').length;
    maximumRedirects = Math.max(maximumRedirects, redirectsOnContinuingPath + redirectsInRule);
    // A matching stop rule terminates that path. Only the non-matching
    // path can reach later rules, so its redirects do not accumulate.
    if (!rule.stopProcessing) redirectsOnContinuingPath += redirectsInRule;
  }

  if (maximumRedirects > limit) {
    throw new RuleValidationError(
      `The rules can redirect ${maximumRedirects} messages in one evaluation; the server limit is ${limit}.`,
    );
  }
}

export function uniqueManagedScriptName(existingNames: Iterable<string | null | undefined>): string {
  const names = new Set([...existingNames].filter((name): name is string => Boolean(name)));
  if (!names.has(MANAGED_SCRIPT_NAME)) return MANAGED_SCRIPT_NAME;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${MANAGED_SCRIPT_NAME} ${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new RuleValidationError('Could not choose a unique managed script name.');
}

function normalizeCondition(
  input: unknown,
  ruleName: string,
  index: number,
  seenIds: Set<string>,
): MailRuleCondition {
  if (!isRecord(input)) {
    throw new RuleValidationError(`Condition ${index + 1} in “${ruleName}” is malformed.`);
  }
  const field = ['from', 'to', 'toCc', 'subject', 'header'].includes(String(input.field))
    ? input.field as RuleField
    : null;
  const operator = ['is', 'contains', 'matches'].includes(String(input.operator))
    ? input.operator as RuleOperator
    : null;
  if (!field || !operator) {
    throw new RuleValidationError(`Condition ${index + 1} in “${ruleName}” is not supported.`);
  }
  const value = requiredText(
    input.value,
    `Condition ${index + 1} in “${ruleName}” needs a value.`,
  );
  rejectControlCharacters(value, `Condition ${index + 1} in “${ruleName}”`);
  const condition: MailRuleCondition = {
    id: requiredId(input.id, `Condition ${index + 1} in “${ruleName}”`, seenIds),
    field,
    operator,
    value,
  };
  if (field === 'header') {
    const headerName = requiredText(
      input.headerName,
      `Custom header condition ${index + 1} in “${ruleName}” needs a header name.`,
    );
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)) {
      throw new RuleValidationError(`“${headerName}” is not a valid header field name.`);
    }
    condition.headerName = headerName;
  }
  return condition;
}

function normalizeAction(
  input: unknown,
  ruleName: string,
  index: number,
  seenIds: Set<string>,
): MailRuleAction {
  if (!isRecord(input)) {
    throw new RuleValidationError(`Action ${index + 1} in “${ruleName}” is malformed.`);
  }
  const id = requiredId(input.id, `Action ${index + 1} in “${ruleName}”`, seenIds);
  switch (input.type) {
    case 'move': {
      const mailboxId = requiredText(
        input.mailboxId,
        `Move action ${index + 1} in “${ruleName}” needs a folder.`,
      );
      const mailboxName = requiredText(
        input.mailboxName,
        `Move action ${index + 1} in “${ruleName}” needs a folder fallback name.`,
      );
      rejectControlCharacters(mailboxId, `Move action ${index + 1} in “${ruleName}”`);
      rejectControlCharacters(mailboxName, `Move action ${index + 1} in “${ruleName}”`);
      return { id, type: 'move', mailboxId, mailboxName };
    }
    case 'redirect': {
      const address = requiredText(
        input.address,
        `Forward action ${index + 1} in “${ruleName}” needs an email address.`,
      );
      rejectControlCharacters(address, `Forward action ${index + 1} in “${ruleName}”`);
      if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
        throw new RuleValidationError(`“${address}” is not a valid forwarding address.`);
      }
      return { id, type: 'redirect', address };
    }
    case 'markRead':
    case 'star':
    case 'discard':
      return { id, type: input.type };
    default:
      throw new RuleValidationError(`Action ${index + 1} in “${ruleName}” is not supported.`);
  }
}

function compileRuleTest(rule: MailRule): string {
  const tests = rule.conditions.map(compileCondition);
  if (tests.length === 1) return tests[0];
  const keyword = rule.match === 'all' ? 'allof' : 'anyof';
  return `${keyword} (${tests.join(', ')})`;
}

function compileCondition(condition: MailRuleCondition): string {
  const match = `:${condition.operator}`;
  const value = sieveString(condition.value);
  switch (condition.field) {
    case 'from':
      return `address ${match} "From" ${value}`;
    case 'to':
      return `address ${match} "To" ${value}`;
    case 'toCc':
      return `address ${match} ["To", "Cc"] ${value}`;
    case 'subject':
      return `header ${match} "Subject" ${value}`;
    case 'header':
      return `header ${match} ${sieveString(condition.headerName ?? '')} ${value}`;
  }
}

function compileAction(
  action: MailRuleAction,
  extensions: ReadonlySet<string>,
  required: Set<string>,
): string {
  switch (action.type) {
    case 'move':
      requireExtension('fileinto', extensions, required, 'Moving messages');
      if (extensions.has('mailboxid')) {
        required.add('mailboxid');
        // Stalwart currently checks :mailboxid against the RFC 5490 "mailbox"
        // capability as well. Declare it when advertised so its authoritative
        // SieveScript/validate call accepts an otherwise RFC 9042 script.
        if (extensions.has('mailbox')) required.add('mailbox');
        return `fileinto :mailboxid ${sieveString(action.mailboxId)} ${sieveString(action.mailboxName)};`;
      }
      return `fileinto ${sieveString(action.mailboxName)};`;
    case 'markRead':
      requireExtension('imap4flags', extensions, required, 'Marking messages as read');
      return 'addflag "\\\\Seen";';
    case 'star':
      requireExtension('imap4flags', extensions, required, 'Starring messages');
      return 'addflag "\\\\Flagged";';
    case 'redirect':
      requireExtension('copy', extensions, required, 'Forwarding a copy');
      return `redirect :copy ${sieveString(action.address)};`;
    case 'discard':
      return 'discard;';
  }
}

function requireExtension(
  extension: string,
  available: ReadonlySet<string>,
  required: Set<string>,
  action: string,
): void {
  if (!available.has(extension)) {
    throw new RuleValidationError(`${action} requires the server’s “${extension}” Sieve extension.`);
  }
  required.add(extension);
}

function sieveString(value: string): string {
  rejectControlCharacters(value, 'Sieve value');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function requiredText(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuleValidationError(message);
  }
  return value.trim();
}

function requiredId(value: unknown, label: string, seen: Set<string>): string {
  const id = requiredText(value, `${label} needs an identifier.`);
  if (seen.has(id)) throw new RuleValidationError(`${label} has a duplicate identifier.`);
  seen.add(id);
  return id;
}

function rejectControlCharacters(value: string, label: string): void {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    throw new RuleValidationError(`${label} contains a line break or control character.`);
  }
}

function chunkString(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += size) {
    chunks.push(value.slice(offset, offset + size));
  }
  return chunks;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64URL_ALPHABET[a >> 2];
    out += BASE64URL_ALPHABET[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += BASE64URL_ALPHABET[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += BASE64URL_ALPHABET[c & 63];
  }
  return out;
}

function decodeBase64Url(value: string): Uint8Array {
  if (value.length % 4 === 1) throw new Error('invalid base64url length');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const index = BASE64URL_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('invalid base64url character');
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(bytes);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
