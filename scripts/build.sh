#!/usr/bin/env bash
# build.sh - chaine de build js13k : extract -> terser -> roadroller -> zip -> advzip
#
#   bash scripts/build.sh              build complet, ecrit le livrable
#   RR_TRIES=15 bash scripts/build.sh  relance roadroller 15 fois, garde le plus petit
#   bash scripts/build.sh --no-rr      saute roadroller (rapide) et ecrit AILLEURS,
#                                      pour ne jamais ecraser le zip a soumettre
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src/index.html"
DIST="$ROOT/dist"
NAME="unicorn-night"
LIMIT=13312   # 13 * 1024

NO_RR=0
for a in "$@"; do case "$a" in --no-rr) NO_RR=1;; *) echo "option inconnue: $a"; exit 1;; esac; done
[ "$NO_RR" = 1 ] && { NAME="$NAME-dev"; DIST="$DIST/dev"; }

[ -f "$SRC" ] || { echo "Source introuvable: $SRC"; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$DIST"

# Outils : terser + roadroller. On les cherche dans les emplacements usuels ;
# si absents, on installe en global (compatible avec les .npmrc qui imposent un
# prefix). En dernier recours on se rabat sur npx.
find_tool(){
  local name="$1" p
  for p in "$ROOT/node_modules/.bin/$name" "$HOME/node_modules/.bin/$name" \
           "$(npm root -g 2>/dev/null)/.bin/$name" "$(npm config get prefix 2>/dev/null)/bin/$name"; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  command -v "$name" >/dev/null 2>&1 && { echo "$name"; return 0; }
  return 1
}
TERSER="$(find_tool terser || true)"
ROADROLLER="$(find_tool roadroller || true)"
if [ -z "$TERSER" ] || [ -z "$ROADROLLER" ]; then
  echo "Installation de terser + roadroller ..."
  npm install -g terser roadroller >/dev/null 2>&1 || npm install terser roadroller >/dev/null 2>&1 || \
    echo "ATTENTION: npm install a echoue. Si le reseau est restreint, autorisez registry.npmjs.org."
  TERSER="$(find_tool terser || echo "npx --yes terser")"
  ROADROLLER="$(find_tool roadroller || echo "npx --yes roadroller")"
fi

# 1) Extraire le <script>, le <style>, le <title> et le <meta viewport>.
#    Le viewport n'est PAS decoratif : sans lui un navigateur mobile rend la page
#    a 980 px de large et la met a l'echelle, ce qui rend le jeu injouable au doigt.
python3 - "$SRC" "$WORK" <<'PY'
import re, sys
src, work = sys.argv[1], sys.argv[2]
html = open(src, encoding='utf-8').read()
def grab(pattern, default=''):
    m = re.search(pattern, html, re.S | re.I)
    return m.group(1) if m else default
js = grab(r'<script>(.*)</script>')
if not js:
    print("Aucun bloc <script> trouve"); sys.exit(1)
open(work + '/game.js', 'w', encoding='utf-8').write(js)
open(work + '/style.css', 'w', encoding='utf-8').write(grab(r'<style>(.*?)</style>'))
open(work + '/title.txt', 'w', encoding='utf-8').write(grab(r'<title>(.*?)</title>', 'Game'))
open(work + '/viewport.txt', 'w', encoding='utf-8').write(
    grab(r'<meta\s+name=["\']?viewport["\']?\s+content=["\'](.*?)["\']\s*/?>'))
PY

# 2) Verifier la syntaxe, puis minifier.
node --check "$WORK/game.js" && echo "Syntaxe JS: OK"
# --mangle-props sur NOS seules proprietes de donnees : 19 octets. La liste est
# explicite pour ne jamais toucher au DOM.
# booleans_as_integers est volontairement ABSENT : il reecrit `true` en `1`, ce
# qui est sans effet partout sauf a une frontiere d'API qui verifie ses types --
# et le SDK Wavedash le fait. setAchievement(id,1) leverait, le garde avalerait
# l'erreur, et aucun trophee ne partirait, uniquement depuis le build.
$TERSER "$WORK/game.js" -c passes=5,unsafe=true -m toplevel=true \
  --mangle-props 'regex=/^(np|ed|ct|sv|sol|so2|riv|pk|dc|tn)$/' -o "$WORK/game.min.js" 2>/dev/null \
  || cp "$WORK/game.js" "$WORK/game.min.js"
echo "JS minifie (terser) : $(wc -c < "$WORK/game.min.js") octets"

# 3) roadroller. La recherche -O2 est aleatoire : d'un essai a l'autre elle varie
#    d'une vingtaine d'octets. On la relance N fois et on garde le meilleur.
RR_TRIES="${RR_TRIES:-5}"
if [ "$NO_RR" = 1 ]; then
  echo "roadroller saute (--no-rr) : build de developpement, PAS a soumettre"
  cp "$WORK/game.min.js" "$WORK/game.rr.js"
elif [ -n "$ROADROLLER" ]; then
  BEST=""
  for _i in $(seq 1 "$RR_TRIES"); do
    if $ROADROLLER "$WORK/game.min.js" -O2 -o "$WORK/try.js" 2>/dev/null; then
      if [ -z "$BEST" ] || [ "$(wc -c < "$WORK/try.js")" -lt "$(wc -c < "$WORK/game.rr.js")" ]; then
        cp "$WORK/try.js" "$WORK/game.rr.js"; BEST=1
      fi
    fi
  done
  if [ -n "$BEST" ]; then
    echo "JS roadrolled      : $(wc -c < "$WORK/game.rr.js") octets (meilleur de $RR_TRIES essais)"
  else
    echo "roadroller a echoue : on garde la version terser."
    cp "$WORK/game.min.js" "$WORK/game.rr.js"
  fi
else
  cp "$WORK/game.min.js" "$WORK/game.rr.js"
fi

# 4) Reconstruire un HTML minimal : pas de <html>, <head> ni <body>, le navigateur
#    les insere de lui-meme. Le titre et le viewport, eux, ne s'inventent pas.
python3 - "$WORK" "$DIST/index.html" <<'PY'
import sys
work, out = sys.argv[1], sys.argv[2]
read = lambda n: open(work + '/' + n, encoding='utf-8').read().strip()
css, js, title, viewport = read('style.css'), open(work + '/game.rr.js', encoding='utf-8').read(), read('title.txt'), read('viewport.txt')
head = '<!doctype html><html lang=en><meta charset=utf-8>'
if viewport: head += '<meta name=viewport content="' + viewport + '">'
head += '<title>' + title + '</title>'
if css: head += '<style>' + css + '</style>'
open(out, 'w', encoding='utf-8').write(head + '<canvas id=c></canvas><script>' + js + '</script>')
PY
echo "HTML final         : $(wc -c < "$DIST/index.html") octets"

# 5) Zipper. L'entree DOIT s'appeler index.html et etre a la racine de l'archive :
#    c'est une regle du concours, verifiee a l'upload.
ZIP="$ROOT/$NAME.zip"
rm -f "$ZIP"
( cd "$DIST" && zip -9 -q -X "$ZIP" index.html )
echo "zip -9             : $(wc -c < "$ZIP") octets"

# 6) advzip recompresse le meme contenu avec zopfli : ~3 % gratuits, octets
#    extraits identiques. Optionnel (brew install advancecomp).
if command -v advzip >/dev/null 2>&1; then
  advzip -z -4 -q "$ZIP" || true
  echo "advzip             : $(wc -c < "$ZIP") octets"
else
  echo "advzip absent      : 'brew install advancecomp' rendrait ~3 % de l'archive"
fi

Z=$(wc -c < "$ZIP")
echo "----------------------------------------"
echo "ZIP final : $Z octets / $LIMIT max"
if [ "$NO_RR" = 1 ]; then
  echo "BUILD DE DEVELOPPEMENT (--no-rr) : hors budget par construction, ne pas soumettre."
elif [ "$Z" -le "$LIMIT" ]; then
  echo "DANS LE BUDGET. Marge : $((LIMIT - Z)) octets."
else
  echo "DEPASSEMENT de $((Z - LIMIT)) octets."; exit 1
fi
echo "Livrables :"
if [ "$NO_RR" = 1 ]; then
  echo "  - $ZIP   (test rapide UNIQUEMENT)"
else
  echo "  - $ZIP          (a soumettre)"
fi
echo "  - $DIST/index.html   (a ouvrir dans Chrome et Firefox)"
