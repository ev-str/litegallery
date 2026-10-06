import {cp, mkdir, rm} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';
import {tmpdir} from 'node:os';

const requestedRoot = process.argv[2];
if (!requestedRoot) throw new Error('Pass an OS-temporary fixture directory as the first argument');
const root = resolve(requestedRoot);
const relativeToTemp = relative(resolve(tmpdir()), root);
if (!relativeToTemp || relativeToTemp.startsWith('..') || isAbsolute(relativeToTemp)) {
  throw new Error(`Fixture directory must be inside the OS temp directory: ${root}`);
}

await rm(root, {recursive: true, force: true});
await mkdir(root, {recursive: true});
await cp(resolve('tests/e2e/demo-assets'), root, {recursive: true});
