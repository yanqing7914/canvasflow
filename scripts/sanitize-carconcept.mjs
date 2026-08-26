#!/usr/bin/env node

/**
 * Produces CanvasFlow's logo-free Car Concept derivative. This is a build-time
 * asset utility; the browser only loads the generated GLB from public/car.
 *
 * Usage:
 *   node scripts/sanitize-carconcept.mjs /path/to/CarConcept.glb output.glb
 *
 * The source SHA-256 is pinned below. A changed upstream source must be audited
 * before this script is updated, rather than silently producing a new asset.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SOURCE_SHA256 = 'c272098089d78c5cd9fd9f24ff50ee8acf8d932c55f2d55fc10adb6c8998966b'

const REMOVED_NODE_NAMES = new Set(['InteriorSteeringEmblem', 'License Plate'])
const FRONT_WHEEL_NODE_NAMES = new Set(['WheelFrontL', 'WheelFrontR'])
const FRONT_WHEEL_STEERING_CORRECTION_RADIANS = Math.PI / 6
const BANNED_IMAGE_HASHES = new Set([
  // Khronos_C.png, Tireside_C.png, and Tireside_N.png in the pinned source.
  '1453559c58526ec236ea7f90a72b0e49823061e6c26b571928b9ea3b91593e4d',
  '8cca97aa2b8f10e63751cda6c3d62efa58fb21fed9dcc2a2649f56a7253bc28d',
  '54297a9940353fdab05356ebd1649d967d0cf316968b15f496903ec00731b2c1',
])
const FORBIDDEN_MARK_STRINGS = [
  // KHR_* extension identifiers are standardized glTF syntax and remain valid.
  // These phrases identify the source's trademark metadata or visible marks.
  'khronos group',
  'khronos logo',
  '3d commerce logo',
  '3dcommerce',
  'connecting software to silicon',
  'license plate',
  'interiorsteeringemblem',
]
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUTPUT = resolve(SCRIPT_DIR, '../apps/demo/public/car/idle-ev-concept.glb')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * The source sample exports both front-wheel parent nodes with a shared 30deg
 * steering yaw. That leaves the parked car looking as if its wheels are turned
 * even though the idle scene has no steering input. Remove only that yaw while
 * preserving each wheel's original side/camber frame and position.
 */
function normalizeFrontWheelMatrices(json) {
  const cosine = Math.cos(FRONT_WHEEL_STEERING_CORRECTION_RADIANS)
  const sine = Math.sin(FRONT_WHEEL_STEERING_CORRECTION_RADIANS)

  for (const node of json.nodes ?? []) {
    if (!FRONT_WHEEL_NODE_NAMES.has(node.name) || !Array.isArray(node.matrix) || node.matrix.length !== 16) continue

    const matrix = node.matrix
    node.matrix = [
      cosine * matrix[0] - sine * matrix[1], cosine * matrix[1] + sine * matrix[0], matrix[2], 0,
      cosine * matrix[4] - sine * matrix[5], cosine * matrix[5] + sine * matrix[4], matrix[6], 0,
      cosine * matrix[8] - sine * matrix[9], cosine * matrix[9] + sine * matrix[8], matrix[10], 0,
      matrix[12], matrix[13], matrix[14], 1,
    ]
  }
}

function assertFrontWheelsStraight(json) {
  for (const node of json.nodes ?? []) {
    if (!FRONT_WHEEL_NODE_NAMES.has(node.name)) continue
    assert(Array.isArray(node.matrix) && node.matrix.length === 16, `${node.name} is missing its transform matrix`)
    assert(Math.abs(node.matrix[0] - 1) < 1e-4, `${node.name} still has steering yaw`)
    assert(Math.abs(node.matrix[1]) < 1e-4, `${node.name} still has steering yaw`)
    assert(Math.abs(node.matrix[2]) < 1e-4, `${node.name} still has steering yaw`)
  }
}

