// Stage Lighting Simulator
// A Three.js scene demonstrating concert/stage lighting effects
//
// @param cameraSpeed float 0.002 [0, 0.01] "Camera rotation speed"
// @param movingHeadSpeed float 0.5 [0.1, 2.0] "Moving head animation speed"
// @param ledBarSpeed float 0.3 [0.1, 1.0] "LED bar color cycle speed"
// @param hazeOpacity float 0.4 [0, 1] "Haze particle opacity"
// @param blinderFlashRate float 2.0 [0.5, 5.0] "Blinder flash rate"
// @param spotIntensity float 50 [10, 100] "Spot light intensity"
// @param movingHeadIntensity float 80 [20, 150] "Moving head intensity"
// @param autoRotate int 1 [0, 1] "Camera auto-rotation"
// @param cameraAngle int 60 [0, 180] "Camera auto-rotation"

function setup(THREE, canvas, params, channels, mouse) {
  // Scene setup
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050508);
  scene.fog = new THREE.FogExp2(0x050508, 0.015);

  const camera = new THREE.PerspectiveCamera(cameraAngle, canvas.width / canvas.height, 0.1, 1000);
  camera.position.set(0, 8, 25);
  camera.lookAt(0, 3, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Ambient light (very dim)
  const ambient = new THREE.AmbientLight(0x111122, 0.3);
  scene.add(ambient);

  // Stage floor
  const stageGeo = new THREE.BoxGeometry(30, 0.5, 20);
  const stageMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.8,
    metalness: 0.2
  });
  const stage = new THREE.Mesh(stageGeo, stageMat);
  stage.position.y = -0.25;
  stage.receiveShadow = true;
  scene.add(stage);

  // Back wall
  const wallGeo = new THREE.BoxGeometry(30, 15, 0.5);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 });
  const backWall = new THREE.Mesh(wallGeo, wallMat);
  backWall.position.set(0, 7, -10);
  backWall.receiveShadow = true;
  scene.add(backWall);

  // Truss system
  const trussMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.8, roughness: 0.3 });

  function createTruss(length) {
    const group = new THREE.Group();
    const radius = 0.08;

    const positions = [[-0.3, 0.3], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3]];

    positions.forEach(([y, z]) => {
      const geo = new THREE.CylinderGeometry(radius, radius, length, 8);
      geo.rotateZ(Math.PI / 2);
      const mesh = new THREE.Mesh(geo, trussMat);
      mesh.position.set(0, y, z);
      group.add(mesh);
    });

    const braceCount = Math.floor(length / 2);
    for (let i = 0; i <= braceCount; i++) {
      const x = -length/2 + i * (length / braceCount);
      const ringGeo = new THREE.TorusGeometry(0.35, 0.04, 8, 4);
      ringGeo.rotateY(Math.PI / 2);
      const ring = new THREE.Mesh(ringGeo, trussMat);
      ring.position.x = x;
      group.add(ring);
    }

    return group;
  }

  // Trusses
  const frontTruss = createTruss(28);
  frontTruss.position.set(0, 10, 5);
  scene.add(frontTruss);

  const backTruss = createTruss(28);
  backTruss.position.set(0, 12, -5);
  scene.add(backTruss);

  const leftTruss = createTruss(12);
  leftTruss.rotation.y = Math.PI / 2;
  leftTruss.position.set(-14, 10, 0);
  scene.add(leftTruss);

  const rightTruss = createTruss(12);
  rightTruss.rotation.y = Math.PI / 2;
  rightTruss.position.set(14, 10, 0);
  scene.add(rightTruss);

  // Arrays to store animated lights
  const movingHeads = [];
  const spotLights = [];
  const barLights = [];

  // Helper to create volumetric cone
  function createLightCone(color, angle = 0.4, length = 12) {
    const coneGeo = new THREE.ConeGeometry(Math.tan(angle) * length, length, 32, 1, true);
    const coneMat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.rotation.x = Math.PI;
    cone.position.y = -length / 2;
    return cone;
  }

  // Create fixture housing
  function createFixtureHousing(type = 'spot') {
    const group = new THREE.Group();
    const housingMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.7, roughness: 0.3 });

    if (type === 'moving') {
      const yokeGeo = new THREE.BoxGeometry(0.6, 0.8, 0.15);
      const yoke = new THREE.Mesh(yokeGeo, housingMat);
      group.add(yoke);

      const headGroup = new THREE.Group();
      const headGeo = new THREE.CylinderGeometry(0.35, 0.4, 0.7, 16);
      headGeo.rotateX(Math.PI / 2);
      const head = new THREE.Mesh(headGeo, housingMat);
      headGroup.add(head);

      const lensGeo = new THREE.CircleGeometry(0.3, 16);
      const lensMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
      const lens = new THREE.Mesh(lensGeo, lensMat);
      lens.position.z = 0.36;
      headGroup.add(lens);

      headGroup.position.y = -0.4;
      group.add(headGroup);
      group.headGroup = headGroup;
      group.lens = lens;
    } else if (type === 'spot') {
      const bodyGeo = new THREE.CylinderGeometry(0.25, 0.35, 0.8, 12);
      const body = new THREE.Mesh(bodyGeo, housingMat);
      body.rotation.x = Math.PI;
      group.add(body);

      const lensGeo = new THREE.CircleGeometry(0.33, 16);
      const lensMat = new THREE.MeshBasicMaterial({ color: 0xffffcc });
      const lens = new THREE.Mesh(lensGeo, lensMat);
      lens.rotation.x = Math.PI / 2;
      lens.position.y = -0.41;
      group.add(lens);
    } else if (type === 'par') {
      const bodyGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.4, 12);
      const body = new THREE.Mesh(bodyGeo, housingMat);
      body.rotation.x = Math.PI / 2;
      group.add(body);
    }

    return group;
  }

  // SPOT LIGHTS - Front truss
  const spotColors = [0xff4444, 0x44ff44, 0x4444ff, 0xffff44, 0xff44ff, 0x44ffff];
  for (let i = 0; i < 6; i++) {
    const x = -12 + i * 4.8;
    const color = spotColors[i];

    const fixture = createFixtureHousing('spot');
    fixture.position.set(x, 9.5, 5);
    fixture.rotation.x = 0.3;
    scene.add(fixture);

    const spot = new THREE.SpotLight(color, params.spotIntensity, 25, 0.4, 0.5, 1);
    spot.position.set(x, 9.2, 5);
    spot.target.position.set(x * 0.3, 0, -2);
    scene.add(spot);
    scene.add(spot.target);

    const cone = createLightCone(color, 0.4, 10);
    cone.position.set(x, 9.2, 5);
    cone.rotation.x = 0.3;
    scene.add(cone);

    spotLights.push({ light: spot, cone, fixture, baseX: x, color });
  }

  // MOVING HEADS - Back truss
  const movingColors = [0xff0066, 0x00ffff, 0xff6600, 0x00ff66, 0x6600ff, 0xffff00];
  for (let i = 0; i < 6; i++) {
    const x = -10 + i * 4;
    const color = movingColors[i];

    const fixture = createFixtureHousing('moving');
    fixture.position.set(x, 11.5, -5);
    scene.add(fixture);

    const spot = new THREE.SpotLight(color, params.movingHeadIntensity, 30, 0.25, 0.3, 1);
    spot.position.set(x, 10.8, -5);
    spot.castShadow = true;
    spot.shadow.mapSize.width = 512;
    spot.shadow.mapSize.height = 512;
    scene.add(spot);
    scene.add(spot.target);

    const cone = createLightCone(color, 0.25, 14);
    scene.add(cone);

    movingHeads.push({
      light: spot,
      cone,
      fixture,
      baseX: x,
      phase: i * Math.PI / 3,
      color
    });
  }

  // LED BARS
  function createLEDBar(width, segments) {
    const group = new THREE.Group();
    const housingGeo = new THREE.BoxGeometry(width, 0.15, 0.2);
    const housingMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.8 });
    const housing = new THREE.Mesh(housingGeo, housingMat);
    group.add(housing);

    const segmentWidth = width / segments;
    const lights = [];

    for (let i = 0; i < segments; i++) {
      const x = -width/2 + segmentWidth/2 + i * segmentWidth;
      const ledGeo = new THREE.PlaneGeometry(segmentWidth * 0.8, 0.1);
      const ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const led = new THREE.Mesh(ledGeo, ledMat);
      led.position.set(x, 0.08, 0);
      led.rotation.x = -Math.PI / 2;
      group.add(led);

      const pointLight = new THREE.PointLight(0xffffff, 2, 4);
      pointLight.position.set(x, 0.2, 0);
      group.add(pointLight);

      lights.push({ mesh: led, light: pointLight, index: i });
    }

    group.lights = lights;
    return group;
  }

  const frontBar1 = createLEDBar(8, 12);
  frontBar1.position.set(-8, 0.1, 8);
  frontBar1.rotation.x = -0.2;
  scene.add(frontBar1);
  barLights.push({ bar: frontBar1, phase: 0 });

  const frontBar2 = createLEDBar(8, 12);
  frontBar2.position.set(8, 0.1, 8);
  frontBar2.rotation.x = -0.2;
  scene.add(frontBar2);
  barLights.push({ bar: frontBar2, phase: Math.PI });

  const backBar = createLEDBar(20, 24);
  backBar.position.set(0, 0.1, -8);
  backBar.rotation.x = 0.8;
  scene.add(backBar);
  barLights.push({ bar: backBar, phase: 0, isBack: true });

  // WASH LIGHTS
  const washColors = [0xff3366, 0x3366ff, 0xff3366, 0x3366ff];
  const washPositions = [[-14, 10, 4], [-14, 10, -4], [14, 10, 4], [14, 10, -4]];

  washPositions.forEach((pos, i) => {
    const color = washColors[i];
    const wash = new THREE.SpotLight(color, 40, 25, 0.8, 0.8, 1);
    wash.position.set(...pos);
    wash.target.position.set(0, 0, pos[2] * 0.5);
    scene.add(wash);
    scene.add(wash.target);

    const cone = createLightCone(color, 0.8, 12);
    cone.position.set(...pos);
    cone.rotation.z = i < 2 ? 0.5 : -0.5;
    scene.add(cone);
  });

  // BLINDERS
  function createBlinder() {
    const group = new THREE.Group();
    const housingGeo = new THREE.BoxGeometry(2, 0.8, 0.4);
    const housingMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.7 });
    const housing = new THREE.Mesh(housingGeo, housingMat);
    group.add(housing);

    const cells = [];
    for (let i = 0; i < 4; i++) {
      const x = -0.75 + i * 0.5;
      const cellGeo = new THREE.CircleGeometry(0.18, 16);
      const cellMat = new THREE.MeshBasicMaterial({ color: 0xffffcc });
      const cell = new THREE.Mesh(cellGeo, cellMat);
      cell.position.set(x, 0, 0.21);
      group.add(cell);

      const light = new THREE.SpotLight(0xffffcc, 0, 15, 0.6, 0.5, 1);
      light.position.set(x, 0, 0.3);
      light.target.position.set(x, -5, 10);
      group.add(light);
      group.add(light.target);

      cells.push({ mesh: cell, light });
    }

    group.cells = cells;
    return group;
  }

  const blinder = createBlinder();
  blinder.position.set(0, 9.5, 5.3);
  blinder.rotation.x = 0.4;
  scene.add(blinder);

  // Haze particles
  const hazeGeo = new THREE.BufferGeometry();
  const hazeCount = 2000;
  const hazePositions = new Float32Array(hazeCount * 3);

  for (let i = 0; i < hazeCount; i++) {
    hazePositions[i * 3] = (Math.random() - 0.5) * 30;
    hazePositions[i * 3 + 1] = Math.random() * 15;
    hazePositions[i * 3 + 2] = (Math.random() - 0.5) * 25;
  }

  hazeGeo.setAttribute('position', new THREE.BufferAttribute(hazePositions, 3));
  const hazeMat = new THREE.PointsMaterial({
    color: 0x666688,
    size: 0.08,
    transparent: true,
    opacity: params.hazeOpacity,
    blending: THREE.AdditiveBlending
  });
  const haze = new THREE.Points(hazeGeo, hazeMat);
  scene.add(haze);

  return {
    scene,
    camera,
    renderer,
    objects: {
      movingHeads,
      spotLights,
      barLights,
      blinder,
      haze,
      hazeMat,
      hazeCount,
      cameraAngle: 0
    }
  };
}

