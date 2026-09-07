#!/usr/bin/env node
/**
 * record-gif.mjs — fabrique media/gameplay.gif, le GIF montre en haut du README.
 *
 *   src/index.html
 *        |
 *        |  1. on sert le jeu sur un port local, dans un Chromium pilote
 *        |  2. Math.random est remplace par un generateur a graine  -> partie reproductible
 *        |  3. requestAnimationFrame est neutralise : c'est NOUS qui avancons le jeu,
 *        |     d'un pas de temps fixe, et qui lisons le canvas image par image
 *        |  4. un pilote automatique joue a la place du joueur — il reutilise l'IA
 *        |     du jeu, aiPlay(0), donc les coups montres sont ceux du moteur reel
 *        |  5. ffmpeg assemble la fenetre choisie en GIF
 *        v
 *   media/gameplay.gif
 *
 * Le rendu n'est pas une capture « en direct » : comme on avance le jeu nous-memes,
 * la cadence est parfaitement reguliere et deux executions donnent le meme fichier.
 *
 * Prerequis, a installer une seule fois. Volontairement hors devDependencies :
 * sinon chaque `npm install` telechargerait un navigateur entier.
 *   npm i -D playwright && npx playwright install chromium
 *   ffmpeg   (brew install ffmpeg)
 *
 * Usage :
 *   node scripts/record-gif.mjs                    regenere le GIF livre
 *   node scripts/record-gif.mjs --dry              joue la partie sans rien ecrire,
 *                                                  et affiche la chronologie des evenements
 *   node scripts/record-gif.mjs --seed=12          une autre partie
 *   node scripts/record-gif.mjs --from=235 --take=258
 *   node scripts/record-gif.mjs --video --from=880 --take=540
 *                                                  bande-annonce MP4 1280x720
 *                                                  (media/trailer.mp4)
 *   node scripts/record-gif.mjs --keep             garde les images simulees
 *   node scripts/record-gif.mjs --encode-only --gifWidth=300 --colors=48
 *                                                  reencode ces images sans rejouer
 *                                                  la partie : quelques secondes
 *
 * La chronologie affichee a la fin (« f392 MODE play->celebrate ») sert a choisir
 * --from et --take : c'est le numero de l'image capturee. Relever ces numeros
 * DANS la taille de fenetre finale : --video bascule en 1280x720 et decale tout.
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* Reglages. Les valeurs par defaut sont celles du GIF livre.          */
/* ------------------------------------------------------------------ */

const O = {
  seed: 7,          // graine du hasard : change la partie entiere
  secs: 23,         // duree simulee
  fps: 25,          // cadence de simulation (dt = 1/fps, doit rester <= 0.05 s)
  w: 480, h: 900,   // taille de la fenetre : le jeu est vertical, pense pour un telephone
                    // (--video passe en 1280x720, le format attendu d'une video)
  every: 18,        // images entre deux coups du pilote : c'est le rythme de la partie
  from: 360,        // premiere image gardee : le milieu du premier plateau
  take: 170,        // nombre d images gardees (170 / 25 fps = 6,8 s), fin sur la victoire
  gifFps: 12.5,     // cadence du GIF (delai de 8 centiemes, valeur entiere)
  gifWidth: 300,    // largeur finale
  colors: 24,       // taille de la palette GIF : 24 tient en 851 ko, 32 en 924
  out: join(ROOT, 'media', 'gameplay.gif'),
  // --video : encode un MP4 au lieu du GIF, pour une bande-annonce.
  // Pleine resolution, pas de palette, pas de perte de cadence.
  video: false,
  videoOut: join(ROOT, 'media', 'trailer.mp4'),
  crf: 18,          // qualite x264 : 18 est visuellement sans perte
  dry: false,
  keep: false,      // garder les images simulees, pour reencoder sans rejouer
  'encode-only': false   // reencoder les images gardees : quelques secondes au lieu de minutes
};
for (const a of process.argv.slice(2)) {
  const [k, v] = a.replace(/^--/, '').split('=');
  if (k === 'dry') O.dry = true;
  else if (k === 'keep') O.keep = true;
  else if (k === 'encode-only') { O['encode-only'] = true; O.keep = true; }
  else if (k === 'video') { O.video = true; if (!process.argv.some(x => x.startsWith('--w='))) { O.w = 1280; O.h = 720; } }
  else if (k in O) O[k] = v === undefined ? true : (isNaN(+v) ? v : +v);
  else throw new Error(`option inconnue : ${a}`);
}