function parseGlb(bytes) {
  assert(bytes.length >= 20, 'Expected a complete GLB file')
  assert(bytes.readUInt32LE(0) === 0x46546c67, 'Expected a GLB header')
  assert(bytes.readUInt32LE(4) === 2, 'Expected glTF 2.0')
  assert(bytes.readUInt32LE(8) === bytes.length, 'GLB length does not match file size')

  const jsonLength = bytes.readUInt32LE(12)
  assert(bytes.readUInt32LE(16) === 0x4e4f534a, 'Expected a JSON chunk')
  const binaryChunkOffset = 20 + jsonLength
  assert(binaryChunkOffset + 8 <= bytes.length, 'GLB is missing its binary chunk')

  const binaryLength = bytes.readUInt32LE(binaryChunkOffset)
  assert(bytes.readUInt32LE(binaryChunkOffset + 4) === 0x004e4942, 'Expected a BIN chunk')
  assert(binaryChunkOffset + 8 + binaryLength === bytes.length, 'GLB binary length does not match file size')

  return {
    json: JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim()),
    binary: bytes.subarray(binaryChunkOffset + 8),
  }
}

function glbFrom(json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json))
  const paddedJsonLength = Math.ceil(jsonBytes.length / 4) * 4
  const paddedBinaryLength = Math.ceil(binary.length / 4) * 4
  const output = Buffer.alloc(12 + 8 + paddedJsonLength + 8 + paddedBinaryLength)

  output.writeUInt32LE(0x46546c67, 0)
  output.writeUInt32LE(2, 4)
  output.writeUInt32LE(output.length, 8)
  output.writeUInt32LE(paddedJsonLength, 12)
  output.writeUInt32LE(0x4e4f534a, 16)
  jsonBytes.copy(output, 20)
  output.fill(0x20, 20 + jsonBytes.length, 20 + paddedJsonLength)

  const binaryChunkOffset = 20 + paddedJsonLength
  output.writeUInt32LE(paddedBinaryLength, binaryChunkOffset)
  output.writeUInt32LE(0x004e4942, binaryChunkOffset + 4)
  binary.copy(output, binaryChunkOffset + 8)
  return output
}

function createIndexMap(indices) {
  return new Map(indices.map((index, nextIndex) => [index, nextIndex]))
}

function remapIndex(index, indexMap, label) {
  const nextIndex = indexMap.get(index)
  assert(nextIndex !== undefined, `Removed ${label} ${index} is still referenced`)
  return nextIndex
}

function listImageHashes(json, binary) {
  return json.images.map((image, index) => {
    const bufferView = json.bufferViews[image.bufferView]
    assert(bufferView, `Image ${index} has no bufferView`)
    const start = bufferView.byteOffset ?? 0
    return sha256(binary.subarray(start, start + bufferView.byteLength))
  })
}

function isTextureInfo(key, value) {
  return key.toLowerCase().includes('texture')
    && value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.index === 'number'
}

function visitTextureInfos(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) visitTextureInfos(item, visit)
    return
  }
  if (!value || typeof value !== 'object') return

  for (const [key, child] of Object.entries(value)) {
    if (isTextureInfo(key, child)) visit(child, value, key)
    else visitTextureInfos(child, visit)
  }
}

function listMaterialTextureIndices(material) {
  const indices = new Set()
  visitTextureInfos(material, (textureInfo) => indices.add(textureInfo.index))
  return indices
}

function removeBannedTextureInfos(material, bannedTextureIndices) {
  let removedEmissiveTexture = false
  visitTextureInfos(material, (textureInfo, parent, key) => {
    if (!bannedTextureIndices.has(textureInfo.index)) return
    if (key === 'emissiveTexture') removedEmissiveTexture = true
    delete parent[key]
  })
  if (removedEmissiveTexture) delete material.emissiveFactor
}

