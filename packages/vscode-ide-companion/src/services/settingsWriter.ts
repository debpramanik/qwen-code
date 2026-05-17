/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Settings writer for VSCode extension.
 * Handles bidirectional sync between VSCode Settings and ~/.qwen/settings.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuthType, Storage } from '@qwen-code/qwen-code-core';
import {
  CodingPlanRegion,
  SUBSCRIPTION_PLAN_OPTIONS,
  type SubscriptionPlanConfig,
  findSubscriptionPlanByConfig,
  getSubscriptionPlanConfig,
  isSubscriptionPlanConfig,
} from './subscriptionPlanDefinitions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Model providers as key-value map: modelId → baseUrl.
 * This is the format VSCode Settings UI can render as an editable table.
 */
export type VSCodeModelProviders = Record<string, string>;

/**
 * Values extracted from ~/.qwen/settings.json for populating VSCode Settings.
 */
export interface QwenSettingsForVSCode {
  provider: 'coding-plan' | 'token-plan' | 'api-key';
  apiKey: string;
  codingPlanRegion?: 'china' | 'global';
}

const SUBSCRIPTION_PROVIDER_METADATA_KEY_BY_PLAN_ID = {
  coding: 'coding-plan',
  token: 'token-plan',
} as const satisfies Record<SubscriptionPlanConfig['id'], string>;

type SubscriptionProviderMetadataKey =
  (typeof SUBSCRIPTION_PROVIDER_METADATA_KEY_BY_PLAN_ID)[keyof typeof SUBSCRIPTION_PROVIDER_METADATA_KEY_BY_PLAN_ID];

const SUBSCRIPTION_PROVIDER_METADATA_KEYS = Object.values(
  SUBSCRIPTION_PROVIDER_METADATA_KEY_BY_PLAN_ID,
) as SubscriptionProviderMetadataKey[];

const API_KEY_ENV_KEY = 'OPENAI_API_KEY';

function getSubscriptionProviderMetadataKey(
  planId: SubscriptionPlanConfig['id'],
): SubscriptionProviderMetadataKey {
  return SUBSCRIPTION_PROVIDER_METADATA_KEY_BY_PLAN_ID[planId];
}

// ---------------------------------------------------------------------------
// Low-level read/write helpers
// ---------------------------------------------------------------------------

/**
 * Read ~/.qwen/settings.json. Returns {} if missing or invalid.
 */
