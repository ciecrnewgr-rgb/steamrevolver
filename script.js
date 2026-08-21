const TSV_URL = 'SteamRevolver - Sheet1.tsv';

async function fetchText(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(res.status);
    return res.text();
}
const FALLBACK = 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=600';

let allGames = [];
let featured = [];
let heroIdx = 0;
let searching = false;
let savedScroll = 0;
let accountOpen = false;

const $ = (s) => document.querySelector(s);
const LIKES_KEY = 'steamrevolver_likes';

/* ===== LIKED GAMES (cached locally) ===== */
function getLikes() {
    try {
        return JSON.parse(localStorage.getItem(LIKES_KEY)) || [];
    } catch (e) { return []; }
}
function saveLikes(likes) {
    try { localStorage.setItem(LIKES_KEY, JSON.stringify(likes)); } catch (e) { /* ignore */ }
}
function isLiked(name) { return getLikes().includes(name); }
function toggleLike(name) {
    let likes = getLikes();
    if (likes.includes(name)) likes = likes.filter(n => n !== name);
    else likes.push(name);
    saveLikes(likes);
    updateLikedUI();
    return likes.includes(name);
}
function likedGames() { return allGames.filter(g => isLiked(g.Name)); }
function updateLikedUI() {
    const badge = $('#profile-liked-count');
    if (badge) {
        const n = getLikes().length;
        badge.textContent = n;
        badge.classList.toggle('hidden', n === 0);
    }
    // Sync hearts on all visible cards
    document.querySelectorAll('.game-card').forEach(card => {
        const heart = card.querySelector('.card-heart');
        const name = card.dataset.name;
        if (heart && name) heart.classList.toggle('liked', isLiked(name));
    });
    // Refresh liked list if account page is open
    if (accountOpen) renderAccount();
}

document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    updateLikedUI();
    initSpace();

    // Load data immediately (in parallel with intro playing)
    load().then(count => {
        console.log(`Loaded ${count} games`);
    }).catch(e => console.error('Load error:', e));

    // Auto-refresh: pick up new TSV entries without reloading the page
    startAutoRefresh(20000);

    // Wait for intro to finish (with fallback timeout)
    await new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        const check = () => {
            if (!document.getElementById('intro-overlay')) finish();
            else requestAnimationFrame(check);
        };
        check();
        setTimeout(finish, 8000);
    });

    // Remove loading overlay if it exists
    const o = $('#loading-overlay');
    if (o) o.remove();
});

/* ===== EVENTS ===== */
function bindEvents() {
    const scroll = $('#scroll-area');

    // Nav
    $('#nav-library')?.addEventListener('click', e => { e.preventDefault(); $('#space-landing')?.scrollIntoView({ behavior: 'smooth' }); });
    $('#nav-collections')?.addEventListener('click', e => { e.preventDefault(); $('#franchise-section')?.scrollIntoView({ behavior: 'smooth' }); });
    $('#explore-btn')?.addEventListener('click', () => $('#categories-section')?.scrollIntoView({ behavior: 'smooth' }));

    // Search
    $('#search-trigger')?.addEventListener('click', openSearch);
    $('#search-close')?.addEventListener('click', closeSearch);
    $('#search-input')?.addEventListener('input', e => renderSearch(e.target.value));

    // Account
    $('#profile-btn')?.addEventListener('click', openAccount);
    $('#account-close')?.addEventListener('click', closeAccount);

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            if (!$('#search-page')?.classList.contains('hidden')) closeSearch();
            else if (!$('#account-page')?.classList.contains('hidden')) closeAccount();
            else if (!$('#game-modal')?.classList.contains('hidden')) closeGameModal();
            else if (!$('#collection-modal')?.classList.contains('hidden')) closeModal();
        }
        if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); openSearch(); }
    });

    // Hero nav
    $('#hero-prev')?.addEventListener('click', e => { e.stopPropagation(); prevHero(); });
    $('#hero-next')?.addEventListener('click', e => { e.stopPropagation(); nextHero(); });
    $('#hero-banner')?.addEventListener('click', () => { if (featured[heroIdx]) openGameModal(featured[heroIdx]); });
    $('#hero-link')?.addEventListener('click', e => { e.preventDefault(); if (featured[heroIdx]) openGameModal(featured[heroIdx]); });

    // Modal
    $('#modal-close')?.addEventListener('click', closeModal);
    $('#modal-backdrop')?.addEventListener('click', closeModal);

    // Game modal
    $('#game-modal-close')?.addEventListener('click', closeGameModal);
    $('#game-modal-backdrop')?.addEventListener('click', closeGameModal);

    // Refresh
    $('#refresh-btn')?.addEventListener('click', () => {
        disposeSpace3D();
        load();
    });
}