/* ------------------------------------------------------------------ */
/*  LE PILOTE AUTOMATIQUE                                              */
/*                                                                     */
/*  Le jeu est au tour par tour : il n'y a pas de trajectoire a        */
/*  calculer, seulement un coup a jouer quand c'est notre tour, et un  */
/*  ecran a faire avancer entre deux manches. Le pilote ne reimplemente */
/*  donc aucune strategie : il appelle aiPlay(0), l'IA du jeu, du cote  */
/*  du joueur. Ce qu'on filme est le moteur reel, pas une doublure.    */
/*                                                                     */
/*  Injecte dans la page, appele une fois toutes les `every` images.    */
/* ------------------------------------------------------------------ */

const AUTOPILOT = `window.__ai = function () {
  if (window.wait > 0) return;              // une animation est en cours : on la laisse finir
  if (window.legendOn) { window.legendOn = false; return; }
  switch (window.mode) {
    case 'title':      window.startIntro(); return;
    case 'intro': {
      // INTRO est desormais un script : [cases jouables, valeur enseignee, ...].
      // Une etape sans case jouable est l'etape DRAW +2.
      const t = window.INTRO[window.introStep];
      if (t[4] || window.turn) return;          // tour du monstre : update() le joue tout seul
      if (!t[0].length) { window.drawTiles(0, 2); window.introNext(); return; }
      window.sel = -1; window.introPlace(t[0][0]);   // introPlace choisit lui-meme la bonne carte
      return;
    }
    case 'boardintro': window.mode = 'play'; if (window.turn === 1) window.aiT = 0.6; return;
    case 'celebrate':  window.mode = 'boardend'; return;
    case 'boardend':   window.nextBoard(); return;
    case 'runend':     window.mode = 'title'; window.dreamG = 0.22; return;
    case 'remove':
      // la tuile 4 force a retirer une tuile adverse : on prend la mieux placee
      for (var i = 0; i < window.N; i++) if (window.ow[i] === 1) {
        window.removeTile(i);
        window.mode = 'play';
        if (!window.pendingExtra) window.endTurn();
        return;
      }
      window.mode = 'play'; window.endTurn(); return;
    case 'play':
      if (window.turn === 0) window.aiPlay(0);   // l'IA du jeu joue le camp du joueur
      return;
  }
};`;

/* ------------------------------------------------------------------ */

const FRAMES = join(tmpdir(), 'unicorn-night-frames');

// --encode-only : les images sont deja la, on saute directement a ffmpeg.
// Une simulation coute des minutes, un encodage quelques secondes ; resimuler a
// chaque essai de reglage fait comparer des parties differentes au lieu de
// comparer des reglages.
if (!O['encode-only']) {

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  throw new Error('playwright introuvable. Lance, une seule fois :\n' +
    '    npm i -D playwright && npx playwright install chromium\n' +
    '  (volontairement hors devDependencies : sinon chaque npm install telechargerait un navigateur)');
}

if (!O.dry) { rmSync(FRAMES, { recursive: true, force: true }); mkdirSync(FRAMES, { recursive: true }); }

const html = readFileSync(join(ROOT, 'src', 'index.html'));
const srv = createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}).listen(0);
await new Promise(r => srv.once('listening', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: O.w, height: O.h }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('  [erreur page]', e.message));

await page.addInitScript(seed => {
  // hasard reproductible : meme graine, meme partie, au pixel pres
  let s = seed >>> 0;
  Math.random = function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // pas d'audio : ensureAudio() echoue dans son try/catch, tous les sons deviennent muets
  delete window.AudioContext; delete window.webkitAudioContext;
  // on prend la main sur la boucle de rendu
  window.__cb = null;
  window.requestAnimationFrame = function (cb) { window.__cb = cb; return 1; };
  window.cancelAnimationFrame = function () {};
}, O.seed);

