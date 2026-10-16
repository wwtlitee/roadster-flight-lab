import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { applyReferenceFinish, createAeroWheelCovers } from './car-materials.js';
import { renderControlCar } from './control-car.js';
import { WORLD, JETS, getQuaternion } from './physics.js';

const clamp = THREE.MathUtils.clamp;
const R = WORLD.rampRadius || 11;
const START = WORLD.rampRadius ? WORLD.rampStart : 35;
const END = WORLD.rampThetaEnd || 170 * Math.PI / 180;
const HALF = WORLD.rampRadius ? WORLD.rampHalfWidth : 4;
const PAD = WORLD.rampRadius ? WORLD.padZ : -12;
const point = (a, depth = 0) => new THREE.Vector3(0, R * (1 - Math.cos(a)) - Math.cos(a) * depth, START + (R + depth) * Math.sin(a));

function disposeTree(object, retainedTexture = null) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  object.traverse((child) => {
    if (child.geometry) geometries.add(child.geometry);
    for (const material of Array.isArray(child.material) ? child.material : child.material ? [child.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture && value !== retainedTexture) textures.add(value);
    }
  });
  geometries.forEach((item) => item.dispose());
  materials.forEach((item) => item.dispose());
  textures.forEach((item) => item.dispose());
}

function ribbon(x0, x1, depth = 0) {
  const positions = [], indices = [], uvs = [];
  for (let i = 0; i <= 120; i++) {
    const p = point(END * i / 120, depth);
    positions.push(x0, p.y, p.z, x1, p.y, p.z);
    uvs.push(0, i / 30, 1, i / 30);
    if (i < 120) { const n = i * 2; indices.push(n, n + 2, n + 1, n + 1, n + 2, n + 3); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function trackTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 1024;
  const context = canvas.getContext('2d'), pixels = context.createImageData(256, 1024);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const value = 212 + Math.random() * 10;
    pixels.data[i] = value; pixels.data[i + 1] = value + 2; pixels.data[i + 2] = value + 4; pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0); context.strokeStyle = 'rgba(38,48,58,.15)'; context.lineWidth = 1;
  for (let y = 0; y < 1024; y += 256) { context.beginPath(); context.moveTo(0, y + 0.5); context.lineTo(256, y + 0.5); context.stroke(); }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.anisotropy = 8;
  return texture;
}

function addStage(scene) {
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const box = (material, x, y, z, sx, sy, sz) => {
    const mesh = new THREE.Mesh(unit, material);
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.receiveShadow = true; scene.add(mesh); return mesh;
  };
  const metal = new THREE.MeshStandardMaterial({ color: '#4c5963', roughness: 0.57, metalness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: '#141b22', roughness: 0.8, metalness: 0.3 });
  const paint = new THREE.MeshStandardMaterial({ color: '#a2adb6', roughness: 0.8 });
  const red = new THREE.MeshBasicMaterial({ color: '#bd2332', toneMapped: false });
  const lamp = new THREE.MeshBasicMaterial({ color: '#c9dde6', toneMapped: false });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), new THREE.MeshPhysicalMaterial({ color: '#010203', roughness: 1, metalness: 0, specularIntensity: 0, envMapIntensity: 0 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(0, -0.06, 20); ground.receiveShadow = true; scene.add(ground);
  const surface = new THREE.Mesh(ribbon(-HALF, HALF), new THREE.MeshStandardMaterial({ color: '#c8ced3', roughness: 0.83, metalness: 0.12, map: trackTexture(), side: THREE.DoubleSide }));
  surface.castShadow = surface.receiveShadow = true; scene.add(surface);
  scene.add(new THREE.Mesh(ribbon(-HALF, HALF, 0.13), dark));
  for (const side of [-1, 1]) {
    scene.add(new THREE.Mesh(ribbon(side * HALF - 0.042, side * HALF + 0.042, -0.018), red));
    scene.add(new THREE.Mesh(ribbon(side * 1.15 - 0.025, side * 1.15 + 0.025, -0.022), paint));
    box(paint, side * HALF, 0.006, 20, 0.045, 0.01, 30);
  }
  const edges = [];
  const edge = (a, b, radius = 0.045) => edges.push({ a, b, radius });
  for (const side of [-1, 1]) {
    const x = side * (HALF + 0.1);
    for (let i = 0; i < 24; i++) {
      const a = point(END * i / 24, 0.14); a.x = x;
      const b = point(END * (i + 1) / 24, 0.14); b.x = x;
      const c = point(END * i / 24, 1.2); c.x = x;
      const d = point(END * (i + 1) / 24, 1.2); d.x = x;
      edge(a, b, 0.065); edge(c, d, 0.065); edge(a, c); edge(i % 2 ? a : b, i % 2 ? d : c);
    }
    const supportZ = START + R + 2;
    for (let i = 0; i < 8; i++) {
      const y0 = i * 2.7, y1 = (i + 1) * 2.7;
      const back0 = new THREE.Vector3(x, y0, supportZ), back1 = new THREE.Vector3(x, y1, supportZ);
      const front = point(Math.min(Math.acos(clamp(1 - y1 / R, -1, 1)), END), 1.15); front.x = x;
      edge(back0, back1, 0.075); edge(front, back1, 0.06); edge(front, back0);
    }
  }
  for (let i = 0; i <= 12; i++) {
    const p = point(END * i / 12, 0.35);
    edge(new THREE.Vector3(-HALF, p.y, p.z), new THREE.Vector3(HALF, p.y, p.z), 0.05);
  }
  const steel = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6), metal, edges.length);
  const transform = new THREE.Object3D(), direction = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  edges.forEach(({ a, b, radius }, i) => {
    direction.subVectors(b, a); transform.position.copy(a).add(b).multiplyScalar(0.5);
    transform.scale.set(radius, direction.length(), radius); transform.quaternion.setFromUnitVectors(up, direction.normalize());
    transform.updateMatrix(); steel.setMatrixAt(i, transform.matrix);
  });
  scene.add(steel);
  const padWidth = WORLD.padHalfWidth || 10, padLength = WORLD.padHalfLength || 25;
  for (const x of [-padWidth, padWidth]) for (let z = PAD - padLength; z < PAD + padLength; z += 6) box(paint, x, 0.006, z, 0.06, 0.012, 2.2);
  for (const z of [PAD - padLength, PAD + padLength]) box(paint, 0, 0.007, z, padWidth * 2, 0.012, 0.08);
  box(paint, 0, 0.008, PAD, 1.8, 0.012, 0.06); box(paint, 0, 0.008, PAD, 0.06, 0.012, 1.8);
  for (let z = -50; z <= 90; z += 35) for (const side of [-1, 1]) {
    box(dark, side * 30, 2.8, z, 0.06, 5.6, 0.06); box(lamp, side * 30, 5.6, z, 0.21, 0.05, 0.12);
  }
  box(red, -27, 0.23, 58, 42, 0.028, 0.045); box(red, 29, 0.23, -30, 32, 0.028, 0.045);
  const beamMaterial = new THREE.MeshBasicMaterial({ color: '#6dabc9', transparent: true, opacity: 0.012, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? -1 : 1;
    direction.set(side * (0.15 + i % 3 * 0.16), 1, -0.15 + (i % 3 - 1) * 0.17).normalize();
    const source = new THREE.Vector3(side * 5.2, 0.12, START + 1);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.012, 10, 12, 1, true), beamMaterial);
    beam.quaternion.setFromUnitVectors(up, direction); beam.position.copy(source).addScaledVector(direction, 5); scene.add(beam);
    box(dark, source.x, 0.1, source.z, 0.3, 0.2, 0.3); box(lamp, source.x, 0.21, source.z, 0.13, 0.025, 0.13);
  }
}

