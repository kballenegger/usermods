      // The launch video's timeline, shared by every aspect ratio. scripts/variants.mjs inlines
      // this into index.html, square.html, vertical.html and x.html with window.LAYOUT set to that
      // variant's config: frame size, scene cuts, camera shots and a few pacing switches.

      // ---------------------------------------------------------------------------------------
      // Deterministic helpers. Every "random" placement comes from a seeded PRNG.
      // ---------------------------------------------------------------------------------------
      function prng(seed) {
        let s = seed >>> 0;
        return () => {
          s = (s + 0x6d2b79f5) >>> 0;
          let t = s;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }
      const NS = 'http://www.w3.org/2000/svg';

      /** Draw pixel art from rows of characters into an <svg>, one rect per lit cell. */
      function pixelArt(svg, rows, palette) {
        rows.forEach((row, y) => {
          [...row].forEach((ch, x) => {
            if (!palette[ch]) return;
            const r = document.createElementNS(NS, 'rect');
            r.setAttribute('x', x); r.setAttribute('y', y);
            r.setAttribute('width', 1); r.setAttribute('height', 1);
            r.setAttribute('fill', palette[ch]);
            svg.appendChild(r);
          });
        });
      }
      function spriteSvg(rows, palette, px) {
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${rows[0].length} ${rows.length}`);
        svg.setAttribute('width', rows[0].length * px);
        svg.setAttribute('height', rows.length * px);
        svg.setAttribute('class', 'px');
        svg.setAttribute('shape-rendering', 'crispEdges');
        pixelArt(svg, rows, palette);
        return svg;
      }

      const STAR = ['..X..', '..X..', 'XX.XX', '..X..', '..X..'];
      const SPARK = ['.X.', 'XXX', '.X.'];
      const MOON = [
        '...YYYY.....',
        '..YYYY......',
        '.YYYY.......',
        'YYYY........',
        'YYYY........',
        'YYYY........',
        'YYYYY.......',
        'YYYYY.......',
        '.YYYYYY....Y',
        '.YYYYYYYYYY.',
        '..YYYYYYYY..',
        '....YYYYY...',
      ];
      const CURSOR = [
        'X...........',
        'XX..........',
        'XWX.........',
        'XWWX........',
        'XWWWX.......',
        'XWWWWX......',
        'XWWWWWX.....',
        'XWWWWWWX....',
        'XWWWWWWWX...',
        'XWWWWWWWWX..',
        'XWWWWWWWWWX.',
        'XWWWWWWXXXXX',
        'XWWWXWWX....',
        'XWWX.XWWX...',
        'XWX..XWWX...',
        'XX....XWWX..',
        'X.....XWWX..',
        '.......XWWX.',
        '........XX..',
      ];

      /** A night sky of pixel stars (and optionally the banner's moon), avoiding keep-out boxes. */
      function sky(el, seed, { W, H, moon = false, keepOut = [], count = 26 }) {
        const r = prng(seed);
        const colors = ['#fff345', '#00e5f2', '#f343d3', '#f1f3f9'];
        const stars = [];
        if (moon) {
          const m = spriteSvg(MOON, { Y: '#fff345' }, 8);
          m.style.cssText = `position:absolute;left:${W > H ? 120 : 80}px;top:${W >= H ? 70 : 150}px`;
          el.appendChild(m);
        }
        let guard = 0;
        while (stars.length < count && guard++ < 800) {
          const x = Math.round(r() * (W - 80) + 20), y = Math.round(r() * (H * 0.66) + 20);
          if (keepOut.some((k) => x > k[0] && x < k[2] && y > k[1] && y < k[3])) continue;
          const big = r() < 0.45;
          const s = spriteSvg(big ? STAR : SPARK, { X: colors[Math.floor(r() * colors.length)] }, 6);
          s.style.cssText = `position:absolute;left:${x - (x % 6)}px;top:${y - (y % 6)}px`;
          el.appendChild(s);
          stars.push(s);
        }
        return stars;
      }

      /** Ink skyline with lit windows over a cyan dither ground, like the banner's lower edge. */
      function skyline(svg, seed, W) {
        const r = prng(seed);
        const add = (x, y, w, h, fill) => {
          const e = document.createElementNS(NS, 'rect');
          e.setAttribute('x', x); e.setAttribute('y', y); e.setAttribute('width', w); e.setAttribute('height', h); e.setAttribute('fill', fill);
          svg.appendChild(e);
        };
        // Dither ground: a checker of cyan cells on the bottom 60px.
        for (let y = 190; y < 250; y += 6) for (let x = ((y / 6) % 2) * 6; x < W; x += 12) add(x, y, 6, 6, '#00e5f2');
        let x = 0;
        while (x < W) {
          const w = 48 + Math.round(r() * 12) * 6;
          const h = 54 + Math.round(r() * 20) * 6;
          add(x, 196 - h, w, h + 6, '#030b16');
          for (let wy = 196 - h + 12; wy < 184; wy += 18) {
            for (let wx = x + 9; wx < x + w - 12; wx += 18) if (r() < 0.32) add(wx, wy, 6, 6, '#fff345');
          }
          x += w + (r() < 0.3 ? 30 : 0);
        }
      }

      /** Build a pixel-wipe grid of 120px blocks covering the frame, each with a seeded delay. */
      function buildWipe(el, seed, colors, W, H) {
        const r = prng(seed);
        const cols = Math.ceil(W / 120), rows = Math.ceil(H / 120);
        const blocks = [];
        for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
          const b = document.createElement('i');
          b.style.left = gx * 120 + 'px';
          b.style.top = gy * 120 + 'px';
          const c = r();
          b.style.background = c < 0.06 ? colors[1] : c < 0.1 ? colors[2] : colors[0];
          el.appendChild(b);
          // Diagonal sweep plus jitter, so it reads as a wipe rather than noise.
          blocks.push({ b, k: (gx / (cols - 1)) * 0.55 + (gy / (rows - 1)) * 0.2 + r() * 0.25 });
        }
        return blocks;
      }

      function build() {
        const C = window.CAPTURE;
        const L = window.LAYOUT;
        const { W, H } = L;
        const tl = gsap.timeline({ paused: true });

        // ---------- scene cuts (every one sits on the chiptune's 0.5 s beat grid) ----------
        const { problem: T_PROBLEM, demo: T_DEMO, feat: T_FEAT, end: T_END } = L.cuts;
        const D = T_DEMO;

        // ---------- decorations ----------
        const openStars = sky(document.getElementById('open-sky'), 11, { W, H, moon: true, keepOut: L.keepOut.open });
        const demoStars = sky(document.getElementById('demo-sky'), 23, { W, H, count: 14, keepOut: [] });
        const endStars = sky(document.getElementById('end-sky'), 37, { W, H, moon: true, keepOut: L.keepOut.end });
        skyline(document.getElementById('open-skyline'), 5, W);
        skyline(document.getElementById('end-skyline'), 5, W);
        pixelArt(document.getElementById('cursor'), CURSOR, { X: '#030b16', W: '#f1f3f9' });

        const twinkle = (stars, start, dur, seed) => {
          const r = prng(seed);
          stars.forEach((s) => {
            const period = 0.5 + r() * 0.6;
            const reps = Math.max(0, Math.floor(dur / period) - 1);
            tl.fromTo(s, { opacity: 1 }, { opacity: 0.25, duration: period / 2, ease: 'steps(2)', yoyo: true, repeat: reps }, start + r() * 0.5);
          });
        };
        twinkle(openStars, 0, T_PROBLEM - 0.6, 1);
        twinkle(demoStars, T_DEMO, T_FEAT - T_DEMO - 1, 2);
        twinkle(endStars, T_END, L.cuts.total - T_END - 0.6, 3);

        /** Reveal a .typed span one character per step. */
        const type = (el, at, cps = 24) => {
          const n = el.textContent.length;
          tl.fromTo(el, { width: '0ch' }, { width: `${n}ch`, duration: n / cps, ease: `steps(${n})` }, at);
          return at + n / cps;
        };
        const blink = (el, from, to) => {
          const reps = Math.max(0, Math.floor((to - from) / 0.5) - 1);
          tl.fromTo(el, { opacity: 1 }, { opacity: 0, duration: 0.25, ease: 'steps(1)', yoyo: true, repeat: reps }, from);
        };

        // ---------- 1 · cold open ----------
        if (L.hook) {
          // The X cut: autoplay is muted and people decide in two seconds, so the wordmark and the
          // one-line promise are all on screen by 0.9 s.
          tl.fromTo('#open-word', { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 0.3, ease: 'steps(6)' }, 0.0);
          tl.fromTo('#open-tag', { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.2, ease: 'steps(3)' }, 0.35);
          tl.fromTo('#open-rule', { scaleX: 0 }, { scaleX: 1, duration: 0.25, ease: 'steps(8)' }, 0.5);
          const sub = document.getElementById('open-sub');
          tl.fromTo(sub, { width: '0ch' }, { width: `${sub.textContent.length}ch`, duration: 0.01 }, 0.7);
          tl.fromTo('#open-caret-wrap', { opacity: 0 }, { opacity: 1, duration: 0.01 }, 0.7);
          blink(document.getElementById('open-caret'), 0.7, T_PROBLEM - 0.4);
        } else {
          tl.fromTo('#open-word', { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 0.45, ease: 'steps(8)' }, 0.15);
          tl.fromTo('#open-tag', { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.25, ease: 'steps(4)' }, 0.75);
          tl.fromTo('#open-rule', { scaleX: 0 }, { scaleX: 1, duration: 0.35, ease: 'steps(12)' }, 1.05);
          const subEnd = type(document.getElementById('open-sub'), 1.4, 34);
          // The caret's wrapper appears with the typing; the caret itself blinks once the line is done.
          tl.fromTo('#open-caret-wrap', { opacity: 0 }, { opacity: 1, duration: 0.01 }, 1.39);
          blink(document.getElementById('open-caret'), subEnd, T_PROBLEM - 0.4);
        }

        // ---------- 2 · the problem ----------
        // Lines are typed in order; a line that continues the same sentence follows sooner.
        let t = T_PROBLEM + 0.15;
        document.querySelectorAll('#problem-lines .typed').forEach((el, i) => {
          if (i) t += el.dataset.cont ? 0.08 : 0.16;
          t = type(el, t, L.problemCps);
        });
        blink(document.getElementById('p-caret'), T_PROBLEM + 0.15, T_DEMO - 0.2);

        // ---------- 3 · the demo ----------
        const panel = document.getElementById('panel');
        const frames = [];
        const addFrame = (name) => {
          const img = document.createElement('img');
          img.src = `assets/capture/${name}`;
          img.alt = '';
          img.decoding = 'sync';
          if (!frames.length) img.className = 'first';
          panel.appendChild(img);
          frames.push(img);
          return img;
        };
        // One <img> per distinct file; stream frames that repeat a file reuse it.
        const byName = new Map();
        const frame = (name) => {
          if (!byName.has(name)) byName.set(name, addFrame(name));
          return byName.get(name);
        };
        const empty = frame('panel-00-empty.webp');
        const typing = C.typeFrames.map(frame);
        const stream = C.streamFrames.map((f) => ({ ...f, img: frame(f.name) }));
        const proposal = frame('panel-03-proposal.webp');
        const saved = frame('panel-04-saved.webp');
        const modsTab = frame('panel-05-mods.webp');
        let shown = empty;
        const show = (img, at) => {
          const prev = shown;
          tl.set(img, { opacity: 1 }, at);
          if (prev !== img) tl.set(prev, { opacity: 0 }, at);
          shown = img;
        };

        // Camera shots. #cam is the 1920x1080 space the browser window is drawn in; a shot maps a
        // point of it onto a point of this frame at a scale. The panel box in #cam space is
        // x 1410..1850, y 118..970. `band` is the part of the frame the panel may use (clear of the
        // captions and, in 9:16, of the platform UI).
        const cam = L.cam;
        const fit = (s, cx, cy, sx, sy) => ({ scale: s, x: sx - cx * s, y: sy - cy * s });
        const panelShot = (panelY, stageY) => fit(cam.Z, 1410, 118 + panelY, cam.panelX, stageY);
        const shots = {
          wide: fit(...cam.wide),
          site: fit(...cam.site),
          composer: panelShot(852, cam.band[1]),
          top: panelShot(0, cam.band[0]),
          card: panelShot(C.cardBox.y + C.cardBox.height + 40, cam.band[1]),
          // The Mods tab's saved mod, down to its ON toggle (panel y ~560 in the capture).
          mods: panelShot(610, cam.band[1]),
        };
        const move = (shot, at, duration = 0.7) => tl.to('#cam', { ...shots[shot], duration, ease: 'power3.inOut' }, at);
        tl.set('#cam', shots.wide, 0);

        // Window enters in hard steps.
        tl.fromTo('#win', { y: 80, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: 'steps(6)' }, D + 0.05);
        move('composer', D + 0.7, 0.8);

        const caps = ['#cap1', '#cap2', '#cap3', '#cap4', '#cap5'];
        const capIn = (i, at, outAt) => {
          tl.fromTo(caps[i], { x: -60, opacity: 0 }, { x: 0, opacity: 1, duration: 0.3, ease: 'steps(4)' }, at);
          if (outAt) tl.to(caps[i], { x: -60, opacity: 0, duration: 0.2, ease: 'steps(3)' }, outAt);
        };
        capIn(0, D + 1.0, D + 3.55);

        // The user types: a plain typewriter, one character per captured frame, at a brisk ~13.5
        // characters a second with a seeded human wobble.
        const rt = prng(7);
        let ty = D + 1.55;
        typing.forEach((img) => {
          show(img, ty);
          ty += 0.062 + rt() * 0.024;
        });

        // Everything from Send on runs 0.5 s earlier than the typing's original slot: the brisker
        // typing saves that much, and the demo scene is 0.5 s shorter for it.
        const D2 = D - 0.5;
        // Send. The camera goes to the top of the transcript and the reply streams in.
        const SEND = D2 + 3.95;
        move('top', SEND + 0.05, 0.6);
        capIn(1, SEND + 0.25, D2 + 9.45);

        // The model's reply, token by token. Each captured stream frame is the real panel one piece
        // (1-4 characters) further on; the cadence is seeded and uneven the way a live stream is,
        // with a beat before each tool row and a shorter one before the text resumes.
        const rs = prng(42);
        const gap = (f) =>
          f.kind === 'wait' ? 0.35 : f.kind === 'tool' ? 0.3 : f.kind === 'tool-done' ? 0.22 : 0.028 + rs() * 0.05 + (rs() < 0.08 ? 0.09 : 0);
        const gaps = stream.map(gap);
        const STREAM_START = SEND + 0.12;
        const STREAM_END = D2 + 9.35;
        const squeeze = Math.min(1, (STREAM_END - STREAM_START) / gaps.reduce((a, g) => a + g, 0));
        let st = STREAM_START;
        stream.forEach((f, i) => {
          show(f.img, st);
          st += gaps[i] * squeeze;
        });

        // The proposal card, then the camera drops to it.
        show(proposal, D2 + 9.45);
        move('card', D2 + 9.4, 0.6);
        capIn(2, D2 + 9.6, D2 + 11.95);
        const cb = C.cardBox;
        const hl = document.getElementById('hl');
        // #win-relative: the panel starts at (1340, 44) inside the window's border box.
        hl.style.left = 1340 + cb.x - 9 + 'px';
        hl.style.top = 44 + cb.y - 9 + 'px';
        hl.style.width = cb.width + 18 + 'px';
        hl.style.height = cb.height + 18 + 'px';
        // An odd number of yoyo repeats, so the flashing ends switched off.
        tl.fromTo(hl, { opacity: 0 }, { opacity: 1, duration: 0.25, ease: 'steps(2)', yoyo: true, repeat: 5 }, D2 + 10.05);

        // Cursor to "Run once", click.
        const winPt = (bx) => ({ x: 1340 + bx.x + bx.width / 2, y: 44 + bx.y + bx.height / 2 });
        const run = winPt(C.runOnceBox);
        const save = winPt(C.saveBox);
        const modsPt = { x: 1340 + 100, y: 44 + 25 };
        const cur = document.getElementById('cursor');
        tl.fromTo(cur, { x: 1340 + 330, y: 44 + 800, opacity: 0 }, { x: run.x - 4, y: run.y - 2, opacity: 1, duration: 0.7, ease: 'power2.out' }, D2 + 11.4);
        const click = (ping, at, pt) => {
          tl.fromTo(ping, { x: pt.x, y: pt.y, scale: 0.4, opacity: 1 }, { scale: 1.6, opacity: 0, duration: 0.4, ease: 'steps(5)', immediateRender: false }, at);
          tl.fromTo(cur, { scale: 1 }, { scale: 0.85, duration: 0.08, yoyo: true, repeat: 1, ease: 'steps(1)', immediateRender: false }, at);
        };
        click('#ping1', D2 + 12.2, run);
        capIn(3, D2 + 12.3, D2 + 16.85);

        // Out to the page, which changes block by block into the mod's result.
        move('site', D2 + 12.5, 0.8);
        const site = document.getElementById('site');
        const rc = prng(99);
        const cells = [];
        for (let gy = 0; gy < 12; gy++) for (let gx = 0; gx < 20; gx++) {
          const c = document.createElement('div');
          c.className = 'cell';
          // Each block overlaps its right and lower neighbours by 2px, so no hairline of the page
          // underneath can show between two flipped blocks at any camera scale.
          c.style.cssText = `left:${gx * 67}px;top:${gy * 71}px;width:69px;height:73px;background-position:-${gx * 67}px -${gy * 71}px`;
          site.appendChild(c);
          cells.push({ c, k: (gy / 11) * 0.6 + rc() * 0.4 });
        }
        cells.forEach(({ c, k }) => tl.set(c, { opacity: 1 }, D2 + 13.4 + k * 1.3));
        // Once every block has flipped, one whole image replaces the grid, so no block seams show
        // when the camera later scales by a fraction.
        const after = document.createElement('img');
        after.src = 'assets/capture/site-after.webp';
        after.alt = '';
        after.style.cssText = 'left:0;top:0;width:1340px;height:852px;opacity:0';
        site.appendChild(after);
        tl.set(after, { opacity: 1 }, D2 + 13.4 + 1.3 + 0.05);

        // Save (on the card), then the Mods tab. Where the whole window is on screen the camera
        // stays put; where the page shot left the panel out of frame, it goes back to the panel.
        if (cam.savePanel) move('card', D2 + 15.8, 0.6);
        tl.to(cur, { x: save.x - 4, y: save.y - 2, duration: 0.6, ease: 'power2.inOut' }, D2 + 16.2);
        click('#ping2', D2 + 16.9, save);
        show(saved, D2 + 16.95);
        capIn(4, D2 + 17.0, null);
        if (cam.savePanel) move('top', D2 + 17.7, 0.5);
        tl.to(cur, { x: modsPt.x - 4, y: modsPt.y - 2, duration: 0.6, ease: 'power2.inOut' }, D2 + 18.1);
        click('#ping3', D2 + 18.75, modsPt);
        show(modsTab, D2 + 18.8);
        tl.to(cur, { opacity: 0, duration: 0.2, ease: 'steps(2)' }, D2 + 19.3);
        // Where the panel fills the frame, drop down to the installed mod and its ON toggle.
        const last = cam.savePanel ? 'mods' : 'wide';
        if (cam.savePanel) move('mods', D2 + 19.2, 0.6);
        // A slow push about the frame's centre to the end of the scene.
        const f = shots[last];
        const push = (v, c) => c - (c - v) * 1.025;
        tl.to('#cam', { scale: f.scale * 1.025, x: push(f.x, W / 2), y: push(f.y, H / 2), duration: 2.0, ease: 'none' }, D2 + 20.2);

        // ---------- 4 · features ----------
        const header = (C.savedMod && C.savedMod.header) || '';
        document.getElementById('term-code').innerHTML = header
          .split('\n')
          .map((l) => {
            const esc = l.replace(/&/g, '&amp;').replace(/</g, '&lt;');
            if (/==\/?UserScript==/.test(l)) return `<span class="k">${esc}</span>`;
            return esc.replace(/^(\/\/ )(@\w+)(\s+)(.*)$/, '<span class="c">$1</span><span class="a">$2</span>$3$4');
          })
          .join('\n');

        // Cropped README captures, sized for this layout: the crop (source y0, height h, in the
        // 840px-wide source) scaled to the layout's shot width, capped to its height.
        document.querySelectorAll('.shot.crop').forEach((el) => {
          const k = L.shotW / 840;
          const img = document.createElement('img');
          img.src = el.dataset.src;
          img.alt = '';
          img.style.cssText = `top:-${Math.round(Number(el.dataset.y0) * k)}px;width:${L.shotW}px;height:${Math.round(1640 * k)}px`;
          el.appendChild(img);
          el.style.width = L.shotW + 8 + 'px';
          el.style.height = Math.min(Math.round(Number(el.dataset.h) * k), L.shotMaxH) + 8 + 'px';
        });

        const feats = ['#f1', '#f2', '#f3', '#f4', '#f5'];
        feats.forEach((f, i) => {
          const a = T_FEAT + i * L.featDur;
          tl.fromTo(f, { opacity: 0 }, { opacity: 1, duration: 0.01 }, a + 0.02);
          tl.fromTo(`${f} .num`, { x: -80, opacity: 0 }, { x: 0, opacity: 1, duration: 0.3, ease: 'steps(4)' }, a + 0.1);
          tl.fromTo(`${f} h2`, { x: -80, opacity: 0 }, { x: 0, opacity: 1, duration: 0.3, ease: 'steps(4)' }, a + 0.25);
          tl.fromTo(`${f} p, ${f} .chips`, { x: -80, opacity: 0 }, { x: 0, opacity: 1, duration: 0.3, ease: 'steps(4)' }, a + 0.45);
          tl.fromTo(`${f} .visual > *`, { y: 90, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: 'steps(5)', stagger: 0.15 }, a + 0.2);
          if (i < feats.length - 1) tl.to(f, { opacity: 0, duration: 0.2, ease: 'steps(3)' }, a + L.featDur - 0.2);
        });

        // ---------- 5 · end card ----------
        const E = L.endFast ? [0.1, 0.5, 0.7, 0.9, 1.2, 1.6] : [0.3, 1.0, 1.3, 1.7, 2.4, 3.0];
        tl.fromTo('#end-word', { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 0.6, ease: 'steps(8)' }, T_END + E[0]);
        tl.fromTo('#end-tag', { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: 'steps(4)' }, T_END + E[1]);
        tl.fromTo('#end-rule', { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: 'steps(12)' }, T_END + E[2]);
        tl.fromTo('#end-sub', { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'steps(3)' }, T_END + E[3]);
        tl.fromTo('#end-gh', { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: 'steps(5)' }, T_END + E[4]);
        tl.fromTo('#end-soon', { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'steps(3)' }, T_END + E[5]);

        // ---------- wipes between scenes ----------
        const wipe = (id, seed, cut, colors) => {
          const blocks = buildWipe(document.getElementById(id), seed, colors, W, H);
          blocks.forEach(({ b, k }) => {
            tl.set(b, { opacity: 1 }, cut - 0.42 + k * 0.4);
            tl.set(b, { opacity: 0 }, cut + 0.02 + k * 0.4);
          });
        };
        const inkish = ['#030b16', '#f343d3', '#00e5f2'];
        wipe('wipe-a', 101, T_PROBLEM, inkish);
        wipe('wipe-b', 202, T_DEMO, ['#1008c8', '#aeff24', '#00e5f2']);
        wipe('wipe-c', 303, T_FEAT, inkish);
        wipe('wipe-d', 404, T_END, ['#1008c8', '#fff345', '#f343d3']);

        window.__timelines['main'] = tl;
      }

      document.fonts.ready.then(build);