function listPrimitiveAccessorIndices(primitive) {
  const indices = new Set()
  if (typeof primitive.indices === 'number') indices.add(primitive.indices)
  for (const accessor of Object.values(primitive.attributes ?? {})) indices.add(accessor)
  for (const target of primitive.targets ?? []) {
    for (const accessor of Object.values(target)) indices.add(accessor)
  }
  return indices
}

function listPrimitiveMaterialIndices(primitive) {
  const indices = new Set()
  if (typeof primitive.material === 'number') indices.add(primitive.material)
  for (const mapping of primitive.extensions?.KHR_materials_variants?.mappings ?? []) {
    if (typeof mapping.material === 'number') indices.add(mapping.material)
  }
  return indices
}

function resolveTextureReferences(material, textureMap) {
  visitTextureInfos(material, (textureInfo) => {
    textureInfo.index = remapIndex(textureInfo.index, textureMap, 'texture')
  })
}

function remapPrimitive(primitive, materialMap, accessorMap) {
  if (typeof primitive.material === 'number') {
    primitive.material = remapIndex(primitive.material, materialMap, 'material')
  }
  for (const mapping of primitive.extensions?.KHR_materials_variants?.mappings ?? []) {
    mapping.material = remapIndex(mapping.material, materialMap, 'variant material')
  }
  if (typeof primitive.indices === 'number') {
    primitive.indices = remapIndex(primitive.indices, accessorMap, 'accessor')
  }
  for (const [semantic, accessor] of Object.entries(primitive.attributes ?? {})) {
    primitive.attributes[semantic] = remapIndex(accessor, accessorMap, 'accessor')
  }
  for (const target of primitive.targets ?? []) {
    for (const [semantic, accessor] of Object.entries(target)) {
      target[semantic] = remapIndex(accessor, accessorMap, 'accessor')
    }
  }
}

function compactBinary(json, sourceBinary, retainedBufferViewIndices) {
  const bufferViewMap = createIndexMap(retainedBufferViewIndices)
  const chunks = []
  const bufferViews = []
  let byteOffset = 0

  for (const oldIndex of retainedBufferViewIndices) {
    const sourceView = json.bufferViews[oldIndex]
    assert(sourceView?.buffer === 0, `Expected bufferView ${oldIndex} in buffer 0`)
    const start = sourceView.byteOffset ?? 0
    const bytes = sourceBinary.subarray(start, start + sourceView.byteLength)
    assert(bytes.length === sourceView.byteLength, `bufferView ${oldIndex} exceeds the binary chunk`)

    chunks.push(bytes)
    bufferViews.push({ ...sourceView, buffer: 0, byteOffset })
    byteOffset += bytes.length

    const padding = (4 - (byteOffset % 4)) % 4
    if (padding) {
      chunks.push(Buffer.alloc(padding))
      byteOffset += padding
    }
  }

  const binary = Buffer.concat(chunks)
  json.bufferViews = bufferViews
  json.buffers = [{ byteLength: binary.length }]
  return { binary, bufferViewMap }
}

