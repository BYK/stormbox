import {
  compileRules,
  emptyRuleDocument,
  isManagedRulesScript,
  MANAGED_SCRIPT_NAME,
  normalizeRuleDocument,
  parseManagedRules,
  RuleValidationError,
  SIEVE_CAPABILITY,
  uniqueManagedScriptName,
} from '../../../sieve/rules';
import type { MailRuleDocument, SieveRuleCapabilities } from '../../../sieve/rules';
import { JMAP_CAPS } from './transport';
import { callJmap, pickResponse, requireResponse } from './invoke';

interface SieveScriptRecord {
  id: string;
  name: string | null;
  blobId: string;
  isActive: boolean;
}

export interface MailRulesSnapshot {
  supported: boolean;
  accountId: string | null;
  state: string | null;
  capabilities: SieveRuleCapabilities;
  scripts: Array<{ id: string; name: string | null; isActive: boolean }>;
  managedScript: { id: string; name: string | null; isActive: boolean } | null;
  foreignActiveScript: { id: string; name: string | null } | null;
  document: MailRuleDocument;
  parseError: string | null;
}

interface SieveContext {
  accountId: string;
  capabilities: SieveRuleCapabilities;
}

export async function getMailRules({
  transport,
  account,
  useWebSocket = false,
}: {
  transport: any;
  account: { remote_account_id: string };
  useWebSocket?: boolean;
}): Promise<MailRulesSnapshot> {
  const context = await sieveContext(transport, account);
  if (!context) return unsupportedSnapshot();

  const raw = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.SIEVE],
    methodCalls: [['SieveScript/get', {
      accountId: context.accountId,
      ids: null,
      properties: ['id', 'name', 'blobId', 'isActive'],
    }, 'sieve-get']],
    useWebSocket,
  });
  const response = requireResponse(raw, 'SieveScript/get');
  const scripts = normalizeScriptList(response.list);
  const managed: Array<{ script: SieveScriptRecord; document: MailRuleDocument }> = [];
  const malformedManaged: string[] = [];

  for (const script of scripts) {
    const bytes = await transport.download({
      accountId: context.accountId,
      blobId: script.blobId,
      type: 'application/sieve',
      name: `${script.name || 'script'}.siv`,
    });
    const source = new TextDecoder().decode(bytes);
    if (!isManagedRulesScript(source)) continue;
    try {
      const document = parseManagedRules(source);
      if (document) managed.push({ script, document });
    } catch (error) {
      malformedManaged.push(errorMessage(error));
    }
  }

  let parseError: string | null = null;
  if (malformedManaged.length > 0) {
    parseError = malformedManaged[0];
  } else if (managed.length > 1) {
    parseError = 'More than one Stormbox-managed rule script exists. Resolve the duplicate scripts before saving.';
  }
  const selected = managed.find((entry) => entry.script.isActive) ?? managed[0] ?? null;
  const active = scripts.find((script) => script.isActive) ?? null;
  const foreignActive = active && active.id !== selected?.script.id ? active : null;

  return {
    supported: true,
    accountId: context.accountId,
    state: typeof response.state === 'string' ? response.state : null,
    capabilities: context.capabilities,
    scripts: scripts.map(publicScript),
    managedScript: selected ? publicScript(selected.script) : null,
    foreignActiveScript: foreignActive
      ? { id: foreignActive.id, name: foreignActive.name }
      : null,
    document: selected?.document ?? emptyRuleDocument(),
    parseError,
  };
}