function animate(time, delta, params, objects, mouse, channels) {
  const { movingHeads, spotLights, barLights, blinder, haze, hazeMat, hazeCount } = objects;
  const THREE = window.THREE;

  // Update haze opacity from params
  hazeMat.opacity = params.hazeOpacity;

  // Animate moving heads
  movingHeads.forEach((mh, i) => {
    const speed = params.movingHeadSpeed;
    const pan = Math.sin(time * speed + mh.phase) * 0.8;
    const tilt = Math.sin(time * speed * 1.4 + mh.phase * 1.5) * 0.3 + 0.5;

    if (mh.fixture.headGroup) {
      mh.fixture.headGroup.rotation.x = tilt;
      mh.fixture.rotation.y = pan;
    }

    const targetX = mh.baseX + Math.sin(time * speed + mh.phase) * 8;
    const targetZ = Math.sin(time * speed * 1.4 + mh.phase * 1.5) * 5;
    mh.light.target.position.set(targetX, 0, targetZ);

    mh.cone.position.copy(mh.light.position);
    const dir = new THREE.Vector3().subVectors(mh.light.target.position, mh.light.position).normalize();
    mh.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);

    // Color cycling
    const hue = (time * 0.1 + i * 0.1) % 1;
    const color = new THREE.Color().setHSL(hue, 1, 0.5);
    mh.light.color = color;
    mh.light.intensity = params.movingHeadIntensity;
    mh.cone.material.color = color;
    if (mh.fixture.lens) mh.fixture.lens.material.color = color;
  });

  // Animate LED bars
  const ledSpeed = params.ledBarSpeed;
  barLights.forEach((bl) => {
    bl.bar.lights.forEach((led, i) => {
      const hue = (time * ledSpeed + i * 0.05 + bl.phase) % 1;
      const brightness = (Math.sin(time * 3 + i * 0.3 + bl.phase) + 1) / 2;
      const color = new THREE.Color().setHSL(hue, 1, 0.5 * brightness + 0.2);
      led.mesh.material.color = color;
      led.light.color = color;
      led.light.intensity = brightness * 3;
    });
  });

  // Blinder flash effect
  const blinderOn = Math.sin(time * params.blinderFlashRate) > 0.9;
  blinder.cells.forEach((cell) => {
    cell.light.intensity = blinderOn ? 100 : 0;
    cell.mesh.material.color.setHex(blinderOn ? 0xffffff : 0x333322);
  });

  // Animate spot light intensity
  spotLights.forEach((sl, i) => {
    const pulse = (Math.sin(time * 2 + i * 0.5) + 1) / 2;
    sl.light.intensity = params.spotIntensity * (0.6 + pulse * 0.4);
    sl.cone.material.opacity = 0.05 + pulse * 0.05;
  });

  // Haze drift
  const positions = haze.geometry.attributes.position.array;
  for (let i = 0; i < hazeCount; i++) {
    positions[i * 3 + 1] += 0.005;
    if (positions[i * 3 + 1] > 15) positions[i * 3 + 1] = 0;
  }
  haze.geometry.attributes.position.needsUpdate = true;

  // Camera auto-rotation
  if (params.autoRotate === 1) {
    objects.cameraAngle += params.cameraSpeed;
  }
}

function cleanup(objects) {
  if (objects.haze) {
    objects.haze.geometry.dispose();
    objects.hazeMat.dispose();
  }
}
