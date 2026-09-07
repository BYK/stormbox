import { describe, expect, it } from 'vitest';

import {
  compileRules,
  isManagedRulesScript,
  MANAGED_SCRIPT_MARKER,
  parseManagedRules,
  RuleValidationError,
  uniqueManagedScriptName,
} from '../../../src/sieve/rules';
import type { MailRuleDocument, SieveRuleCapabilities } from '../../../src/sieve/rules';

const ALL_CAPABILITIES: SieveRuleCapabilities = {
  sieveExtensions: ['copy', 'fileinto', 'imap4flags', 'mailbox', 'mailboxid'],
  maxSizeScript: 100_000,
  maxNumberRedirects: 4,
};

function document(): MailRuleDocument {
  return {
    version: 1,
    rules: [{
      id: 'rule-1',
      name: 'File important mail',
      enabled: true,
      match: 'all',
      conditions: [
        {
          id: 'condition-1', field: 'from', operator: 'contains', value: '@example.com',
        },
        {
          id: 'condition-2', field: 'subject', operator: 'matches', value: '*invoice*',
        },
      ],
      actions: [
        {
          id: 'action-1', type: 'move', mailboxId: 'mailbox-42', mailboxName: 'Finance/Invoices',
        },
        { id: 'action-2', type: 'markRead' },
        { id: 'action-3', type: 'star' },
        { id: 'action-4', type: 'redirect', address: 'archive@example.net' },
      ],
      stopProcessing: true,
    }],
  };
}

describe('mail-rule Sieve compiler', () => {
  it('emits a capability-aware script and round-trips the visual model', () => {
    const input = document();
    const source = compileRules(input, ALL_CAPABILITIES);

    expect(source).toContain(MANAGED_SCRIPT_MARKER);
    expect(source).toContain('require ["copy", "fileinto", "imap4flags", "mailbox", "mailboxid"];');
    expect(source).toContain('if allof (address :contains "From" "@example.com", header :matches "Subject" "*invoice*") {');
    expect(source).toContain('fileinto :mailboxid "mailbox-42" "Finance/Invoices";');
    expect(source).toContain('addflag "\\\\Seen";');
    expect(source).toContain('addflag "\\\\Flagged";');
    expect(source).toContain('redirect :copy "archive@example.net";');
    expect(source).toContain('  stop;');
    expect(isManagedRulesScript(source)).toBe(true);
    expect(parseManagedRules(source)).toEqual(input);
  });

  it('escapes user strings and omits disabled rules from executable code', () => {
    const input = document();
    input.rules[0].conditions = [{
      id: 'condition-escape',
      field: 'subject',
      operator: 'contains',
      value: 'say "hi" \\ there',
    }];
    input.rules.push({
      id: 'rule-disabled',
      name: 'Disabled executable marker',
      enabled: false,
      match: 'all',
      conditions: [{
        id: 'condition-disabled', field: 'subject', operator: 'is', value: 'DO-NOT-EMIT',
      }],
      actions: [{ id: 'action-disabled', type: 'discard' }],
      stopProcessing: true,
    });

    const source = compileRules(input, ALL_CAPABILITIES);
    expect(source).toContain('header :contains "Subject" "say \\"hi\\" \\\\ there"');
    expect(source).not.toContain('# Rule: Disabled executable marker');
    expect(parseManagedRules(source)?.rules[1].conditions[0].value).toBe('DO-NOT-EMIT');
  });

  it('uses a path-only fallback when mailboxid is unavailable', () => {
    const source = compileRules(document(), {
      ...ALL_CAPABILITIES,
      sieveExtensions: ['copy', 'fileinto', 'imap4flags'],
    });
    expect(source).toContain('fileinto "Finance/Invoices";');
    expect(source).not.toContain(':mailboxid');
  });

  it('declares Stalwart’s advertised mailbox compatibility capability for mailboxid', () => {
    const input = document();
    input.rules[0].actions = [input.rules[0].actions[0]];

    const source = compileRules(input, {
      ...ALL_CAPABILITIES,
      sieveExtensions: ['fileinto', 'mailbox', 'mailboxid'],
    });
    expect(source).toContain('require ["fileinto", "mailbox", "mailboxid"];');

    const standardsOnlySource = compileRules(input, {
      ...ALL_CAPABILITIES,
      sieveExtensions: ['fileinto', 'mailboxid'],
    });
    expect(standardsOnlySource).toContain('require ["fileinto", "mailboxid"];');
    expect(standardsOnlySource).not.toContain('"mailbox",');
  });

  it('rejects missing action extensions, invalid headers, and oversized scripts', () => {
    expect(() => compileRules(document(), { sieveExtensions: [] }))
      .toThrow(/fileinto/);

    const invalidHeader = document();
    invalidHeader.rules[0].conditions = [{
      id: 'condition-header',
      field: 'header',
      headerName: 'Bad:Header',
      operator: 'contains',
      value: 'x',
    }];
    expect(() => compileRules(invalidHeader, ALL_CAPABILITIES))
      .toThrow(RuleValidationError);

    expect(() => compileRules(document(), {
      ...ALL_CAPABILITIES,
      maxSizeScript: 10,
    })).toThrow(/server limit is 10/);
  });

  it('checks redirect limits along executable paths', () => {
    const input = document();
    input.rules[0].actions = [{
      id: 'redirect-1', type: 'redirect', address: 'one@example.net',
    }];
    input.rules.push({
      id: 'rule-2',
      name: 'Second redirect',
      enabled: true,
      match: 'all',
      conditions: [{
        id: 'condition-2a', field: 'subject', operator: 'contains', value: 'two',
      }],
      actions: [{ id: 'redirect-2', type: 'redirect', address: 'two@example.net' }],
      stopProcessing: false,
    });

    expect(() => compileRules(input, { ...ALL_CAPABILITIES, maxNumberRedirects: 1 }))
      .not.toThrow();

    input.rules[0].stopProcessing = false;
    expect(() => compileRules(input, { ...ALL_CAPABILITIES, maxNumberRedirects: 1 }))
      .toThrow(/can redirect 2 messages/);
  });

  it('rejects corrupt managed metadata without claiming foreign scripts', () => {
    expect(parseManagedRules('require ["fileinto"];\r\nkeep;')).toBeNull();
    expect(() => parseManagedRules(`${MANAGED_SCRIPT_MARKER}\r\n# stormbox-data: !!!`))
      .toThrow(/metadata is missing or malformed/);
  });

  it('chooses a non-conflicting managed script name', () => {
    expect(uniqueManagedScriptName(['Personal filters'])).toBe('Stormbox Mail Rules');
    expect(uniqueManagedScriptName(['Stormbox Mail Rules', 'Stormbox Mail Rules 2']))
      .toBe('Stormbox Mail Rules 3');
  });
});