function readSettings(): Record<string, unknown> {
  try {
    const content = fs.readFileSync(Storage.getGlobalSettingsPath(), 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Write ~/.qwen/settings.json (creates dir if needed).
 */
function writeSettings(settings: Record<string, unknown>): void {
  const settingsPath = Storage.getGlobalSettingsPath();
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Ensure nested objects exist at the given key path.
 */
function ensureNestedObject(
  obj: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  let current = obj;
  for (const key of keys) {
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  return current;
}

/**
 * Find OpenAI-compatible model entries from modelProviders.
 * CLI uses AuthType.USE_OPENAI ('openai') as the key, but some legacy
 * configs may use other keys. Check both.
 */
function findOpenaiModels(
  modelProviders: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> {
  if (!modelProviders) {
    return [];
  }
  for (const key of [AuthType.USE_OPENAI, 'use_openai']) {
    const arr = modelProviders[key];
    if (Array.isArray(arr) && arr.length > 0) {
      return arr as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function clearInactiveSubscriptionPlanState(
  settings: Record<string, unknown>,
  active: {
    envKey: string;
    legacyMetadataKey: string;
    providerMetadataKey: SubscriptionProviderMetadataKey;
  },
): void {
  const env = settings.env as Record<string, unknown> | undefined;
  if (env) {
    for (const plan of SUBSCRIPTION_PLAN_OPTIONS) {
      if (plan.envKey !== active.envKey) {
        delete env[plan.envKey];
      }
    }
    delete env[API_KEY_ENV_KEY];
  }

  for (const plan of SUBSCRIPTION_PLAN_OPTIONS) {
    if (plan.metadataKey !== active.legacyMetadataKey) {
      delete settings[plan.metadataKey];
    }
  }

  const providerMetadata = settings.providerMetadata as
    | Record<string, unknown>
    | undefined;
  if (providerMetadata) {
    for (const key of SUBSCRIPTION_PROVIDER_METADATA_KEYS) {
      if (key !== active.providerMetadataKey) {
        delete providerMetadata[key];
      }
    }
  }
}

function writeSubscriptionPlanConfig(params: {
  apiKey: string;
  planConfig: SubscriptionPlanConfig;
  providerMetadataKey: SubscriptionProviderMetadataKey;
  metadata?: Record<string, unknown>;
}): void {
  const { apiKey, planConfig, providerMetadataKey, metadata = {} } = params;
  const settings = readSettings();

  const auth = ensureNestedObject(settings, 'security', 'auth');
  auth.selectedType = AuthType.USE_OPENAI;

  const env = ensureNestedObject(settings, 'env');
  env[planConfig.envKey] = apiKey;
  clearInactiveSubscriptionPlanState(settings, {
    envKey: planConfig.envKey,
    legacyMetadataKey: planConfig.metadataKey,
    providerMetadataKey,
  });

  const providers = ensureNestedObject(settings, 'modelProviders');
  const existing = findOpenaiModels(
    settings.modelProviders as Record<string, unknown>,
  );
  const nonSubscriptionPlan = existing.filter(
    (entry) =>
      !isSubscriptionPlanConfig(
        entry.baseUrl as string,
        entry.envKey as string,
      ),
  );
  const planModels = planConfig.template.map((model) => ({
    ...model,
    envKey: planConfig.envKey,
  }));
  providers[AuthType.USE_OPENAI] = [...planModels, ...nonSubscriptionPlan];

  const providerMetadata = ensureNestedObject(settings, 'providerMetadata');
  providerMetadata[providerMetadataKey] = {
    baseUrl: planConfig.baseUrl,
    version: planConfig.version,
    ...metadata,
  };
  delete settings[planConfig.metadataKey];

  const defaultModelId = planConfig.template[0]?.id ?? 'qwen3.5-plus';
  settings.model = { name: defaultModelId };

  writeSettings(settings);
}

// ---------------------------------------------------------------------------
// Write: VSCode Settings → ~/.qwen/settings.json
// ---------------------------------------------------------------------------

/**
 * Write Coding Plan configuration to ~/.qwen/settings.json.
 * Auto-injects model providers from the regional template,
 * preserving any existing non-Coding-Plan entries.
 */
export function writeCodingPlanConfig(
  region: 'china' | 'global',
  apiKey: string,
): void {
  const codingRegion =
    region === 'global' ? CodingPlanRegion.GLOBAL : CodingPlanRegion.CHINA;
  const planConfig = getSubscriptionPlanConfig('coding', codingRegion);

  writeSubscriptionPlanConfig({
    apiKey,
    planConfig,
    providerMetadataKey: getSubscriptionProviderMetadataKey(planConfig.id),
    metadata: { region: codingRegion },
  });
}

/**
 * Write Token Plan configuration to ~/.qwen/settings.json.
 * Auto-injects model providers from the token plan template,
 * preserving any existing non-Token-Plan entries.
 */
export function writeTokenPlanConfig(apiKey: string): void {
  const planConfig = getSubscriptionPlanConfig('token');

  writeSubscriptionPlanConfig({
    apiKey,
    planConfig,
    providerMetadataKey: getSubscriptionProviderMetadataKey(planConfig.id),
  });
}

/**
 * Write model providers from VSCode Settings (key-value map) to ~/.qwen/settings.json.
 * Used when provider = "api-key" and user edits the modelProviders map.
 *
 * @param params.apiKey - The API key
 * @param params.modelProviders - Map of modelId → baseUrl
 * @param params.activeModel - Currently selected model ID
 */
export function writeModelProvidersConfig(params: {
  apiKey: string;
  modelProviders: VSCodeModelProviders;
  activeModel: string;
}): void {
  const settings = readSettings();

  // Auth
  const auth = ensureNestedObject(settings, 'security', 'auth');
  auth.selectedType = AuthType.USE_OPENAI;

  // API key
  const env = ensureNestedObject(settings, 'env');
  env[API_KEY_ENV_KEY] = params.apiKey;
  for (const plan of SUBSCRIPTION_PLAN_OPTIONS) {
    delete env[plan.envKey];
  }

  // Convert key-value map to CLI's array format and merge with existing
  // non-target entries so reconfiguring one provider doesn't silently
  // delete others (e.g. Coding Plan entries with a different envKey).
  const providers = ensureNestedObject(settings, 'modelProviders');
  const modelArray = Object.entries(params.modelProviders).map(
    ([id, baseUrl]) => ({
      id,
      name: id,
      baseUrl: baseUrl || 'https://api.openai.com/v1',
      envKey: API_KEY_ENV_KEY,
    }),
  );
  const existing = findOpenaiModels(
    settings.modelProviders as Record<string, unknown>,
  );
  const nonTarget = existing.filter((e) => e.envKey !== API_KEY_ENV_KEY);
  providers[AuthType.USE_OPENAI] = [...modelArray, ...nonTarget];

  // Active model
  if (params.activeModel) {
    settings.model = { name: params.activeModel };
  }

  for (const plan of SUBSCRIPTION_PLAN_OPTIONS) {
    delete settings[plan.metadataKey];
  }
  const pm = settings.providerMetadata as Record<string, unknown> | undefined;
  if (pm) {
    for (const key of SUBSCRIPTION_PROVIDER_METADATA_KEYS) {
      delete pm[key];
    }
  }

  writeSettings(settings);
}

// ---------------------------------------------------------------------------
// Read: ~/.qwen/settings.json → VSCode Settings
// ---------------------------------------------------------------------------

/**
 * Read ~/.qwen/settings.json and extract values for VSCode Settings UI.
 * Returns null if no valid configuration found.
 */
export function readQwenSettingsForVSCode(): QwenSettingsForVSCode | null {
  const settings = readSettings();

  const security = settings.security as Record<string, unknown> | undefined;
  const auth = security?.auth as Record<string, unknown> | undefined;
  if (!auth?.selectedType) {
    return null;
  }

  const env = (settings.env ?? {}) as Record<string, string>;
  const modelProviders = settings.modelProviders as
    | Record<string, unknown>
    | undefined;
  const openaiModels = findOpenaiModels(modelProviders);
  const subscriptionPlan = openaiModels
    .map((model) =>
      findSubscriptionPlanByConfig(
        model.baseUrl as string | undefined,
        model.envKey as string | undefined,
      ),
    )
    .find((match) => match !== undefined && !!env[match.plan.envKey]);

  if (subscriptionPlan?.plan.id === 'coding') {
    const region = subscriptionPlan.region === 'global' ? 'global' : 'china';
    return {
      provider: 'coding-plan',
      apiKey: env[subscriptionPlan.plan.envKey] || '',
      codingPlanRegion: region,
    };
  }

  if (subscriptionPlan?.plan.id === 'token') {
    return {
      provider: 'token-plan',
      apiKey: env[subscriptionPlan.plan.envKey] || '',
    };
  }

  // Non-subscription-plan — find API key from model providers
  const firstEnvKey = (openaiModels[0]?.envKey as string) || API_KEY_ENV_KEY;
  const apiKey = env[firstEnvKey] || '';

  if (!apiKey) {
    return null;
  }

  return {
    provider: 'api-key',
    apiKey,
    codingPlanRegion: 'china',
  };
}

/**
 * Clear persisted auth credentials from ~/.qwen/settings.json.
 * Removes API keys, auth type selection, and coding plan metadata
 * so runtime state matches the cleared VS Code settings.
 */
export function clearPersistedAuth(): void {
  try {
    const settings = readSettings();

    // Remove auth type selection
    const security = settings.security as Record<string, unknown> | undefined;
    if (security?.auth) {
      delete (security.auth as Record<string, unknown>).selectedType;
    }

    // Remove API keys
    const env = settings.env as Record<string, unknown> | undefined;
    if (env) {
      for (const plan of SUBSCRIPTION_PLAN_OPTIONS) {
        delete env[plan.envKey];
      }
      delete env[API_KEY_ENV_KEY];
    }

    // Remove subscription plan metadata (legacy + new namespace)
    for (const plan of SUBSCRIPTION_PLAN_OPTIONS) {
      delete settings[plan.metadataKey];
    }
    const pm = settings.providerMetadata as Record<string, unknown> | undefined;
    if (pm) {
      for (const key of SUBSCRIPTION_PROVIDER_METADATA_KEYS) {
        delete pm[key];
      }
    }

    writeSettings(settings);
  } catch (error) {
    console.error(
      '[settingsWriter] Failed to clear persisted auth credentials:',
      error,
    );
  }
}
