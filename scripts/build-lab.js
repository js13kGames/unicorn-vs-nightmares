// Assemble la page du labo : gabarit + moteur du jeu + coeur du labo.
//   node scripts/build-lab.js  ->  lab/labo-entrainement.html
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const game = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
const core = fs.readFileSync(path.join(ROOT, 'lab', 'lab-core.js'), 'utf8');
if (game.includes('</script') || core.includes('</script')) throw new Error('un </script> casserait la page');
const page = fs.readFileSync(path.join(ROOT, 'lab', 'lab-page.html'), 'utf8')
  .replace('__GAME__', () => game).replace('__CORE__', () => core);
const out = path.join(ROOT, 'lab', 'labo-entrainement.html');
fs.writeFileSync(out, page);
console.log('lab/labo-entrainement.html : ' + (page.length / 1024).toFixed(0) + ' ko');
