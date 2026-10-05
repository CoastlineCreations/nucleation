// Test the distributable archive, including files selected by package.json's `files` list.
// Usage: node tools/test-npm-package.mjs <package-directory|archive.tgz> [--with-renderer]
//        node tools/test-npm-package.mjs <renderer-package-directory> --features bridge
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_WASM_FEATURES, verifyNpmExports } from './verify-npm-exports.mjs';

const toolsDirectory = dirname(fileURLToPath(import.meta.url));
const arguments_ = process.argv.slice(2);
const input = resolve(arguments_[0] ?? 'dist/npm');
const featuresIndex = arguments_.indexOf('--features');
const features = featuresIndex < 0 ? DEFAULT_WASM_FEATURES : arguments_[featuresIndex + 1];
assert(features, '--features requires a comma-separated feature list');
const withRenderer = arguments_.includes('--with-renderer');
const enabled = new Set(features.split(/[ ,]+/).filter(Boolean));
const temporary = await mkdtemp(resolve(tmpdir(), 'nucleation-npm-smoke-'));

function testSimulation(api) {
  const schematic = api.Schematic.create('packaged-simulation-test');
  for (let x = 0; x < 3; x++) schematic.setBlock(x, 0, 0, 'minecraft:stone');
  schematic.setBlock(0, 1, 0, 'minecraft:lever[face=floor,facing=east,powered=false]');
  schematic.setBlock(1, 1, 0, 'minecraft:redstone_wire[power=0,east=side,west=side,north=none,south=none]');
  schematic.setBlock(2, 1, 0, 'minecraft:redstone_lamp[lit=false]');

  const world = api.MchprsWorld.create(schematic);
  assert.equal(world.getLeverPower(0, 1, 0), false);
  world.onUseBlock(0, 1, 0);
  world.tick(4);
  world.flush();
  assert.equal(world.getLeverPower(0, 1, 0), true);
  assert.equal(world.isLit(2, 1, 0), true, 'MCHPRS must propagate lever power to the lamp');

  const builder = api.CircuitBuilder.create(schematic);
  builder.withInputAuto('switch', api.IoType.boolean(), [0, 1, 0]);
  builder.withOutputAuto('lamp', api.IoType.boolean(), [2, 1, 0]);
  const executor = builder.buildValidated();
  const execute = value => JSON.parse(executor.execute(
    JSON.stringify({ switch: { type: 'bool', value } }), api.ExecutionMode.fixedTicks(8),
  ));
  assert.equal(execute(true).outputs.lamp.value, true);
  assert.equal(execute(false).outputs.lamp.value, false);
  const synced = executor.syncToSchematic();
  assert.match(synced.getBlockString(2, 1, 0), /lit=false/);
  assert.deepEqual(JSON.parse(executor.inputNamesJson()), ['switch']);
  assert.deepEqual(JSON.parse(executor.outputNamesJson()), ['lamp']);
  console.log('Packed npm simulation: MCHPRS propagation, typed circuit on/off and schematic sync passed');
}

async function testEntry(directory, requestedFeatures) {
  const result = await verifyNpmExports(directory, requestedFeatures);
  const api = await import(pathToFileURL(resolve(directory, 'index.mjs')).href);
  if (requestedFeatures.split(/[ ,]+/).includes('simulation')) testSimulation(api);
  // The existing typed-stream test covers block-state properties, negative coordinates,
  // window bounds, owned buffers surviving WASM growth, clearContents and round trips.
  execFileSync(process.execPath, [resolve(toolsDirectory, 'test-render-stream.mjs'),
    resolve(directory, 'index.mjs')], { stdio: 'inherit' });
  console.log(`Packed entry verified: ${directory} (${result.requiredExports} required exports)`);
  return api;
}

try {
  let archive = input;
  if (!input.endsWith('.tgz')) {
    const output = execFileSync('npm', ['pack', input, '--json', '--ignore-scripts',
      '--pack-destination', temporary, '--cache', resolve(temporary, 'npm-cache')], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    });
    const [packed] = JSON.parse(output);
    assert(packed?.filename && basename(packed.filename) === packed.filename, 'Unexpected npm pack filename');
    archive = resolve(temporary, packed.filename);
  }
  const unpacked = resolve(temporary, 'unpacked');
  await mkdir(unpacked);
  execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
  const directory = resolve(unpacked, 'package');
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  await access(resolve(directory, manifest.exports['.'].types));
  await access(resolve(directory, manifest.exports['.'].default));
  await testEntry(directory, features);
  if (withRenderer) {
    assert(manifest.exports['./renderer'], 'The package must export its renderer-only entry');
    const rendererEntry = resolve(directory, manifest.exports['./renderer'].default);
    await access(resolve(directory, manifest.exports['./renderer'].types));
    await testEntry(dirname(rendererEntry), 'bridge');
  }
  // A core-only custom build should remain supported without claiming simulation.
  assert(enabled.has('bridge'), 'An npm package must include the bridge feature');
  console.log(`npm archive passed: ${basename(archive)}${withRenderer ? ' (main + renderer)' : ''}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