export async function runSetSieveRules({
  transport,
  account,
  request,
  useWebSocket = false,
}: {
  transport: any;
  account: { remote_account_id: string };
  request: any;
  useWebSocket?: boolean;
}): Promise<{ ok: boolean; error?: any; result?: any; response?: any }> {
  let document: MailRuleDocument;
  try {
    document = normalizeRuleDocument(request?.document);
  } catch (error) {
    return terminalError('invalidRules', errorMessage(error));
  }

  let snapshot: MailRulesSnapshot;
  try {
    snapshot = await getMailRules({ transport, account, useWebSocket });
  } catch (error) {
    return { ok: false, error: { type: 'transport', message: errorMessage(error) } };
  }
  if (!snapshot.supported || !snapshot.accountId) {
    return terminalError('sieveUnsupported', 'This account does not advertise JMAP for Sieve.');
  }
  if (snapshot.parseError) {
    return terminalError('managedScriptUnreadable', snapshot.parseError);
  }
  if (typeof request?.expectedState === 'string' && request.expectedState !== snapshot.state) {
    return terminalError(
      'sieveStateMismatch',
      'The server’s Sieve scripts changed after this editor loaded. Reload before saving.',
    );
  }
  if (snapshot.foreignActiveScript && request?.takeover !== true) {
    return terminalError(
      'foreignScriptActive',
      'Another Sieve script is active. Explicit confirmation is required before Stormbox activates its script.',
      { foreignActiveScript: snapshot.foreignActiveScript },
    );
  }

  let source: string;
  try {
    source = compileRules(document, snapshot.capabilities);
  } catch (error) {
    return terminalError('invalidRules', errorMessage(error));
  }

  let upload;
  try {
    upload = await transport.upload({
      accountId: snapshot.accountId,
      type: 'application/sieve',
      body: new TextEncoder().encode(source),
    });
  } catch (error) {
    return { ok: false, error: { type: 'transport', message: errorMessage(error) } };
  }
  if (!upload?.blobId) {
    return { ok: false, error: { type: 'noResponse', message: 'The Sieve upload returned no blob id.' } };
  }

  let validationRaw;
  try {
    validationRaw = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.SIEVE],
      methodCalls: [['SieveScript/validate', {
        accountId: snapshot.accountId,
        blobId: upload.blobId,
      }, 'sieve-validate']],
      useWebSocket,
    });
  } catch (error) {
    return { ok: false, error: { type: 'transport', message: errorMessage(error) } };
  }
  const validation = pickResponse(validationRaw, 'SieveScript/validate');
  if (!validation) {
    return methodFailure(validationRaw, 'SieveScript/validate');
  }
  if (validation.error) {
    return terminalError(
      'invalidSieve',
      validation.error.description ?? 'The server rejected the generated Sieve script.',
      { validationError: validation.error },
    );
  }

  const managed = snapshot.managedScript;
  const creationId = 'stormbox';
  const setRequest: any = {
    accountId: snapshot.accountId,
  };
  if (typeof snapshot.state === 'string') setRequest.ifInState = snapshot.state;
  if (managed) {
    setRequest.update = { [managed.id]: { blobId: upload.blobId } };
    setRequest.onSuccessActivateScript = managed.id;
  } else {
    setRequest.create = {
      [creationId]: {
        name: uniqueManagedScriptName(snapshot.scripts.map((script) => script.name)),
        blobId: upload.blobId,
      },
    };
    setRequest.onSuccessActivateScript = `#${creationId}`;
  }

  let setRaw;
  try {
    setRaw = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.SIEVE],
      methodCalls: [['SieveScript/set', setRequest, 'sieve-set']],
      useWebSocket,
    });
  } catch (error) {
    return { ok: false, error: { type: 'transport', message: errorMessage(error) } };
  }
  const setResponse = pickResponse(setRaw, 'SieveScript/set');
  if (!setResponse) return methodFailure(setRaw, 'SieveScript/set');

  const setError = managed
    ? setResponse.notUpdated?.[managed.id]
    : setResponse.notCreated?.[creationId];
  if (setError) {
    const type = setError.type === 'stateMismatch' ? 'sieveStateMismatch' : (setError.type ?? 'sieveSetFailed');
    return terminalError(type, setError.description ?? 'The server did not save the Sieve script.', {
      setError,
    });
  }

  const scriptId = managed?.id ?? setResponse.created?.[creationId]?.id ?? null;
  if (!scriptId) {
    return { ok: false, error: { type: 'noResponse', message: 'The server did not report the saved script.' } };
  }
  return {
    ok: true,
    response: setRaw,
    result: {
      scriptId,
      state: setResponse.newState ?? snapshot.state,
    },
  };
}

async function sieveContext(
  transport: any,
  account: { remote_account_id: string },
): Promise<SieveContext | null> {
  const session = transport.session ?? await transport.fetchSession();
  if (!session?.capabilities?.[SIEVE_CAPABILITY]) return null;
  const accountId = session.primaryAccounts?.[SIEVE_CAPABILITY]
    ?? account.remote_account_id;
  const accountCapability = session.accounts?.[accountId]?.accountCapabilities?.[SIEVE_CAPABILITY];
  if (!accountCapability) return null;
  return {
    accountId,
    capabilities: {
      sieveExtensions: Array.isArray(accountCapability.sieveExtensions)
        ? accountCapability.sieveExtensions.filter((item) => typeof item === 'string')
        : [],
      maxSizeScript: finiteOrNull(accountCapability.maxSizeScript),
      maxNumberRedirects: finiteOrNull(accountCapability.maxNumberRedirects),
    },
  };
}

function normalizeScriptList(value: unknown): SieveScriptRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((script) => {
    if (
      !isRecord(script)
      || typeof script.id !== 'string'
      || typeof script.blobId !== 'string'
    ) return [];
    return [{
      id: script.id,
      name: typeof script.name === 'string' ? script.name : null,
      blobId: script.blobId,
      isActive: script.isActive === true,
    }];
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publicScript(script: SieveScriptRecord) {
  return { id: script.id, name: script.name, isActive: script.isActive };
}

function unsupportedSnapshot(): MailRulesSnapshot {
  return {
    supported: false,
    accountId: null,
    state: null,
    capabilities: { sieveExtensions: [] },
    scripts: [],
    managedScript: null,
    foreignActiveScript: null,
    document: emptyRuleDocument(),
    parseError: null,
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function methodFailure(raw: any, method: string) {
  const failure = pickResponse(raw, 'error');
  const serverType = failure?.type ?? 'noResponse';
  const type = serverType === 'stateMismatch' ? 'sieveStateMismatch' : serverType;
  const message = failure?.description ?? `${method} returned no response.`;
  if (serverType === 'stateMismatch' || serverType === 'invalidArguments') {
    return terminalError(type, message, { methodError: failure ?? null });
  }
  return { ok: false, error: { type, message, methodError: failure ?? null } };
}

function terminalError(type: string, message: string, result?: any) {
  return {
    ok: false,
    error: {
      type,
      message,
      terminal: true,
      ...(result === undefined ? {} : { result }),
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof RuleValidationError || error instanceof Error) return error.message;
  return String(error);
}
