import { serialize } from './syntax.mjs';

const token = (value, quoted = false) => ({ value, quoted });
const field = (name, value) => ({ head: [token(name), token(value, true)], children: null });
const windowsDevice = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

function relativeResourcePath(value, label) {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new TypeError(`${label} must be a nonempty relative resource path of at most 1024 characters.`);
  const normalized = value.replaceAll('\\', '/');
  if (/[\x00-\x1f\x7f<>:"|?*{}]/.test(normalized)) throw new TypeError(`${label} contains unsupported path characters or an embedded resource GUID.`);
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.length > 255 || segment !== segment.trim() || segment.endsWith('.') || windowsDevice.test(segment)) {
      throw new TypeError(`${label} contains an absolute, empty, traversal, ambiguous or reserved path segment.`);
    }
  }
  return normalized;
}

/**
 * Emit only the observed TXAResourceClass metadata for a native .anm import.
 * SourceFile names a .txa in the same directory as the resulting .anm.meta.
 * The caller owns GUID uniqueness, filesystem containment, source provenance,
 * a separate Workbench project, skeleton registration and the actual import.
 * This pure generator neither compiles an ANM nor declares it validated.
 */
export function generateTxaImportMeta({ resourcePath, guid, sourceFile } = {}) {
  const target = relativeResourcePath(resourcePath, 'resourcePath');
  const basename = target.split('/').at(-1);
  if (!/^.+\.anm$/i.test(basename)) throw new TypeError('resourcePath must identify a named .anm resource, not a .txa or .meta file.');
  if (typeof guid !== 'string' || !/^[a-f0-9]{16}$/i.test(guid)) throw new TypeError('guid must contain exactly 16 hexadecimal digits without braces.');

  const source = relativeResourcePath(sourceFile ?? `${basename.slice(0, -4)}.txa`, 'sourceFile');
  if (source.includes('/') || !/^.+\.txa$/i.test(source)) throw new TypeError('sourceFile must be a .txa basename in the metadata directory.');

  const configurations = ['PC', 'XBOX_ONE', 'PS4', 'LINUX'].map(platform => ({
    head: [token('TXAResourceClass'), token(platform), ...(platform === 'PC' ? [] : [token(':'), token('PC')])],
    children: platform === 'PC' ? [field('SourceFile', source)] : [],
  }));
  return serialize([{
    head: [token('MetaFileClass')],
    children: [
      field('Name', `{${guid.toUpperCase()}}${target}`),
      { head: [token('Configurations')], children: configurations },
    ],
  }]);
}