function sanitizeJson(sourceJson, sourceBinary) {
  const json = clone(sourceJson)
  assert(json.asset?.version === '2.0', 'Expected a glTF 2.0 source asset')
  assert(json.nodes?.length === 101 && json.meshes?.length === 97, 'Unexpected pinned source scene graph')
  assert(json.images?.length === 14 && json.textures?.length === 15, 'Unexpected pinned source textures')
  assert(json.buffers?.length === 1, 'Expected one source buffer')

  const sourceImageHashes = listImageHashes(json, sourceBinary)
  const bannedImageIndices = new Set(sourceImageHashes.flatMap((hash, index) => (
    BANNED_IMAGE_HASHES.has(hash) ? [index] : []
  )))
  assert(bannedImageIndices.size === BANNED_IMAGE_HASHES.size, 'Expected all marked source textures')

  const bannedTextureIndices = new Set(json.textures.flatMap((texture, index) => (
    bannedImageIndices.has(texture.source) ? [index] : []
  )))
  assert(bannedTextureIndices.size === 3, 'Expected three marked texture references')

  const removedNodeIndices = new Set(json.nodes.flatMap((node, index) => (
    REMOVED_NODE_NAMES.has(node.name) ? [index] : []
  )))
  assert(removedNodeIndices.size === REMOVED_NODE_NAMES.size, 'Expected emblem and license-plate nodes')

  const removedMeshIndices = new Set([...removedNodeIndices].map((index) => json.nodes[index].mesh))
  assert(!removedMeshIndices.has(undefined), 'Trademark geometry must have meshes')
  for (const [index, node] of json.nodes.entries()) {
    if (!removedNodeIndices.has(index)) {
      assert(!removedMeshIndices.has(node.mesh), `Removed mesh ${node.mesh} is still used`)
    }
  }

  const retainedNodeIndices = json.nodes.flatMap((_node, index) => (
    removedNodeIndices.has(index) ? [] : [index]
  ))
  const retainedMeshIndices = json.meshes.flatMap((_mesh, index) => (
    removedMeshIndices.has(index) ? [] : [index]
  ))
  const nodeMap = createIndexMap(retainedNodeIndices)
  const meshMap = createIndexMap(retainedMeshIndices)

  const retainedMeshes = retainedMeshIndices.map((index) => json.meshes[index])
  const retainedMaterialIndices = [...new Set(retainedMeshes.flatMap((mesh) => (
    mesh.primitives.flatMap((primitive) => [...listPrimitiveMaterialIndices(primitive)])
  )))].sort((left, right) => left - right)
  const materialMap = createIndexMap(retainedMaterialIndices)
  const retainedMaterials = retainedMaterialIndices.map((index) => clone(json.materials[index]))

  for (const material of retainedMaterials) {
    removeBannedTextureInfos(material, bannedTextureIndices)
  }

  const tireside = retainedMaterials.find((material) => material.name === 'Tireside')
  assert(tireside, 'Tireside material is missing')
  tireside.pbrMetallicRoughness ??= {}
  tireside.pbrMetallicRoughness.baseColorFactor = [0.018, 0.018, 0.018, 1]
  tireside.pbrMetallicRoughness.metallicFactor = 0
  tireside.pbrMetallicRoughness.roughnessFactor = 0.92
  delete tireside.pbrMetallicRoughness.baseColorTexture
  delete tireside.normalTexture

  const retainedTextureIndices = [...new Set(retainedMaterials.flatMap((material) => (
    [...listMaterialTextureIndices(material)]
  )))].sort((left, right) => left - right)
  assert(!retainedTextureIndices.some((index) => bannedTextureIndices.has(index)), 'A marked texture is still referenced')
  const dedupedTextureIndices = []
  const dedupedTextureMap = new Map()
  for (const textureIndex of retainedTextureIndices) {
    const texture = json.textures[textureIndex]
    const key = `${texture.source}:${texture.sampler ?? ''}`
    if (!dedupedTextureMap.has(key)) {
      dedupedTextureMap.set(key, dedupedTextureIndices.length)
      dedupedTextureIndices.push(textureIndex)
    }
  }
  const textureMap = new Map(retainedTextureIndices.map((textureIndex) => {
    const texture = json.textures[textureIndex]
    return [textureIndex, dedupedTextureMap.get(`${texture.source}:${texture.sampler ?? ''}`)]
  }))

  const retainedImageIndices = [...new Set(retainedTextureIndices.map((index) => json.textures[index].source))]
    .sort((left, right) => left - right)
  assert(!retainedImageIndices.some((index) => bannedImageIndices.has(index)), 'A marked image is still referenced')
  const imageMap = createIndexMap(retainedImageIndices)

  // Preserve all vertex attributes. In particular, a primitive may have a
  // material variant with a different UV set, so attribute pruning could alter
  // a valid variant even when the default material does not use that attribute.
  const retainedMeshCopies = retainedMeshes.map((mesh) => clone(mesh))
  const retainedAccessorIndices = [...new Set(retainedMeshCopies.flatMap((mesh) => (
    mesh.primitives.flatMap((primitive) => [...listPrimitiveAccessorIndices(primitive)])
  )))].sort((left, right) => left - right)
  const accessorMap = createIndexMap(retainedAccessorIndices)

  const retainedBufferViewIndices = [...new Set([
    ...retainedAccessorIndices.flatMap((index) => {
      const accessor = json.accessors[index]
      const sparse = accessor.sparse
      return [
        accessor.bufferView,
        sparse?.indices?.bufferView,
        sparse?.values?.bufferView,
      ].filter((bufferView) => bufferView !== undefined)
    }),
    ...retainedImageIndices.map((index) => json.images[index].bufferView),
  ])].sort((left, right) => left - right)

  // Repack only referenced bufferViews so removed PNGs and mesh data cannot
  // remain as unreachable bytes in the published GLB.
  const { binary, bufferViewMap } = compactBinary(json, sourceBinary, retainedBufferViewIndices)

  json.materials = retainedMaterials
  json.textures = dedupedTextureIndices.map((index) => clone(sourceJson.textures[index]))
  json.images = retainedImageIndices.map((index) => clone(sourceJson.images[index]))
  json.meshes = retainedMeshCopies
  json.nodes = retainedNodeIndices.map((index) => clone(sourceJson.nodes[index]))
  normalizeFrontWheelMatrices(json)
  json.accessors = retainedAccessorIndices.map((index) => clone(sourceJson.accessors[index]))
  json.buffers = [{ byteLength: binary.length }]

  for (const material of json.materials) {
    resolveTextureReferences(material, textureMap)
  }
  for (const texture of json.textures) {
    texture.source = remapIndex(texture.source, imageMap, 'image')
  }
  for (const image of json.images) {
    image.bufferView = remapIndex(image.bufferView, bufferViewMap, 'image bufferView')
  }
  for (const accessor of json.accessors) {
    if (accessor.bufferView !== undefined) {
      accessor.bufferView = remapIndex(accessor.bufferView, bufferViewMap, 'accessor bufferView')
    }
    if (accessor.sparse?.indices?.bufferView !== undefined) {
      accessor.sparse.indices.bufferView = remapIndex(accessor.sparse.indices.bufferView, bufferViewMap, 'sparse indices bufferView')
    }
    if (accessor.sparse?.values?.bufferView !== undefined) {
      accessor.sparse.values.bufferView = remapIndex(accessor.sparse.values.bufferView, bufferViewMap, 'sparse values bufferView')
    }
  }
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) remapPrimitive(primitive, materialMap, accessorMap)
  }
  for (const node of json.nodes) {
    if (node.mesh !== undefined) node.mesh = remapIndex(node.mesh, meshMap, 'mesh')
    if (node.children) {
      node.children = node.children
        .filter((index) => !removedNodeIndices.has(index))
        .map((index) => remapIndex(index, nodeMap, 'node'))
    }
  }
  for (const scene of json.scenes) {
    if (scene.nodes) {
      scene.nodes = scene.nodes
        .filter((index) => !removedNodeIndices.has(index))
        .map((index) => remapIndex(index, nodeMap, 'scene node'))
    }
  }

  json.asset = {
    generator: 'CanvasFlow Car Concept sanitizer',
    version: '2.0',
    copyright: 'Car Concept by Eric Chadwick / Darmstadt Graphics Group GmbH, 2024. CC BY 4.0. Modified by CanvasFlow; attribution in THIRD-PARTY-NOTICES.md.',
  }
  assertFrontWheelsStraight(json)
  return { json, binary }
}