/* ===== DATA ===== */
let lastSignature = '';

// Try to fetch the live TSV; fall back to embedded data.js if unavailable
let liveTsvWarned = false;
async function getTSVText() {
    // Cache-bust so new TSV edits are always picked up
    const busted = `${TSV_URL}?v=${Date.now()}`;
    try {
        return await fetchText(busted);
    } catch (e) {
        if (!liveTsvWarned) {
            console.warn('Live TSV unavailable (file:// protocol?), using embedded data.js. Serve over http:// to pick up TSV edits automatically.', e);
            liveTsvWarned = true;
        }
        if (typeof GAME_TSV !== 'undefined' && GAME_TSV) return GAME_TSV;
        throw e;
    }
}

function parseTSV(text) {
    const rows = text.trim().split('\n');
    if (!rows.length) return [];
    const headers = rows[0].split('\t').map(h => h.trim().replace(/^["']|["']$/g, ''));
    return rows.slice(1).map(row => {
        const cols = row.split('\t');
        const g = {};
        headers.forEach((h, i) => { g[h] = (cols[i] || '').trim().replace(/^["']|["']$/g, ''); });
        g.Name = g.Name || g['Game Title'] || 'Unknown';
        g['Banner Link'] = g['Banner Link'] || g.Banner || g['Image Link'] || '';
        g.link = g.link || g['Download Link'] || g.URL || '#';
        return g;
    }).filter(g => g.Name !== 'Unknown');
}

// Rebuilds featured list without disturbing the current hero index
function refreshFeatured() {
    featured = [...allGames].sort(() => Math.random() - 0.5).slice(0, 10);
    if (heroIdx >= featured.length) heroIdx = 0;
}

async function load() {
    try {
        const text = await getTSVText();

        // Only re-render when the data actually changed
        const signature = String(text.trim().split('\n').length) + ':' + (text.trim().split('\n').pop() || '').slice(0, 40);
        if (signature === lastSignature && allGames.length) {
            return allGames.length;
        }
        lastSignature = signature;

        const games = parseTSV(text);
        if (!games.length) return 0;
        allGames = games;
        allGames.sort((a, b) => a.Name.localeCompare(b.Name));
        refreshFeatured();

        disposeSpace3D();
        initSpace3D();
        renderHero();
        renderRecent();
        renderCategories();
        initReveal();
        return allGames.length;
    } catch (e) { console.error('Load error:', e); return 0; }
}

// Poll for TSV changes so new games show up automatically
function startAutoRefresh(intervalMs = 20000) {
    setInterval(async () => {
        try {
            await load();
        } catch (e) { /* silent */ }
    }, intervalMs);
}

/* ===== SPACE ===== */
let space3D = null; // { renderer, scene, camera, planes, raf, clock }

// Fallback: CSS float-cards (used if Three.js fails to load)
function renderSpaceCards() {
    const box = $('#space-banners');
    if (!box) return;
    const spots = [
        { x: '-40vw', y: '-16vh', rot: '-10deg', dur: '6.2s', start: '-1.1s' },
        { x: '-36vw', y: '20vh', rot: '8deg', dur: '7.1s', start: '-3.2s' },
        { x: '40vw', y: '-18vh', rot: '9deg', dur: '6.8s', start: '-2.4s' },
        { x: '37vw', y: '22vh', rot: '-7deg', dur: '7.4s', start: '-4.1s' },
        { x: '-20vw', y: '-30vh', rot: '5deg', dur: '6.5s', start: '-2s' },
        { x: '21vw', y: '-28vh', rot: '-6deg', dur: '7.8s', start: '-5s' },
        { x: '-21vw', y: '30vh', rot: '-4deg', dur: '6.9s', start: '-3.8s' },
        { x: '22vw', y: '30vh', rot: '7deg', dur: '7.6s', start: '-1.8s' },
    ];
    const pick = [...allGames].sort(() => Math.random() - 0.5).slice(0, spots.length);
    box.innerHTML = '';
    pick.forEach((g, i) => {
        const s = spots[i];
        const badge = statusBadge(g['Is It Working?']);
        const el = document.createElement('div');
        el.className = 'float-card';
        el.style.cssText = `--x:${s.x};--y:${s.y};--rot:${s.rot};--dur:${s.dur};--start:${s.start};--delay:${i * 60}ms`;
        el.innerHTML = `<div class="float-inner" onclick="window.open('${g.link}','_blank')">
            <img src="${g['Banner Link'] || FALLBACK}" alt="${g.Name}" referrerpolicy="no-referrer" onerror="this.src='${FALLBACK}'">
            <span class="float-status">${badge.label}</span>
            <span class="float-name">${g.Name}</span>
        </div>`;
        box.appendChild(el);
    });
}

// Real 3D floating banner planes (Three.js + WebGPU, WebGL fallback)
async function initSpace3D() {
    const canvas = $('#space3d-canvas');
    if (!canvas || space3D) return;

    let THREE, renderer;
    try {
        // Prefer the WebGPU build when the browser supports it
        if (navigator.gpu) {
            try {
                const wgpu = await import('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.webgpu.js');
                const r = new wgpu.WebGPURenderer({ canvas, alpha: true, antialias: true });
                await r.init();
                THREE = wgpu;
                renderer = r;
            } catch (e) {
                console.warn('WebGPU renderer failed, falling back to WebGL:', e);
                THREE = await import('https://cdn.jsdelivr.net/npm/three@0.163.0/build/three.module.js');
                renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
            }
        } else {
            THREE = await import('https://cdn.jsdelivr.net/npm/three@0.163.0/build/three.module.js');
            renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
        }
    } catch (err) {
        console.warn('Three.js unavailable, using CSS fallback banners:', err);
        renderSpaceCards();
        return;
    }

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x020305, 0.02);

    const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 200);
    camera.position.set(0, 0, 16);

    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if (THREE.ACESFilmicToneMapping !== undefined) {
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.1;
    }
    try { renderer.setClearColor(0x000000, 0); } catch (e) { /* optional */ }

    // Subtle fill light so planes feel lit in the void
    const light = new THREE.AmbientLight(0x8899bb, 1.2);
    scene.add(light);

    const loader = new THREE.TextureLoader();
    loader.crossOrigin = 'anonymous';

    const COUNT = 14;
    const planes = [];
    const picks = [...allGames].sort(() => Math.random() - 0.5).slice(0, COUNT);

    picks.forEach((g, i) => {
        // Slightly rounded banner plane
        const geo = new THREE.PlaneGeometry(5.2, 2.93, 1, 1);
        const mat = new THREE.MeshBasicMaterial({
            map: null,
            color: 0x1a2a3a,
            transparent: true,
            opacity: 0,
            side: THREE.DoubleSide,
            depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);

        // Scatter in a wide arc around the camera, facing inward
        const angle = (i / COUNT) * Math.PI * 2 + Math.random() * 0.5;
        const radius = 10 + Math.random() * 9;
        const height = (Math.random() - 0.5) * 7;
        mesh.position.set(
            Math.cos(angle) * radius,
            height,
            Math.sin(angle) * radius * 0.6 - 2 + (Math.random() - 0.5) * 4
        );
        mesh.lookAt(0, height * 0.6, 0);
        mesh.rotation.z += (Math.random() - 0.5) * 0.12;

        mesh.userData = {
            basePos: mesh.position.clone(),
            speed: 0.15 + Math.random() * 0.3,
            rotSpeed: (Math.random() - 0.5) * 0.25,
            phase: Math.random() * Math.PI * 2,
            delay: 0.2 + i * 0.09,
            startTime: null,
            fadeIn: false,
            game: g,
        };

        scene.add(mesh);
        planes.push(mesh);

        const url = g['Banner Link'] || FALLBACK;
        loader.load(url, (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            mat.map = tex;
            mat.color.set(0xffffff);
            mat.needsUpdate = true;
        }, undefined, () => {
            loader.load(FALLBACK, (tex) => {
                tex.colorSpace = THREE.SRGBColorSpace;
                mat.map = tex;
                mat.color.set(0xffffff);
                mat.needsUpdate = true;
            });
        });
    });

    // Mouse parallax
    let mouseX = 0, mouseY = 0;
    const onMouse = (e) => {
        mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
        mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    document.addEventListener('mousemove', onMouse);

    // Click a plane to open its game link
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onClick = (e) => {
        const rect = canvas.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(planes);
        if (hits.length && hits[0].object.userData.game) {
            openGameModal(hits[0].object.userData.game);
        }
    };
    canvas.addEventListener('click', onClick);

    // Resize
    const onResize = () => {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    const clock = new THREE.Clock();

    function animate() {
        if (!space3D) return;
        requestAnimationFrame(animate);
        const t = clock.getElapsedTime();

        // Gentle camera sway following the mouse
        camera.position.x += (mouseX * 1.4 - camera.position.x) * 0.02;
        camera.position.y += (-mouseY * 0.9 - camera.position.y) * 0.02;
        camera.lookAt(0, 0, 0);

        for (const mesh of planes) {
            const d = mesh.userData;
            // Staggered fade-in
            if (!d.fadeIn && t > d.delay) { d.fadeIn = true; d.startTime = t; }
            if (d.fadeIn) {
                const p = Math.min((t - d.startTime) / 1.1, 1);
                mesh.material.opacity = easeOutCubic(p) * 0.92;
            }

            // Floating drift
            const wave = Math.sin(t * d.speed + d.phase);
            mesh.position.x = d.basePos.x + wave * 0.9;
            mesh.position.y = d.basePos.y + Math.cos(t * d.speed * 0.7 + d.phase) * 0.6;
            mesh.position.z = d.basePos.z + Math.sin(t * d.speed * 0.5 + d.phase * 2) * 0.5;

            // Slow rotation
            mesh.rotation.y = Math.sin(t * d.speed * 0.4 + d.phase) * 0.12 + d.rotSpeed;
            mesh.rotation.z += 0.0005;
        }

        renderer.render(scene, camera);
    }

    space3D = { renderer, scene, camera, planes, clock, onMouse, onResize, onClick };
    $('#space-landing').classList.add('three-d-active');
    animate();
}

function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }

// Stop the 3D scene (used on refresh to rebuild with new data)
function disposeSpace3D() {
    if (!space3D) return;
    const { renderer, scene, onMouse, onResize, onClick } = space3D;
    document.removeEventListener('mousemove', onMouse);
    window.removeEventListener('resize', onResize);
    const canvas = $('#space3d-canvas');
    if (canvas) canvas.removeEventListener('click', onClick);
    scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
            if (o.material.map) o.material.map.dispose();
            o.material.dispose();
        }
    });
    renderer.dispose();
    space3D = null;
    $('#space-landing').classList.remove('three-d-active');
}

function initSpace() {
    const c = $('#space-canvas');
    if (!c || !navigator.gpu) return;
    navigator.gpu.requestAdapter().then(adapter => {
        if (!adapter) return;
        adapter.requestDevice().then(device => {
            const ctx = c.getContext('webgpu');
            if (!ctx) return;
            const fmt = navigator.gpu.getPreferredCanvasFormat();
            const resize = () => {
                const dpr = Math.min(devicePixelRatio || 1, 2);
                const w = Math.max(1, c.clientWidth * dpr | 0);
                const h = Math.max(1, c.clientHeight * dpr | 0);
                if (c.width === w && c.height === h) return;
                c.width = w; c.height = h;
                ctx.configure({ device, format: fmt, alphaMode: 'premultiplied' });
            };
            resize();
            addEventListener('resize', resize, { passive: true });

            const mod = device.createShaderModule({ code: `
                struct U { time:f32, aspect:f32, _a:f32, _b:f32 };
                @group(0) @binding(0) var<uniform> u:U;
                struct Out { @builtin(position) pos:vec4f, @location(0) uv:vec2f, @location(1) br:f32 };
                @vertex fn v(@builtin(vertex_index) vi:u32, @builtin(instance_index) ii:u32) -> Out {
                    var corners = array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
                    let s = f32(ii);
                    let xs = fract(sin(s*12.9898)*43758.5453);
                    let ys = fract(sin(s*78.233)*43758.5453);
                    let sp = 0.002+fract(sin(s*39.425)*15731.743)*0.008;
                    let x = xs*2.0-1.0;
                    let y = fract(ys+u.time*sp)*2.0-1.0;
                    let sz = 0.0015+fract(sin(s*91.17)*24634.6345)*0.0035;
                    var o:Out;
                    o.pos = vec4f(x+corners[vi].x*sz/u.aspect, y+corners[vi].y*sz, 0, 1);
                    o.uv = corners[vi]; o.br = 0.3+xs*0.7;
                    return o;
                }
                @fragment fn f(i:Out) -> @location(0) vec4f {
                    if length(i.uv)>1.0 { discard; }
                    return vec4f(0.68,0.78,1.0, (1.0-length(i.uv))*i.br*0.75);
                }
            `});
            const pipe = device.createRenderPipeline({
                layout:'auto',
                vertex:{ module:mod, entryPoint:'v' },
                fragment:{ module:mod, entryPoint:'f', targets:[{ format:fmt, blend:{ color:{ srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add' }, alpha:{ srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add' } } }] },
                primitive:{ topology:'triangle-list' }
            });
            const buf = device.createBuffer({ size:16, usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST });
            const bg = device.createBindGroup({ layout:pipe.getBindGroupLayout(0), entries:[{ binding:0, resource:{ buffer:buf } }] });

            const draw = (t) => {
                resize();
                device.queue.writeBuffer(buf, 0, new Float32Array([t/1000, c.width/c.height, 0, 0]));
                const enc = device.createCommandEncoder();
                const pass = enc.beginRenderPass({ colorAttachments:[{ view:ctx.getCurrentTexture().createView(), clearValue:{r:0,g:0,b:0,a:0}, loadOp:'clear', storeOp:'store' }] });
                pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.draw(6, 700); pass.end();
                device.queue.submit([enc.finish()]);
                requestAnimationFrame(draw);
            };
            requestAnimationFrame(draw);
        });
    }).catch(() => {});
}

/* ===== HERO ===== */
function renderHero() {
    if (!featured.length) return;
    const g = featured[heroIdx];
    $('#hero-banner').style.backgroundImage = `url('${g['Banner Link'] || FALLBACK}')`;
    $('#hero-title').textContent = g.Name;
    $('#hero-link').href = g.link;
}
function nextHero() { if (!featured.length) return; heroIdx = (heroIdx + 1) % featured.length; renderHero(); }
function prevHero() { if (!featured.length) return; heroIdx = (heroIdx - 1 + featured.length) % featured.length; renderHero(); }
setInterval(() => { if (!searching && featured.length) nextHero(); }, 10000);

/* ===== RECENTLY ADDED ===== */
function renderRecent() {
    const list = $('#recent-list');
    const cnt = $('#recent-count');
    if (!list) return;
    const recent = [...allGames].reverse().slice(0, 8);
    cnt.textContent = recent.length;
    list.innerHTML = '';
    recent.forEach(g => {
        const b = statusBadge(g['Is It Working?']);
        const el = document.createElement('div');
        el.className = 'recent-item';
        el.onclick = () => openGameModal(g);
        el.innerHTML = `<img src="${g['Banner Link'] || FALLBACK}" alt="${g.Name}" referrerpolicy="no-referrer" onerror="this.src='${FALLBACK}'">
            <div class="recent-info"><span class="recent-badge ${b.cls}">${b.label}</span><h3>${g.Name}</h3></div>`;
        list.appendChild(el);
    });
}

/* ===== CATEGORIES ===== */
function renderCategories() {
    const sec = $('#categories-section');
    sec.innerHTML = '';

    // Franchises
    const franchises = extractFranchises();
    if (franchises.length) {
        const wrap = document.createElement('div');
        wrap.id = 'franchise-section';
        wrap.innerHTML = `<div class="section-header"><h2>Franchise Collections</h2></div><div class="franchise-grid"></div>`;
        const grid = wrap.querySelector('.franchise-grid');
        franchises.forEach(f => {
            const card = document.createElement('div');
            card.className = 'franchise-card';
            card.onclick = () => openModal(f.title, f.games);
            card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <h3>${f.title}</h3><span class="franchise-count">${f.games.length} Games</span></div>
                <div class="franchise-thumbs">${f.games.slice(0, 3).map(g => `<img src="${g['Banner Link'] || FALLBACK}" referrerpolicy="no-referrer" onerror="this.src='${FALLBACK}'">`).join('')}</div>`;
            grid.appendChild(card);
        });
        sec.appendChild(wrap);
    }

    // Complete Catalog
    const catWrap = document.createElement('div');
    catWrap.innerHTML = `<div class="section-header"><h2>Complete Catalog</h2><span>${allGames.length} Items</span></div><div class="catalog-grid"></div>`;
    const grid = catWrap.querySelector('.catalog-grid');
    allGames.forEach(g => grid.appendChild(makeCard(g, 'card-lg')));
    sec.appendChild(catWrap);
}

function extractFranchises() {
    const known = ['Resident Evil','Silent Hill','Grand Theft Auto','Call of Duty','Five Nights at Freddy','Outlast','Amnesia','Fallout','Half-Life','Tomb Raider','Final Fantasy','Need for Speed','Devil May Cry','Halo','Batman'];
    const groups = {};
    allGames.forEach(g => {
        for (const f of known) {
            if (g.Name.toLowerCase().startsWith(f.toLowerCase())) {
                (groups[f] = groups[f] || []).push(g);
                break;
            }
        }
    });
    return Object.entries(groups).filter(([,v]) => v.length >= 2).map(([k, v]) => ({ title: `${k} Franchise`, games: v }));
}

/* ===== CARDS ===== */
function makeCard(g, size = 'card-md') {
    const b = statusBadge(g['Is It Working?']);
    const card = document.createElement('div');
    card.className = `game-card ${size}`;
    card.dataset.name = g.Name;
    card.onclick = () => openGameModal(g);
    const nameJs = g.Name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    card.innerHTML = `<img src="${g['Banner Link'] || FALLBACK}" alt="${g.Name}" referrerpolicy="no-referrer" onerror="this.src='${FALLBACK}'">
        <button class="card-heart ${isLiked(g.Name) ? 'liked' : ''}" title="${isLiked(g.Name) ? 'Unlike' : 'Like'}" onclick="event.stopPropagation(); toggleLike('${nameJs}');">
            <i class="fa-solid fa-heart"></i>
        </button>
        <div class="card-overlay"><span class="card-badge ${b.cls}">${b.label}</span><span class="card-name">${g.Name}</span></div>`;
    return card;
}

function statusBadge(s) {
    const v = (s || '').toLowerCase();
    if (v === 'yes' || v === 'working' || v === 'ready') return { label: 'Ready', cls: 'badge-ready' };
    if (v === 'no' || v === 'broken') return { label: 'Broken', cls: 'badge-broken' };
    if (v.includes('testing')) return { label: 'Testing', cls: 'badge-testing' };
    return { label: 'Ready', cls: 'badge-ready' };
}

/* ===== SEARCH ===== */
function openSearch() {
    if (accountOpen) closeAccount();
    savedScroll = $('#scroll-area')?.scrollTop || 0;
    searching = true;
    const pg = $('#search-page');
    pg.classList.remove('hidden');
    pg.style.display = '';
    renderSearch('');
    requestAnimationFrame(() => $('#search-input')?.focus());
}
function closeSearch() {
    const pg = $('#search-page');
    pg.classList.add('hidden');
    pg.style.display = '';
    searching = false;
    const scroll = $('#scroll-area');
    if (scroll) { scroll.scrollTop = savedScroll; }
}
function renderSearch(q) {
    const box = $('#search-results');
    const meta = $('#search-meta');
    if (!box) return;
    const nq = q.trim().toLowerCase();
    const hits = nq ? allGames.filter(g => g.Name.toLowerCase().includes(nq)) : allGames;
    meta.textContent = nq ? `${hits.length} game${hits.length !== 1 ? 's' : ''} matching "${q.trim()}"` : `${hits.length} games in the archive`;
    box.innerHTML = '';
    if (!hits.length) { box.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--muted)"><i class="fa-solid fa-satellite-dish" style="font-size:24px;display:block;margin-bottom:8px"></i><strong style="color:#fff">No games found</strong><br><span>Try another title or browse the full archive.</span></div>'; return; }
    hits.forEach(g => box.appendChild(makeCard(g, 'card-lg')));
}

/* ===== ACCOUNT ===== */
function openAccount() {
    if (!$('#search-page')?.classList.contains('hidden')) closeSearch();
    savedScroll = $('#scroll-area')?.scrollTop || 0;
    accountOpen = true;
    const pg = $('#account-page');
    pg.classList.remove('hidden');
    pg.style.display = '';
    renderAccount();
}
function closeAccount() {
    const pg = $('#account-page');
    pg.classList.add('hidden');
    pg.style.display = '';
    accountOpen = false;
    const scroll = $('#scroll-area');
    if (scroll) { scroll.scrollTop = savedScroll; }
}
function renderAccount() {
    const box = $('#account-results');
    const meta = $('#account-meta');
    if (!box) return;
    const liked = likedGames();
    const n = liked.length;
    meta.textContent = n === 0 ? 'No liked games yet' : `${n} liked game${n !== 1 ? 's' : ''}`;
    box.innerHTML = '';
    if (!liked.length) {
        box.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--muted)"><i class="fa-solid fa-heart" style="font-size:24px;display:block;margin-bottom:8px"></i><strong style="color:#fff">Nothing liked yet</strong><br><span>Tap the heart on any game to save it here.</span></div>';
        return;
    }
    liked.forEach(g => box.appendChild(makeCard(g, 'card-lg')));
}

/* ===== GAME MODAL ===== */
function openGameModal(g) {
    if (!g) return;
    const modal = $('#game-modal');
    const banner = $('#game-modal-banner-img');
    const icon = $('#game-modal-icon');
    const title = $('#game-modal-title');
    const badge = $('#game-modal-badge');
    const gdrive = $('#game-modal-gdrive');
    const buzz = $('#game-modal-buzz');
    const link = $('#game-modal-link');

    banner.src = g['Banner Link'] || FALLBACK;
    banner.alt = g.Name;
    icon.src = g['icon link'] || g['Banner Link'] || FALLBACK;
    icon.alt = g.Name;
    title.textContent = g.Name;

    // Status badge
    const b = statusBadge(g['Is It Working?']);
    badge.className = `recent-badge ${b.cls}`;
    badge.textContent = b.label;

    // Download source — new TSV column
    const src = (g['Is it Buzzheather or google drive or both'] || g['Is It Buzzheather or google drive or both'] || '').toLowerCase();
    const isGoogle = src.includes('google');
    const isBuzz = src.includes('buzz');

    gdrive.classList.toggle('hidden', !isGoogle);
    buzz.classList.toggle('hidden', !isBuzz);
    if (isGoogle) gdrive.href = g.link || '#';
    if (isBuzz) buzz.href = g.link || '#';

    // Generic fallback: if neither matched, show the game page link
    link.classList.toggle('hidden', isGoogle || isBuzz);
    link.href = g.link || '#';

    modal.classList.remove('hidden');
}
function closeGameModal() { $('#game-modal').classList.add('hidden'); }

/* ===== COLLECTION MODAL ===== */
function openModal(title, games) {
    const modal = $('#collection-modal');
    const grid = $('#modal-grid');
    $('#modal-title').textContent = title;
    grid.innerHTML = '';
    games.forEach(g => grid.appendChild(makeCard(g, 'card-lg')));
    modal.classList.remove('hidden');
}
function closeModal() { $('#collection-modal').classList.add('hidden'); }

/* ===== REVEAL ON SCROLL ===== */
let revealObserver = null;
function initReveal() {
    const targets = document.querySelectorAll('#featured-section, #categories-section > div');
    if (!targets.length) return;

    if (!revealObserver) {
        revealObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    revealObserver.unobserve(entry.target);
                }
            });
        }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    }

    targets.forEach(t => {
        if (!t.classList.contains('reveal')) t.classList.add('reveal');
        if (t.classList.contains('visible')) t.classList.remove('visible');
        revealObserver.observe(t);
    });
}
