// Rolling Dice - Three.js Scene Example
// A simple dice that continuously rolls across the screen

// @param speed float 1.0 [0.1, 3.0] "Roll speed"
// @param bounceHeight float 0.5 [0.0, 2.0] "Bounce height"
// @param diceSize float 1.0 [0.5, 2.0] "Dice size"

function setup(THREE, canvas, params) {
  // Create scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  // Create camera
  const camera = new THREE.PerspectiveCamera(
    60,
    canvas.width / canvas.height,
    0.1,
    1000
  );
  camera.position.set(0, 4, 6);
  camera.lookAt(0, 0, 0);

  // Create renderer
  const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    preserveDrawingBuffer: true
  });
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Create dice geometry
  const diceGeometry = new THREE.BoxGeometry(1, 1, 1);

  // Create materials for each face with dot patterns
  const diceMaterials = createDiceMaterials(THREE);

  // Create dice mesh
  const dice = new THREE.Mesh(diceGeometry, diceMaterials);
  dice.castShadow = true;
  dice.receiveShadow = true;
  dice.position.y = 1;
  scene.add(dice);

  // Create ground plane
  const groundGeometry = new THREE.PlaneGeometry(20, 20);
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x2d3436,
    roughness: 0.8,
    metalness: 0.2
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  ground.receiveShadow = true;
  scene.add(ground);

  // Add grid helper for visual reference
  const gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x333333);
  gridHelper.position.y = 0.01;
  scene.add(gridHelper);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);

  const mainLight = new THREE.DirectionalLight(0xffffff, 1.0);
  mainLight.position.set(5, 10, 5);
  mainLight.castShadow = true;
  mainLight.shadow.mapSize.width = 2048;
  mainLight.shadow.mapSize.height = 2048;
  mainLight.shadow.camera.near = 0.5;
  mainLight.shadow.camera.far = 50;
  mainLight.shadow.camera.left = -10;
  mainLight.shadow.camera.right = 10;
  mainLight.shadow.camera.top = 10;
  mainLight.shadow.camera.bottom = -10;
  scene.add(mainLight);

  // Add some colored accent lights
  const redLight = new THREE.PointLight(0xff6b6b, 0.5, 10);
  redLight.position.set(-3, 2, 3);
  scene.add(redLight);

  const blueLight = new THREE.PointLight(0x4ecdc4, 0.5, 10);
  blueLight.position.set(3, 2, -3);
  scene.add(blueLight);

  return {
    scene,
    camera,
    renderer,
    dice,
    ground
  };
}

function animate(time, delta, params, objects) {
  const { dice } = objects;
  const speed = params.speed || 1.0;
  const bounceHeight = params.bounceHeight || 0.5;
  const diceSize = params.diceSize || 1.0;

  // Update dice scale
  dice.scale.setScalar(diceSize);

  // Rolling animation
  const rollSpeed = speed * 2;
  dice.rotation.x += delta * rollSpeed * 3;
  dice.rotation.z += delta * rollSpeed * 2;

  // Bounce animation
  const bounceFreq = speed * 2;
  const bounce = Math.abs(Math.sin(time * bounceFreq)) * bounceHeight;
  dice.position.y = 0.5 * diceSize + bounce;

  // Slight horizontal movement (rolling back and forth)
  dice.position.x = Math.sin(time * speed * 0.5) * 2;
  dice.position.z = Math.cos(time * speed * 0.3) * 1.5;

  // Add slight wobble to rotation based on bounce
  dice.rotation.y = Math.sin(time * speed) * 0.3;
}

function cleanup(objects) {
  // Dispose of geometries and materials
  if (objects.dice) {
    objects.dice.geometry.dispose();
    if (Array.isArray(objects.dice.material)) {
      objects.dice.material.forEach(m => m.dispose());
    }
  }
  if (objects.ground) {
    objects.ground.geometry.dispose();
    objects.ground.material.dispose();
  }
}

// Helper function to create dice face materials with dots
function createDiceMaterials(THREE) {
  const faceColors = [
    0xe74c3c, // 1 - red
    0xf39c12, // 2 - orange
    0x2ecc71, // 3 - green
    0x3498db, // 4 - blue
    0x9b59b6, // 5 - purple
    0x1abc9c  // 6 - teal
  ];

  const dotPatterns = [
    [[0.5, 0.5]], // 1
    [[0.25, 0.25], [0.75, 0.75]], // 2
    [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]], // 3
    [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]], // 4
    [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]], // 5
    [[0.25, 0.25], [0.75, 0.25], [0.25, 0.5], [0.75, 0.5], [0.25, 0.75], [0.75, 0.75]] // 6
  ];

  // Order for cube faces: +X, -X, +Y, -Y, +Z, -Z
  // Standard dice: opposite faces sum to 7
  // So: 1-6, 2-5, 3-4
  const faceOrder = [2, 5, 1, 6, 3, 4]; // Maps to standard dice layout

  return faceOrder.map((num, index) => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    // Fill background
    ctx.fillStyle = '#' + faceColors[num - 1].toString(16).padStart(6, '0');
    ctx.fillRect(0, 0, 256, 256);

    // Draw rounded rectangle border
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = 8;
    roundRect(ctx, 10, 10, 236, 236, 20);
    ctx.stroke();

    // Draw dots
    ctx.fillStyle = '#ffffff';
    const dots = dotPatterns[num - 1];
    const dotRadius = 22;

    dots.forEach(([x, y]) => {
      ctx.beginPath();
      ctx.arc(x * 256, y * 256, dotRadius, 0, Math.PI * 2);
      ctx.fill();

      // Add subtle shadow to dots
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    return new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.4,
      metalness: 0.1
    });
  });
}

// Helper function to draw rounded rectangle
function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