export function validateSanitizedGlb(bytes) {
  const { json, binary } = parseGlb(bytes)
  const loweredText = bytes.toString('latin1').toLowerCase()
  const names = [
    ...json.nodes.map((node) => node.name ?? ''),
    ...json.meshes.map((mesh) => mesh.name ?? ''),
    ...json.materials.map((material) => material.name ?? ''),
  ].join('\n').toLowerCase()
  const tireside = json.materials.find((material) => material.name === 'Tireside')

  for (const forbidden of FORBIDDEN_MARK_STRINGS) {
    assert(!loweredText.includes(forbidden), `Output contains forbidden trademark text: ${forbidden}`)
    assert(!names.includes(forbidden), `Output contains forbidden geometry name: ${forbidden}`)
  }
  assert(!json.nodes.some((node) => REMOVED_NODE_NAMES.has(node.name)), 'Trademark geometry remains')
  assertFrontWheelsStraight(json)
  assert(json.images.length === 11, `Expected 11 retained images, found ${json.images.length}`)
  assert(!listImageHashes(json, binary).some((hash) => BANNED_IMAGE_HASHES.has(hash)), 'A marked texture remains')
  assert(tireside, 'Tireside material is missing')
  assert(!tireside.pbrMetallicRoughness?.baseColorTexture, 'Tireside base-color mark remains')
  assert(!tireside.normalTexture, 'Tireside normal-map mark remains')

  for (const material of json.materials) {
    for (const textureIndex of listMaterialTextureIndices(material)) {
      assert(json.textures[textureIndex], `Material references missing texture ${textureIndex}`)
    }
  }
  for (const texture of json.textures) {
    assert(json.images[texture.source], `Texture references missing image ${texture.source}`)
  }
  for (const image of json.images) {
    const view = json.bufferViews[image.bufferView]
    assert(view && (view.byteOffset ?? 0) + view.byteLength <= binary.length, 'Image exceeds the binary chunk')
  }
  for (const accessor of json.accessors) {
    if (accessor.bufferView !== undefined) assert(json.bufferViews[accessor.bufferView], 'Accessor references a missing bufferView')
  }
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) {
      for (const accessorIndex of listPrimitiveAccessorIndices(primitive)) {
        assert(json.accessors[accessorIndex], `Primitive references missing accessor ${accessorIndex}`)
      }
      for (const materialIndex of listPrimitiveMaterialIndices(primitive)) {
        assert(json.materials[materialIndex], `Primitive references missing material ${materialIndex}`)
      }
    }
  }
  for (const node of json.nodes) {
    if (node.mesh !== undefined) assert(json.meshes[node.mesh], `Node references missing mesh ${node.mesh}`)
    for (const childIndex of node.children ?? []) assert(json.nodes[childIndex], `Node references missing child ${childIndex}`)
  }

  return {
    sha256: sha256(bytes),
    byteLength: bytes.length,
    retainedImages: json.images.length,
    retainedMaterials: json.materials.length,
    retainedMeshes: json.meshes.length,
    retainedNodes: json.nodes.length,
  }
}

export async function sanitizeCarConcept(inputPath, outputPath) {
  assert(inputPath && outputPath, 'Usage: node scripts/sanitize-carconcept.mjs /path/to/CarConcept.glb output.glb')
  const input = resolve(inputPath)
  const output = resolve(outputPath)
  const source = await readFile(input)
  const sourceHash = sha256(source)
  assert(sourceHash === SOURCE_SHA256, `Unexpected source SHA-256: ${sourceHash}`)

  const { json, binary } = parseGlb(source)
  const sanitized = sanitizeJson(json, binary)
  const outputBytes = glbFrom(sanitized.json, sanitized.binary)
  const result = validateSanitizedGlb(outputBytes)

  await mkdir(dirname(output), { recursive: true })
  const temporary = `${output}.tmp`
  await writeFile(temporary, outputBytes)
  await rename(temporary, output)
  return { input, output, sourceSha256: sourceHash, ...result }
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const result = await sanitizeCarConcept(process.argv[2], process.argv[3])
  console.log(JSON.stringify(result, null, 2))
}