function createSteam(scene) {
  const count = 520, position = new Float32Array(count * 3), radius = new Float32Array(count), opacity = new Float32Array(count);
  const velocity = new Float32Array(count * 3), life = new Float32Array(count), duration = new Float32Array(count), expansion = new Float32Array(count);
  position.fill(-999);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2)); geometry.setIndex([0, 1, 2, 2, 1, 3]);
  geometry.setAttribute('offset', new THREE.InstancedBufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('radius', new THREE.InstancedBufferAttribute(radius, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('opacity', new THREE.InstancedBufferAttribute(opacity, 1).setUsage(THREE.DynamicDrawUsage)); geometry.instanceCount = count;
  const material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { color: { value: new THREE.Color('#dce6eb') } },
    vertexShader: 'attribute vec3 offset;attribute float radius;attribute float opacity;varying vec2 vUv;varying float vOpacity;void main(){vUv=uv;vOpacity=opacity;vec4 p=modelViewMatrix*vec4(offset,1.0);p.xy+=position.xy*radius;gl_Position=projectionMatrix*p;}',
    fragmentShader: 'uniform vec3 color;varying vec2 vUv;varying float vOpacity;float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}void main(){vec2 p=vUv*2.0-1.0;float a=pow(max(0.0,1.0-dot(p,p)),1.7);float cloud=.55+.45*noise(vUv*5.0);gl_FragColor=vec4(color,a*cloud*vOpacity);}' });
  const mesh = new THREE.Mesh(geometry, material); mesh.frustumCulled = false; mesh.renderOrder = 5; scene.add(mesh);
  let cursor = 0;
  return {
    emit(p, v, dust = false) {
      const i = cursor++ % count, n = i * 3;
      position[n] = p.x + (Math.random() - 0.5) * 0.08; position[n + 1] = p.y; position[n + 2] = p.z + (Math.random() - 0.5) * 0.08;
      velocity[n] = v.x + (Math.random() - 0.5) * 0.8; velocity[n + 1] = v.y; velocity[n + 2] = v.z + (Math.random() - 0.5) * 0.8;
      duration[i] = dust ? 2.4 : 1.2; life[i] = duration[i]; radius[i] = dust ? 0.16 : 0.07; expansion[i] = dust ? 0.9 : 0.43;
    },
    update(dt) {
      for (let i = 0; i < count; i++) {
        if (life[i] <= 0) { opacity[i] = 0; continue; }
        const n = i * 3; life[i] -= dt; position[n] += velocity[n] * dt; position[n + 1] = Math.max(0.1, position[n + 1] + velocity[n + 1] * dt); position[n + 2] += velocity[n + 2] * dt;
        velocity[n] *= 1 - dt * 0.3; velocity[n + 2] *= 1 - dt * 0.3; if (position[n + 1] <= 0.12) velocity[n + 1] = 0.14;
        radius[i] += dt * expansion[i]; opacity[i] = Math.max(0, life[i] / duration[i]) * (duration[i] > 2 ? 0.2 : 0.48);
      }
      geometry.attributes.offset.needsUpdate = geometry.attributes.radius.needsUpdate = geometry.attributes.opacity.needsUpdate = true;
    },
    clear() { life.fill(0); opacity.fill(0); },
  };
}

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.08;
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#010204'); scene.fog = new THREE.FogExp2('#010204', 0.005);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.08, 450);
  const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment(), environment = pmrem.fromScene(room, 0.03);
  scene.environment = environment.texture; scene.environmentIntensity = 0.58; room.dispose(); pmrem.dispose();
  scene.add(new THREE.HemisphereLight('#98b6cc', '#080a10', 0.45));
  const keyLight = new THREE.DirectionalLight('#e5eef6', 2.6); keyLight.position.set(-24, 40, -15); keyLight.target.position.set(0, 8, 25); keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048); Object.assign(keyLight.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 160 }); keyLight.shadow.bias = -0.0002; keyLight.shadow.normalBias = 0.035;
  scene.add(keyLight, keyLight.target);
  const rim = new THREE.DirectionalLight('#96bfd9', 1.1); rim.position.set(24, 26, 66); rim.target.position.set(0, 10, 30); scene.add(rim, rim.target);
  const spot = new THREE.SpotLight('#e5f2ff', 800, 85, Math.PI / 5.4, 0.8, 2); spot.position.set(15, 28, 12); spot.target.position.set(0, 12, START + 5); scene.add(spot, spot.target);
  addStage(scene);
  const carRoot = new THREE.Group(); carRoot.name = 'roadster-flight-body'; scene.add(carRoot);
  let carVisual = null, wheels = [], wheelAngle = 0, disposed = false, generation = 0;
  const wheelAxis = new THREE.Vector3(1, 0, 0), wheelRotation = new THREE.Quaternion();
  const assetState = { status: 'loading', url: './assets/roadster.glb?v=0f2e2790b080918a', error: null, length: 0, width: 0, height: 0 }; scene.userData.carAsset = assetState;
  async function loadCarModel(url = assetState.url, yaw = 0) {
    const current = ++generation; Object.assign(assetState, { status: 'loading', url, error: null });
    try {
      const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
      if (disposed || current !== generation) { disposeTree(gltf.scene); return false; }
      const model = gltf.scene; model.updateMatrixWorld(true);
      let bounds = new THREE.Box3().setFromObject(model), size = bounds.getSize(new THREE.Vector3());
      const orientation = new THREE.Group(), axis = new THREE.Group(); axis.add(model); axis.rotation.y = (size.x > size.z ? Math.PI / 2 : 0) + yaw; orientation.add(axis); orientation.updateMatrixWorld(true);
      bounds = new THREE.Box3().setFromObject(orientation); size = bounds.getSize(size);
      if (![size.x, size.y, size.z].every(Number.isFinite) || size.z < 0.001) { disposeTree(orientation); throw new Error('模型尺寸无效'); }
      orientation.scale.set((WORLD.vehicleWidth || 2.1) / size.x, (WORLD.vehicleHeight || 1.2) / size.y, (WORLD.vehicleLength || 4.7) / size.z); orientation.updateMatrixWorld(true); bounds = new THREE.Box3().setFromObject(orientation);
      const center = bounds.getCenter(new THREE.Vector3()); orientation.position.set(-center.x, -bounds.min.y, -center.z);
      applyReferenceFinish(orientation, environment.texture);
      wheels = [];
      orientation.traverse((child) => {
        if (child.isMesh) child.castShadow = child.receiveShadow = true;
        if (/^TR\.DEF-Wheel\.(Ft|Bk)\.(L|R)$/.test(child.userData.name || child.name)) wheels.push({ node: child, base: child.quaternion.clone() });
      });
      if (carVisual) { carRoot.remove(carVisual); disposeTree(carVisual, environment.texture); }
      carVisual = new THREE.Group(); carVisual.name = 'loaded-roadster-model';
      carVisual.add(orientation, createAeroWheelCovers(environment.texture)); carRoot.add(carVisual);
      renderControlCar(renderer, carVisual, document.getElementById('control-car'));
      bounds = new THREE.Box3().setFromObject(carVisual); size = bounds.getSize(size);
      Object.assign(assetState, { status: 'ready', error: null, length: size.z, width: size.x, height: size.y, wheelCount: wheels.length }); return true;
    } catch (error) {
      if (!disposed && current === generation) Object.assign(assetState, { status: 'error', error: String(error.message || error) }); return false;
    }
  }
  loadCarModel();
  const runningLights = new THREE.Group();
  const headlight = new THREE.MeshBasicMaterial({ color: '#e1f2ff', toneMapped: false });
  for (const side of [-1, 1]) {
    const line = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * 0.68, 0.46, 2.17),
      new THREE.Vector3(side * 0.8, 0.48, 1.99),
      new THREE.Vector3(side * 0.91, 0.5, 1.78),
    ]);
    runningLights.add(new THREE.Mesh(new THREE.TubeGeometry(line, 10, 0.008, 5, false), headlight));
  }
  const rearLine = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.88, 0.64, -2.22), new THREE.Vector3(0, 0.64, -2.32), new THREE.Vector3(0.88, 0.64, -2.22),
  ]);
  runningLights.add(new THREE.Mesh(new THREE.TubeGeometry(rearLine, 20, 0.008, 5, false), new THREE.MeshBasicMaterial({ color: '#e62732', toneMapped: false })));
  carRoot.add(runningLights);
  const nozzle = new THREE.MeshStandardMaterial({ color: '#151d24', roughness: 0.45, metalness: 0.7 });
  const vapor = new THREE.MeshBasicMaterial({ color: '#f0f5f7', transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide });
  const blueCore = new THREE.MeshBasicMaterial({ color: '#a9d7eb', transparent: true, opacity: 0.62, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const jets = JETS.map((definition, index) => {
    const group = new THREE.Group(); group.position.set(definition.x * 0.88, 0.26, definition.z * 0.94);
    group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.05, 10, 1, true), nozzle));
    const plume = new THREE.Group(); plume.position.y = -0.025;
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.64, 12, 1, true), vapor); outer.position.y = -0.32;
    const core = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.42, 10, 1, true), blueCore); core.position.y = -0.21;
    plume.add(outer, core); plume.visible = false; group.add(plume); carRoot.add(group); return { definition, group, plume, index };
  });
  const steam = createSteam(scene), emitter = new THREE.Vector3(), flow = new THREE.Vector3();
  const wideTarget = new THREE.Vector3(0, 10, 40);
  const wideOffset = new THREE.Vector3(-37, 1.8, -61);
  const closeOffset = new THREE.Vector3(-13, 5.5, -11);
  const cameraTarget = new THREE.Vector3(), viewTarget = wideTarget.clone();
  const desiredPosition = new THREE.Vector3(), desiredTarget = new THREE.Vector3();
  const vehicleCenter = new THREE.Vector3();
  let time = 0, emissionTime = 0, lastImpacts = 0, lastQuality = '', previousElapsed = 0;
  function resize() { const w = Math.max(1, canvas.clientWidth || window.innerWidth), h = Math.max(1, canvas.clientHeight || window.innerHeight); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  function setCamera(state, delta) {
    // Keep the approach wide. Ease closer only once airborne, then retain the
    // same world-facing camera through jet control, impact and rollout.
    const fit = Math.max(1, 1.78 / camera.aspect);
    const progress = clamp((state.flightTime || 0) / 0.75, 0, 1);
    const blend = progress * progress * (3 - 2 * progress);
    camera.fov = 30.5 + (40 - 30.5) * blend;
    vehicleCenter.set(0, WORLD.vehicleHeight / 2, 0).applyQuaternion(carRoot.quaternion).add(carRoot.position);
    desiredTarget.copy(wideTarget).lerp(vehicleCenter, blend);
    desiredPosition.copy(wideTarget).addScaledVector(wideOffset, fit);
    cameraTarget.copy(vehicleCenter).addScaledVector(closeOffset, Math.max(1, 1.15 / camera.aspect));
    desiredPosition.lerp(cameraTarget, blend);
    if (!blend) { camera.position.copy(desiredPosition); viewTarget.copy(desiredTarget); }
    else {
      const follow = 1 - Math.exp(-delta * 8);
      camera.position.lerp(desiredPosition, follow);
      viewTarget.lerp(desiredTarget, follow);
    }
    camera.lookAt(viewTarget);
    camera.updateProjectionMatrix();
    scene.userData.camera = { position: camera.position.toArray(), target: viewTarget.toArray(), fov: camera.fov, aspect: camera.aspect, blend };
    return blend === 0 ? 'fixed-wide' : blend < 1 ? 'flight-transition' : 'flight-follow';
  }
  function render(state, dt = 1 / 60, options = {}) {
    if (disposed || !state?.pos) return;
    const delta = clamp(Number.isFinite(dt) ? dt : 1 / 60, 0, 0.05), menu = Boolean(options.menu), quality = options.quality || 'high';
    if (!options.paused) time += delta;
    if (quality !== lastQuality) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'low' ? 1 : 1.6)); keyLight.shadow.mapSize.set(quality === 'low' ? 1024 : 2048, quality === 'low' ? 1024 : 2048);
      if (keyLight.shadow.map) { keyLight.shadow.map.dispose(); keyLight.shadow.map = null; } lastQuality = quality; resize();
    }
    if (state.elapsed < previousElapsed || menu) { steam.clear(); lastImpacts = 0; } previousElapsed = state.elapsed;
    carRoot.position.set(state.pos.x || 0, state.pos.y || 0, state.pos.z || 0); carRoot.quaternion.copy(getQuaternion(state));
    runningLights.visible = assetState.status === 'ready';
    if (menu) wheelAngle = 0; else if (!options.paused && !['landed', 'crashed'].includes(state.phase)) wheelAngle = (wheelAngle + (state.speed || 0) * delta / 0.34) % (Math.PI * 2);
    wheelRotation.setFromAxisAngle(wheelAxis, wheelAngle); for (const wheel of wheels) wheel.node.quaternion.copy(wheel.base).multiply(wheelRotation); carRoot.updateMatrixWorld(true);
    for (const jet of jets) {
      const active = !menu && (state.activeJets || []).includes(jet.definition.key); jet.plume.visible = active;
      if (active) { const power = jet.definition.key === 's' ? 1.35 : 1; jet.plume.scale.set(power, power * (0.88 + Math.sin(time * 42 + jet.index) * 0.08), power); }
    }
    if (!options.paused) {
      emissionTime += delta;
      if (emissionTime >= 0.025) {
        emissionTime %= 0.025;
        for (const jet of jets) if (jet.plume.visible) {
          jet.group.getWorldPosition(emitter); flow.set(0, -4, 0).applyQuaternion(carRoot.quaternion);
          flow.x += (state.vel?.x || 0) * 0.38; flow.y += (state.vel?.y || 0) * 0.38; flow.z += (state.vel?.z || 0) * 0.38;
          steam.emit(emitter, flow); steam.emit(emitter, flow);
        }
      }
      if ((state.contact?.impacts || 0) > lastImpacts) for (let i = 0; i < Math.min(70, 20 + (state.contact.normalImpulse || 0) * 3); i++) {
        const angle = Math.random() * Math.PI * 2; emitter.set(state.pos.x + Math.cos(angle) * 0.7, 0.17, state.pos.z + Math.sin(angle) * 1.5);
        flow.set(Math.cos(angle) * (1.3 + Math.random() * 2), 0.25, Math.sin(angle) * (1.3 + Math.random() * 2)); steam.emit(emitter, flow, true);
      }
      steam.update(delta);
    }
    lastImpacts = state.contact?.impacts || 0;
    scene.userData.shot = setCamera(state, delta); scene.userData.phase = state.phase;
    renderer.render(scene, camera);
  }
  function dispose() { disposed = true; generation++; disposeTree(scene, environment.texture); environment.dispose(); renderer.dispose(); }
  function measureVehicle() {
    if (!carVisual) return null;
    carRoot.updateMatrixWorld(true);
    // Explicit inspection only: walking the loaded GLB is not part of rendering.
    const bounds = new THREE.Box3().setFromObject(carVisual, true);
    const corners = [bounds.min.x, bounds.max.x].flatMap((x) => [bounds.min.y, bounds.max.y]
      .flatMap((y) => [bounds.min.z, bounds.max.z].map((z) => new THREE.Vector3(x, y, z).project(camera).toArray())));
    return { minimumY: bounds.min.y, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }, projectedCorners: corners };
  }
  resize();
  return { render, resize, dispose, measureVehicle, renderer, camera, scene, assetState, loadCarModel };
}
