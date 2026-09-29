import blackbird from './profiles/blackbird-2.08-motion-v1.json' with { type: 'json' };
import { ROOT_MOTION_PROFILE_ID } from './txa-rootmotion.mjs';
import { AssetProfileError, validateProfileDefinition } from './internal/asset-profile-validation.mjs';

export { AssetProfileError } from './internal/asset-profile-validation.mjs';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
}
if (blackbird.profileId !== ROOT_MOTION_PROFILE_ID) throw new Error('Asset registry and TXA rule identifiers differ');
const profiles = new Map([[blackbird.profileId, freeze(blackbird)]]);

/** The public registry exposes fixed, attested definitions, never injection. */
export function listAssetProfiles() {
  return [...profiles.values()].map(profile => ({
    id: profile.profileId, version: profile.profileVersion,
    name: 'Bounded root-motion profile: twelve movement clips',
    activeAssignmentCount: profile.assignments.length,
    requiredClipCount: profile.assignments.filter(job => job.action === 'transform-root-motion').length,
    experimental: true,
  }));
}

/**
 * Pure original-fingerprint check. Supply inventory entries freshly hashed from
 * the immutable source and qualified {source, resource} ASI assignments.
 * Matching hashes do not replace the TXA structural or native import checks.
 */
export function validateAssetProfile({ profileId, inventory, activeAssignments, ...unknown } = {}) {
  if (Object.keys(unknown).length) throw new AssetProfileError('unknown options; profile overrides and force are not supported', profileId);
  const definition = profiles.get(profileId);
  if (!definition) throw new AssetProfileError(`unknown explicit profile ${JSON.stringify(profileId)}`, profileId);
  return validateProfileDefinition(definition, { inventory, activeAssignments });
}
