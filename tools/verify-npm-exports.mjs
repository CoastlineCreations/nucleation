// Check the WASM binary itself, rather than trusting the generated declarations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_WASM_FEATURES = 'bridge,mc-tick,simulation,meshing,voxelize';

const simulationModules = [
  'MchprsWorld', 'CircuitBuilder', 'TypedCircuitExecutor', 'IoLayoutBuilder',
  'IoLayout', 'IoType', 'LayoutFunction', 'Value', 'ExecutionMode',
  'OutputCondition', 'SortStrategy', 'RedstoneGraph', 'CellExecutor',
];

export async function verifyNpmExports(packageDirectory, features = DEFAULT_WASM_FEATURES) {
  const directory = resolve(packageDirectory);
  const enabled = new Set(features.split(/[ ,]+/).filter(Boolean));
  const module = await WebAssembly.compile(await readFile(resolve(directory, 'nucleation.wasm')));
  const exported = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
  const required = new Set([
    'Schematic_create', 'Schematic_set_block', 'Schematic_get_block_name',
    'Schematic_render_regions_json', 'Schematic_region_block_indices', 'Schematic_clear_contents',
  ]);
  if (enabled.has('simulation')) {
    // Cover every operation in the generated simulation surface, including destructors.
    for (const name of simulationModules) {
      const glue = await readFile(resolve(directory, `${name}.mjs`), 'utf8');
      for (const match of glue.matchAll(/\bwasm\.([A-Za-z_][A-Za-z_0-9]*)\s*\(/g)) {
        required.add(match[1]);
      }
    }
  }
  if (enabled.has('mc-tick')) required.add('TickSimulation_from_schematic');
  if (enabled.has('meshing')) required.add('MeshConfig_create');
  if (enabled.has('voxelize')) required.add('Voxelizer_shape_from_obj');
  const missing = [...required].filter(name => !exported.has(name));
  assert.equal(missing.length, 0,
    `WASM package does not implement requested features (${features}): ${missing.join(', ')}`);
  return { requiredExports: required.size, totalExports: exported.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ?? 'dist/npm';
  const features = process.argv[3] ?? DEFAULT_WASM_FEATURES;
  const result = await verifyNpmExports(directory, features);
  console.log(`WASM exports verified (${result.requiredExports} required / ${result.totalExports} total): ${directory}`);
}