await page.goto(`http://127.0.0.1:${srv.address().port}/`);
await page.waitForFunction(() => typeof window.__cb === 'function');
await page.addScriptTag({ content: AUTOPILOT });

const N = Math.round(O.fps * O.secs), log = [];
for (let i = 1; i <= N; i++) {
  const r = await page.evaluate(({ t, dry, play }) => {
    if (play) window.__ai();
    window.__cb(t);
    return {
      png: dry ? '' : document.getElementById('c').toDataURL('image/png'),
      st: { mode: mode, niv: niv, turn: turn, you: score(0), foe: score(1), need: need }
    };
  }, { t: i * (1000 / O.fps), dry: O.dry, play: i % O.every === 0 });

  if (!O.dry) writeFileSync(join(FRAMES, `f${String(i).padStart(5, '0')}.png`),
    Buffer.from(r.png.slice(r.png.indexOf(',') + 1), 'base64'));
  log.push(r.st);
  if (!O.dry && i % 100 === 0) process.stdout.write(`  ${i}/${N} images\n`);
}
await browser.close(); srv.close();

// chronologie : c'est elle qui sert a choisir --from et --take
console.log('');
for (let i = 1; i < log.length; i++) {
  const a = log[i - 1], b = log[i];
  if (b.mode !== a.mode) console.log(`  f${i + 1}  MODE ${a.mode} -> ${b.mode}`);
  if (b.niv !== a.niv) console.log(`  f${i + 1}  PLATEAU ${a.niv} -> ${b.niv}`);
  if (b.you !== a.you || b.foe !== a.foe) console.log(`  f${i + 1}  ETOILES ${a.you}-${a.foe} -> ${b.you}-${b.foe} (il en faut ${b.need})`);
}
const end = log[log.length - 1];
console.log(`  fin : plateau ${end.niv}, etoiles ${end.you}-${end.foe}, mode ${end.mode}`);
if (O.dry) process.exit(0);

}  // fin du bloc de simulation

// ffmpeg : une palette globale calculee sur toute la fenetre, sans tramage.
// Le tramage ajoute du bruit, et le bruit ruine la compression du GIF.
const filter = `fps=${O.gifFps},scale=${O.gifWidth}:-1:flags=area,split[a][b];` +
  `[a]palettegen=max_colors=${O.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
const target = O.video ? O.videoOut : O.out;
mkdirSync(join(ROOT, 'media'), { recursive: true });
if (O.video) {
  // yuv420p pour que tous les lecteurs suivent, faststart pour que la lecture
  // demarre sans avoir telecharge le fichier entier.
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-framerate', String(O.fps), '-start_number', String(O.from), '-i', join(FRAMES, 'f%05d.png'),
    '-frames:v', String(O.take),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(O.crf),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    target], { stdio: 'inherit' });
} else {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-framerate', String(O.fps), '-start_number', String(O.from), '-i', join(FRAMES, 'f%05d.png'),
    '-frames:v', String(O.take), '-vf', filter, '-loop', '0', target], { stdio: 'inherit' });
}
if (!O.keep) rmSync(FRAMES, { recursive: true, force: true });
else console.log(`  images gardees dans ${FRAMES} (relance avec --encode-only)`);

const ko = statSync(target).size / 1024;
console.log(`\n  ${target}`);
if (O.video) {
  console.log(`  ${O.w}x${O.h}, ${(O.take / O.fps).toFixed(1)} s, ${(ko / 1024).toFixed(2)} Mo, sans son`);
  console.log(`  (le harnais neutralise l'AudioContext : la musique du jeu n'est pas capturee)\n`);
} else {
  console.log(`  ${O.gifWidth} px de large, ${(O.take / O.fps).toFixed(1)} s, ${(ko / 1024).toFixed(2)} Mo\n`);
}
