import definition from './profiles/blackbird-2.08-motion-v1.json' with { type: 'json' };
import nativeProfile from './profiles/blackbird-2.08-native-1.30.164014.27.json' with { type: 'json' };
import { createNativeImportWorkflow } from './internal/native-import-workflow.mjs';

// Fixed source/control attestations only. No caller-provided profiles, hashes,
// force flags, shell commands or native executable paths are accepted here.
const workflow = createNativeImportWorkflow({ definition, nativeProfile });
export const prepareNativeImport = workflow.prepareNativeImport;
export const verifyNativeImport = workflow.verifyNativeImport;
export const finalizeNativeImport = workflow.finalizeNativeImport;
