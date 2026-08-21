// intro.js — Three.js intro with floating 3D game planes
// Gracefully degrades to CSS-only if Three.js or WebGPU is unavailable.
// All code lives in an IIFE to avoid polluting the global scope (script.js uses
// the same names like TSV_URL / FALLBACK, which would collide otherwise).

(async () => {

const TSV_URL = 'SteamRevolver - Sheet1.tsv';

async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    return res.text();
}
const FALLBACK = 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=600';

let renderer = null;
let introFinished = false;

async function init() {
    const canvas = document.getElementById('intro-canvas');
    if (!canvas) return;

    // ── 1. Always reveal text after 800ms, regardless of 3D status ──
    setTimeout(() => {
        const text = document.getElementById('intro-text');
        const sub = document.getElementById('intro-sub');
        if (text) text.classList.add('visible');
        if (sub) sub.classList.add('visible');
    }, 800);

    // ── 2. Always auto-finish after 5.5s ──
    setTimeout(() => finishIntro(), 5500);

    // ── 3. Skip button ──
    const skipBtn = document.getElementById('intro-skip');
    if (skipBtn) skipBtn.addEventListener('click', finishIntro);

    // ── 4. Try to load Three.js and render floating planes ──
    try {
        const THREE = await loadThree();
        if (!THREE) {
            console.warn('Intro: Three.js unavailable, using CSS fallback');
            return;
        }

        // Fetch game banner images
        let gameImages = [];
        try {
            const text = (typeof GAME_TSV !== 'undefined' && GAME_TSV) ? GAME_TSV : await fetchText(TSV_URL);
            const rows = text.trim().split('\n');
            const headers = rows[0].split('\t').map(h => h.trim().replace(/^["']|["']$/g, ''));
            const games = rows.slice(1).map(row => {
                const cols = row.split('\t');
                const g = {};
                headers.forEach((h, i) => { g[h] = (cols[i] || '').trim().replace(/^["']|["']$/g, ''); });
                g['Banner Link'] = g['Banner Link'] || g.Banner || g['Image Link'] || '';
                return g;
            }).filter(g => g['Banner Link']);
            gameImages = [...games].sort(() => Math.random() - 0.5).slice(0, 20).map(g => g['Banner Link']);
        } catch (e) {
            console.warn('Intro: could not fetch game data', e);
        }

        while (gameImages.length < 20) gameImages.push(FALLBACK);

        // Scene setup
        const scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x000000, 0.018);

        const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
        camera.position.set(0, 0, 30);

        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.2;

        const clock = new THREE.Clock();

        // Lighting
        scene.add(new THREE.AmbientLight(0x334466, 0.6));
        const p1 = new THREE.PointLight(0x6688bb, 2, 80);
        p1.position.set(10, 10, 20);
        scene.add(p1);
        const p2 = new THREE.PointLight(0x445577, 1.5, 60);
        p2.position.set(-10, -5, 15);
        scene.add(p2);

        // Create floating planes
        const loader = new THREE.TextureLoader();
        loader.crossOrigin = 'anonymous';
        const planes = [];
        const planeW = 4.5;
        const planeH = 3;

        for (let i = 0; i < 20; i++) {
            const geo = new THREE.PlaneGeometry(planeW, planeH, 1, 1);
            const mat = new THREE.MeshStandardMaterial({
                color: 0x1a2a3a,
                roughness: 0.7,
                metalness: 0.1,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0,
            });

            const mesh = new THREE.Mesh(geo, mat);
            const angle = (i / 20) * Math.PI * 2;
            const radius = 12 + Math.random() * 20;
            const height = (Math.random() - 0.5) * 16;

            mesh.position.set(
                Math.cos(angle) * radius + (Math.random() - 0.5) * 10,
                height,
                Math.sin(angle) * radius * 0.5 - 10 + (Math.random() - 0.5) * 8
            );

            mesh.rotation.x = (Math.random() - 0.5) * 0.4;
            mesh.rotation.y = (Math.random() - 0.5) * 0.6;
            mesh.rotation.z = (Math.random() - 0.5) * 0.15;

            mesh.userData = {
                basePos: mesh.position.clone(),
                speed: 0.2 + Math.random() * 0.4,
                rotSpeed: (Math.random() - 0.5) * 0.3,
                driftX: (Math.random() - 0.5) * 0.02,
                driftY: (Math.random() - 0.5) * 0.015,
                driftZ: (Math.random() - 0.5) * 0.01,
                phase: Math.random() * Math.PI * 2,
                delay: 0.3 + i * 0.15,
                fadeIn: false,
                startTime: null,
            };

            scene.add(mesh);
            planes.push(mesh);

            const url = gameImages[i % gameImages.length];
            loader.load(url, (texture) => {
                texture.colorSpace = THREE.SRGBColorSpace;
                texture.minFilter = THREE.LinearFilter;
                texture.magFilter = THREE.LinearFilter;
                mat.map = texture;
                mat.color.set(0xffffff);
                mat.needsUpdate = true;
            }, undefined, () => { /* keep fallback color */ });
        }

        // Mouse tracking
        let mouseX = 0, mouseY = 0;
        document.addEventListener('mousemove', (e) => {
            mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
            mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
        });

        // Resize
        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });

        // Animation loop
        function animate() {
            if (introFinished) return;
            requestAnimationFrame(animate);
            const t = clock.getElapsedTime();

            camera.position.x += (mouseX * 2 - camera.position.x) * 0.02;
            camera.position.y += (-mouseY * 1.5 - camera.position.y) * 0.02;
            camera.lookAt(0, 0, 0);

            for (const mesh of planes) {
                const d = mesh.userData;
                if (!d.fadeIn && t > d.delay) {
                    d.fadeIn = true;
                    d.startTime = t;
                }
                if (d.fadeIn) {
                    const progress = Math.min((t - d.startTime) / 1.2, 1);
                    mesh.material.opacity = easeOutCubic(progress) * 0.85;
                }

                const wave = Math.sin(t * d.speed + d.phase);
                mesh.position.x = d.basePos.x + wave * 0.8 + d.driftX * t * 10;
                mesh.position.y = d.basePos.y + Math.cos(t * d.speed * 0.7 + d.phase) * 0.5 + d.driftY * t * 10;
                mesh.position.z = d.basePos.z + Math.sin(t * d.speed * 0.5 + d.phase * 2) * 0.3 + d.driftZ * t * 10;

                mesh.rotation.y += d.rotSpeed * 0.01;
                mesh.rotation.x += d.rotSpeed * 0.003;

                if (mesh.position.z > 25) mesh.position.z -= 50;
                if (mesh.position.z < -40) mesh.position.z += 50;
            }

            renderer.render(scene, camera);
        }

        animate();

    } catch (err) {
        console.warn('Intro: 3D scene failed, CSS fallback active', err);
    }
}

// Dynamically import Three.js — returns null if unavailable
async function loadThree() {
    try {
        const mod = await import('https://cdn.jsdelivr.net/npm/three@0.163.0/build/three.module.js');
        return mod;
    } catch (e) {
        console.warn('Three.js import failed:', e);
        return null;
    }
}

function easeOutCubic(x) {
    return 1 - Math.pow(1 - x, 3);
}

function finishIntro() {
    if (introFinished) return;
    introFinished = true;

    const overlay = document.getElementById('intro-overlay');
    if (overlay) {
        overlay.classList.add('fade-out');
        setTimeout(() => overlay.remove(), 1200);
    }

    if (renderer) {
        try {
            renderer.dispose();
            renderer.forceContextLoss();
        } catch (e) { /* ignore */ }
    }
}

// Start immediately
init();

})();
