import * as THREE from 'three';

// Render the loaded vehicle once into the HUD. This reuses the scene renderer
// and its textures; the small control diagram adds no per-frame 3D rendering.
export function renderControlCar(renderer, model, canvas) {
  if (!canvas) return;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法绘制车辆按键图');
  const width = canvas.width, height = canvas.height;
  const preview = new THREE.Scene();
  const vehicle = model.clone(true);
  preview.add(vehicle, new THREE.HemisphereLight('#ffffff', '#647481', 1.1));
  const light = new THREE.DirectionalLight('#ffffff', 2.4);
  light.position.set(-3, 8, 4);
  preview.add(light);
  const halfHeight = 2.58, halfWidth = halfHeight * width / height;
  const camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0.1, 20);
  camera.position.set(0, 8, 0);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  const target = new THREE.WebGLRenderTarget(width, height);
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const previousTarget = renderer.getRenderTarget();
  const previousColor = renderer.getClearColor(new THREE.Color());
  const previousAlpha = renderer.getClearAlpha();
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(preview, camera);
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    const picture = context.createImageData(width, height);
    for (let row = 0; row < height; row++) {
      const start = (height - row - 1) * width * 4;
      picture.data.set(pixels.subarray(start, start + width * 4), row * width * 4);
    }
    context.putImageData(picture, 0, 0);
    canvas.dataset.ready = 'true';
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousColor, previousAlpha);
    target.dispose();
    // The clone shares its geometry and materials with the live car.
    preview.clear();
  }
}
