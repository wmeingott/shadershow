/*
 * ShaderShow - Three.js Scene
 * ===========================
 * Write a setup() function that creates and returns your scene.
 * Write an animate() function for per-frame updates.
 *
 * Available in setup(THREE, canvas, params):
 *   THREE   - Three.js library
 *   canvas  - The rendering canvas
 *   params  - Custom parameter values
 *
 * animate() signature:
 *   animate(time, deltaTime, params, objects, mouse, channels)
 *
 * Custom Parameters (@param)
 * --------------------------
 * Define custom uniforms with UI controls using @param comments:
 *   // @param name type [default] [min, max] "description"
 *
 * Supported types: int, float, vec2, vec3, vec4, color
 */

// @param rotationSpeed float 1.0 [0.0, 5.0] "Rotation speed"
// @param cubeColor color [0.2, 0.6, 1.0] "Cube color"


// --- Shader für die Lichtstrahlen (Volumetric Beam) ---
    const beamVertexShader = `
        varying vec3 vNormal;
        varying vec3 vWorldPosition;
        void main() {
            vNormal = normalize(normalMatrix * normal);
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `;

    const beamFragmentShader = `
        varying vec3 vNormal;
        varying vec3 vWorldPosition;
        uniform vec3 color;
        uniform float intensity;

        void main() {
            // Ein einfacher Fresnel-ähnlicher Effekt für die Strahlen-Optik
            float viewAngle = dot(vNormal, vec3(0, 0, 1));
            float falloff = pow(1.0 - abs(viewAngle), 3.0);
            
            // Vertikaler Verlauf (oben heller als unten)
            float yAlpha = smoothstep(-5.0, 5.0, vWorldPosition.y + 2.0);
            
            gl_FragColor = vec4(color, falloff * intensity * yAlpha);
        }
    `;
function setup(THREE, canvas, params) {

    // --- Scene Setup ---
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x000000, 5, 25);

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 2, 8);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(renderer.domElement);

    // --- Boden (Reflektierend) ---
    const floorGeo = new THREE.PlaneGeometry(30, 30);
    const floorMat = new THREE.MeshStandardMaterial({ 
        color: 0x111111, 
        roughness: 0.1, 
        metalness: 0.5 
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2;
    scene.add(floor);

    // --- Lichtquellen & Strahlen erstellen ---
    const lightsData = [
        { pos: [-5, 5, 0], color: 0x2266ff, rot: -0.4 }, // Blau links
        { pos: [-2, 5.5, 0], color: 0xff22aa, rot: -0.1 }, // Pink
        { pos: [0.5, 6, 0], color: 0x3388ff, rot: 0.05 }, // Blau mitte
        { pos: [3, 5.5, 0], color: 0xff33bb, rot: 0.2 },  // Pink
        { pos: [6, 5, 0], color: 0xaa22ff, rot: 0.5 }   // Violett rechts
    ];

    const beams = [];

    lightsData.forEach(data => {
        // 1. Das eigentliche Licht (für den Boden)
        const spotLight = new THREE.SpotLight(data.color, 50);
        spotLight.position.set(data.pos[0], data.pos[1], data.pos[2]);
        spotLight.angle = 0.3;
        spotLight.penumbra = 0.5;
        scene.add(spotLight);

        // Target für das Licht
        const target = new THREE.Object3D();
        target.position.set(data.pos[0] + (data.rot * 5), -2, 0);
        scene.add(target);
        spotLight.target = target;

        // 2. Die volumetrische Geometrie (Kegel)
        const beamGeo = new THREE.ConeGeometry(1.5, 12, 32, 1, true);
        const beamMat = new THREE.ShaderMaterial({
            uniforms: {
                color: { value: new THREE.Color(data.color) },
                intensity: { value: 0.4 }
            },
            vertexShader: beamVertexShader,
            fragmentShader: beamFragmentShader,
            transparent: true,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            depthWrite: false
        });

        const beam = new THREE.Mesh(beamGeo, beamMat);
        
        // Positionierung des Kegels (Mitte des Kegels muss korrigiert werden)
        beam.position.set(data.pos[0], data.pos[1] - 4, data.pos[2]);
        beam.rotation.z = data.rot;
        
        scene.add(beam);
        beams.push(beam);
    });

    // Umgebungslicht
    const ambient = new THREE.AmbientLight(0x050505);
    scene.add(ambient);

    // --- Animation --- // Create scene

  return { scene, camera, renderer, beams, renderer, scene, camera };
}

function animate(time, deltaTime, params, objects) {
  const { beams, renderer, scene, camera } = objects;

  // Rotate the cube
  const speed = params.rotationSpeed || 1.0;
       requestAnimationFrame(animate);

        // const time = Date.now() * 0.001;

        // Leichtes Schwingen der Strahlen
        beams.forEach((beam, i) => {
            beam.rotation.z += Math.sin(time + i) * 0.001;
            beam.material.uniforms.intensity.value = 0.3 + Math.sin(time * 2.0 + i) * 0.1;
        });

        renderer.render(scene, camera);
 }