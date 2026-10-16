import * as THREE from 'three';

// The generated asset has one baked material, including white reflections in
// its windows. Work in normalized vehicle coordinates so the finish remains
// attached to the original curved surface throughout the complete side roll.
const GLASS_MASK = `
varying vec3 vReferencePosition;
float referenceGlass(vec3 p) {
  float z = p.z;
  float lower = z > 0.2 ? mix(0.79, 0.835, clamp((z - 0.2) / 1.13, 0.0, 1.0))
                        : mix(0.79, 0.955, clamp((0.2 - z) / 1.43, 0.0, 1.0));
  float upper = z > -0.15 ? mix(1.172, 0.845, clamp((z + 0.15) / 1.48, 0.0, 1.0))
                          : mix(1.172, 0.972, clamp((-0.15 - z) / 1.08, 0.0, 1.0));
  float ends = smoothstep(-1.25, -1.225, z) * (1.0 - smoothstep(1.315, 1.34, z));
  float aboveBelt = smoothstep(lower, lower + 0.008, p.y);
  float sideWindow = (1.0 - smoothstep(upper - 0.006, upper + 0.006, p.y))
                    * (1.0 - smoothstep(0.91, 0.925, abs(p.x)));
  // The inset top glazing meets the side windows below a narrow silver rail.
  float roofWidth = mix(0.66, 0.745, clamp(abs(z + 0.1) / 1.4, 0.0, 1.0));
  float topWindow = 1.0 - smoothstep(roofWidth - 0.008, roofWidth + 0.008, abs(p.x));
  float cabin = ends * aboveBelt * max(sideWindow, topWindow);
  float rearExtent = smoothstep(-1.84, -1.815, z) * (1.0 - smoothstep(-1.03, -1.0, z));
  float rearLower = mix(0.785, 0.97, clamp((z + 1.84) / 0.84, 0.0, 1.0));
  float rearWidth = mix(0.53, 0.675, clamp((z + 1.84) / 0.84, 0.0, 1.0));
  float rearWindow = rearExtent * smoothstep(rearLower, rearLower + 0.01, p.y)
                     * (1.0 - smoothstep(rearWidth - 0.008, rearWidth + 0.008, abs(p.x)));
  return max(cabin, rearWindow);
}
float referenceWheel(vec3 p) {
  float front = length(vec2((p.z - 1.215) / 0.36, (p.y - 0.350) / 0.31));
  float rear = length(vec2((p.z + 1.640) / 0.35, (p.y - 0.400) / 0.29));
  return (1.0 - smoothstep(0.97, 1.02, min(front, rear))) * smoothstep(0.91, 0.955, abs(p.x));
}
float referenceSkirt(vec3 p) {
  float belt = 0.255 + 0.055 * (1.0 - smoothstep(-2.1, -0.7, p.z));
  return 1.0 - smoothstep(belt - 0.008, belt + 0.008, p.y);
}
`;

export function applyReferenceFinish(model, environment) {
  model.updateMatrixWorld(true);
  const point = new THREE.Vector3();
  const originals = new Set(), retainedTextures = new Set([environment]);
  model.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    const coordinates = new Float32Array(position.count * 3);
    for (let index = 0; index < position.count; index++) {
      point.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
      point.toArray(coordinates, index * 3);
    }
    mesh.geometry.setAttribute('referencePosition', new THREE.BufferAttribute(coordinates, 3));
    const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (source.map) retainedTextures.add(source.map);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) originals.add(material);
    const finish = new THREE.MeshPhysicalMaterial({
      name: 'reference-silver-body-black-glazing',
      map: source.map,
      color: '#e6e8e9',
      roughness: 0.38,
      metalness: 0.32,
      clearcoat: 0.35,
      clearcoatRoughness: 0.28,
      envMap: environment,
      envMapIntensity: 0.28,
      side: source.side,
    });
    finish.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 referencePosition;\nvarying vec3 vReferencePosition;');
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvReferencePosition = referencePosition;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${GLASS_MASK}`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        float glassFinish = referenceGlass(vReferencePosition);
        float wheelFinish = referenceWheel(vReferencePosition);
        float skirtFinish = referenceSkirt(vReferencePosition);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.004, 0.007, 0.010), glassFinish);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.008, 0.009, 0.011), max(wheelFinish, skirtFinish));
      `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.32, glassFinish);
        roughnessFactor = mix(roughnessFactor, 0.53, max(wheelFinish, skirtFinish));
      `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.03, glassFinish);
        metalnessFactor = mix(metalnessFactor, 0.18, max(wheelFinish, skirtFinish));
      `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.specularColor *= mix(1.0, 0.4, glassFinish);
        material.specularF90 *= mix(1.0, 0.45, glassFinish);
        #ifdef USE_CLEARCOAT
          material.clearcoat *= mix(1.0, 0.25, glassFinish);
        #endif
      `);
    };
    finish.customProgramCacheKey = () => 'roadster-reference-finish-1';
    mesh.material = finish;
  });
  const unusedTextures = new Set();
  for (const material of originals) {
    for (const value of Object.values(material)) {
      if (value?.isTexture && !retainedTextures.has(value)) unusedTextures.add(value);
    }
    material.dispose();
  }
  for (const texture of unusedTextures) texture.dispose();
}

export function createAeroWheelCovers(environment) {
  const covers = new THREE.Group();
  covers.name = 'reference-closed-aero-wheel-covers';
  const faceMaterial = new THREE.MeshPhysicalMaterial({ color: '#303236', roughness: 0.46, metalness: 0.25, clearcoat: 0.2, envMap: environment, envMapIntensity: 0.35 });
  const rimMaterial = new THREE.MeshStandardMaterial({ color: '#3b3e42', roughness: 0.48, metalness: 0.4, envMap: environment, envMapIntensity: 0.3, side: THREE.DoubleSide });
  const hubMaterial = new THREE.MeshStandardMaterial({ color: '#101315', roughness: 0.35, metalness: 0.4, envMap: environment, envMapIntensity: 0.2 });
  const faceGeometry = new THREE.CylinderGeometry(1, 1, 0.016, 64).rotateZ(Math.PI / 2);
  const rimGeometry = new THREE.RingGeometry(0.955, 0.979, 64).rotateY(Math.PI / 2);
  const hubGeometry = new THREE.SphereGeometry(0.027, 16, 10);
  // Fitted to the asset after the same independent-axis normalization as its
  // collision footprint. The closed cover stays inside the existing tire.
  for (const axle of [{ z: 1.215, y: 0.350, ry: 0.30, rz: 0.35 }, { z: -1.640, y: 0.400, ry: 0.28, rz: 0.34 }]) {
    for (const side of [-1, 1]) {
      const face = new THREE.Mesh(faceGeometry, faceMaterial);
      face.position.set(side * 1.040, axle.y, axle.z);
      face.scale.set(1, axle.ry, axle.rz);
      face.castShadow = face.receiveShadow = true;
      covers.add(face);
      const rim = new THREE.Mesh(rimGeometry, rimMaterial);
      rim.position.set(side * 1.0485, axle.y, axle.z);
      rim.scale.set(1, axle.ry, axle.rz);
      covers.add(rim);
      const hub = new THREE.Mesh(hubGeometry, hubMaterial);
      hub.position.set(side * 1.043, axle.y, axle.z);
      hub.scale.x = 0.2;
      covers.add(hub);
    }
  }
  return covers;
}
