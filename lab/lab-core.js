// lab-core.js : le coeur du labo d'entrainement.
// Tourne dans un Web Worker (la page) ou dans Node (les tests), a condition que
// les globales du jeu existent deja : ow, ov, sv, ct, need, hand, mHand, adj...
// Il ne touche jamais au code du jeu : il l'appelle.
(function(){
  'use strict';
  // ---- les 14 poids de l'IA actuelle, dans l'ordre du code, + 1 nouveau ----
  var NAMES=['castle','starWin','breakWin','starVal','steal','cover','approach',
             'replay','draw','purple','neighbor','intruder','holdGate','gateLost','cutStars'];
  var DESC={castle:'atteindre le chateau adverse',starWin:'poser l etoile qui fait gagner',
    breakWin:'voler l etoile qui faisait gagner l adversaire',starVal:'par etoile de la zone',
    steal:'par etoile volee',cover:'recouvrir une tuile adverse',approach:'x (9 - distance au camp adverse)',
    replay:'rejouer (tuile verte ou case)',draw:'piocher (tuile jaune ou case)',purple:'tuile violette',
    neighbor:'par voisin a etoiles non possede',intruder:'virer un intrus de sa porte',
    holdGate:'occuper sa propre porte',gateLost:'malus par porte tenue par l ennemi',
    cutStars:'NOUVEAU : par etoile adverse debranchee par ce coup'};
  var W0=[5000,3000,4000,6,8,50,32,75,8,14,0,2500,0,0,0];

  var cfg={algo:'ga',init:'jeu',pop:10,gamesPerGen:1000,elites:3,sigma:0.25,alpha:0.8,niv:5,noise:-1,target:10000};
  var pop=[], gen=0, played=0, history=[], running=false, t0=0, phase=null;

  // Nombres aleatoires communs : chaque individu d'une generation rejoue exactement
  // les memes paquets, memes plateaux, memes premiers joueurs. La comparaison
  // entre eux devient bien plus precise, pour le meme nombre de parties.
  var rngState=1;
  Math.random=function(){ rngState|=0; rngState=rngState+0x6D2B79F5|0; var t=Math.imul(rngState^rngState>>>15,1|rngState);
    t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; };
  function seed(x){ rngState=x|0; }
  function gauss(){ var u=1-Math.random(), v=Math.random(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }

  // ---------- la fonction de notation, parametree par un vecteur de poids ----------
  function cutStars(o,i,adv){
    var w=ow[i], vv=ov[i]; ow[i]=o; ov[i]=1;      // pose temporaire
    var a=score(1-o); ow[i]=w; ov[i]=vv; return adv-a;
  }
  function evalW(o,v,i,wt,adv,mien,foe,porte){
    var s=0, m;
    if(i===foe) s+=wt[0];
    if(sv[i]){ s+=wt[3]*sv[i]; if(mien+sv[i]>=need) s+=wt[1];
      if(ow[i]===1-o){ s+=wt[4]*sv[i]; if(adv>=need&&adv-sv[i]<need) s+=wt[2]; } }
    if(ow[i]===1-o) s+=wt[5];
    s+=(9-(o?dPC[i]:dMC[i]))*wt[6];
    if(v===3||ct[i]===3) s+=wt[7];
    if(v===2||ct[i]===2) s+=wt[8];
    if(v===4) s+=wt[9];
    var nb=nbrs(i); for(m=0;m<nb.length;m++) if(sv[nb[m]]&&ow[nb[m]]!==o) s+=wt[10];
    if(porte.indexOf(i)>=0) s+=(ow[i]===1-o)?wt[11]:wt[12];
    for(m=0;m<porte.length;m++) if(ow[porte[m]]===1-o&&i!==porte[m]) s-=wt[13];
    if(wt[14]) s+=wt[14]*cutStars(o,i,adv);
    return s;
  }
  function gameNoise(o){ return o?Math.max(5,31-niv*2.5):30; }   // la formule du jeu, niv suit le tour
  function noiseFor(o){ return cfg.noise<0?gameNoise(o):cfg.noise; }

  // ---------- les trois IA : meme signature, elles jouent le tour de o ----------
  function noMove(o,hd){ if(hd.length<7){ drawTiles(o,2); hd.push(hd.shift()); } endTurn(); }
  function mkLearner(wt){
    return function(o){
      var hd=o?mHand:hand, v=hd[0];
      if(!v){ drawTiles(o,2); endTurn(); return; }
      var opts=legalFor(o,v); if(!opts.length){ noMove(o,hd); return; }
      var foe=o?PC:MC, porte=adj[o?MC:PC], adv=score(1-o), mien=score(o), nz=noiseFor(o);
      var best=-1e9, bi=opts[0], k, s;
      for(k=0;k<opts.length;k++){ s=evalW(o,v,opts[k],wt,adv,mien,foe,porte)+Math.random()*nz;
        if(s>best){ best=s; bi=opts[k]; } }
      hd.shift(); doPlace(o,v,bi);
    };
  }
  function aiRnd(o){
    var hd=o?mHand:hand, v=hd[0];
    if(!v){ drawTiles(o,2); endTurn(); return; }
    var opts=legalFor(o,v); if(!opts.length){ noMove(o,hd); return; }
    hd.shift(); doPlace(o,v,opts[Math.random()*opts.length|0]);
  }
  function aiCur(o){ aiPlay(o); }     // l'IA du jeu, telle quelle

  // ---------- une partie complete : renvoie 0 (joueur), 1 (monstre), -1 (bloquee) ----------
  function simGame(aiP,aiM,board,lvl){
    // Le plateau vient de l'appelant. Ces trois lignes ont ete avalees par le //
    // ci-dessous pendant tout le developpement : le labo n'entrainait que sur le
    // plateau 0, et le gain annonce (56 %) valait 52,4 % sur les huit.
    niv=cfg.niv||lvl||5;   // fourni par l'appelant, jamais compte en interne
    bi=0; ord=[board]; etoTot=0;
    startBoard(Math.random()<0.5?0:1); mode='play';
    var c=0, o, hd, t, z;
    while((mode==='play'||mode==='remove')&&c++<400){
      if(mode==='remove'){                     // le violet du joueur : meme regle que le monstre
        t=[]; for(z=0;z<N;z++) if(ow[z]===1) t.push(z);
        t.sort(function(a,b){ return (sv[b]-sv[a])||(dMC[a]-dMC[b]); });
        removeTile(t[0]); mode='play'; if(!pendingExtra) endTurn(); continue;
      }
      o=turn; hd=o?mHand:hand;
      if(!hd.length){ drawTiles(o,2); endTurn(); continue; }
      (o?aiM:aiP)(o);
    }
    if(mode==='play'||mode==='remove') return -1;
    return endWin?0:1;
  }

  // ---------- evaluation d'un individu : moitie vs actuelle, moitie vs hasard, 2 cotes ----------
  function newInd(wt){ return {w:wt.slice(),gc:0,wc:0,gr:0,wr:0,born:gen}; }
  function fit(ind){ var c=ind.gc?ind.wc/ind.gc:0, r=ind.gr?ind.wr/ind.gr:0; return cfg.alpha*c+(1-cfg.alpha)*r; }
  // borne basse de confiance : la moyenne moins une marge d'autant plus large
  // que l'individu a peu joue. C'est elle qui classe, pas la moyenne.
  function lcb(ind){ var g=ind.gc+ind.gr, f=fit(ind); return g?f-Math.sqrt(Math.max(f*(1-f),0.04)/g):-1; }
  function playOne(ind,k){
    seed(gen*100003+k*7919+12345);          // meme partie pour tous les individus
    // board et lvl sont constants sur chaque groupe de 4, ou l'apprenante joue
    // les deux cotes : sinon le niveau se retrouve correle au camp, et le
    // simple temoin "poids du jeu" affiche 53% au lieu de 50.
    var vsCur=!(k%2), side=(k>>1)%2, board=(k>>2)%8, lvl=1+((k>>2)%12),
        me=mkLearner(ind.w), opp=vsCur?aiCur:aiRnd, r;
    r=side?simGame(opp,me,board,lvl):simGame(me,opp,board,lvl);
    if(r<0) return;
    var won=(r===side)?1:0;
    if(vsCur){ ind.gc++; ind.wc+=won; } else { ind.gr++; ind.wr+=won; }
  }

  // ---------- l'algorithme genetique ----------
  function mutate(wt){
    var out=wt.slice(), k;
    for(k=0;k<out.length;k++){
      if(Math.random()<0.35) out[k]*=Math.exp(cfg.sigma*gauss());
      if(Math.random()<0.15) out[k]+=gauss()*Math.max(5,0.3*Math.abs(out[k]));
      if(Math.random()<0.06) out[k]=0;      // eteindre un critere : parfois c'est ca, la bonne idee
      out[k]=Math.max(-20000,Math.min(20000,Math.round(out[k]*100)/100));
    }
    return out;
  }
  function cross(a,b){
    var out=[], k;
    for(k=0;k<a.length;k++) out.push(Math.random()<0.5?a[k]:(Math.random()<0.5?b[k]:(a[k]+b[k])/2));
    return out;
  }
  function randW(){
    var out=[], k;
    for(k=0;k<W0.length;k++)
      out.push(Math.round(Math.pow(10,0.3+Math.random()*3.4))*(Math.random()<0.9?1:-1));
    return out;
  }
  function init(){
    seed(Date.now()); pop=[]; var k;
    if(cfg.init==='hasard'){ for(k=0;k<cfg.pop;k++) pop.push(newInd(randW())); }
    else { pop.push(newInd(W0)); for(k=1;k<cfg.pop;k++) pop.push(newInd(mutate(W0))); }
    gen=0; played=0; history=[];
  }
  function breed(){
    seed(Date.now());                         // les mutations, elles, restent libres
    pop.sort(function(a,b){ return lcb(b)-lcb(a); });
    var el=pop.slice(0,cfg.elites), next=el.slice(), k, a, b;
    while(next.length<cfg.pop){
      a=el[Math.random()*el.length|0]; b=el[Math.random()*el.length|0];
      next.push(newInd(Math.random()<0.2?mutate(el[0].w):mutate(cross(a.w,b.w))));
    }
    pop=next;
  }
  function summary(){
    pop.sort(function(a,b){ return lcb(b)-lcb(a); });
    var f=pop.map(fit), best=pop[0];
    return {gen:gen, played:played, time:(Date.now()-t0)/1000,
      best:{w:best.w.slice(), fit:fit(best), vsCur:best.gc?best.wc/best.gc:0, vsRnd:best.gr?best.wr/best.gr:0,
            games:best.gc+best.gr, born:best.born},
      mean:f.reduce(function(x,y){return x+y;},0)/f.length, min:f[f.length-1], max:f[0],
      pop:pop.map(function(p){ return {fit:fit(p),lcb:lcb(p),vsCur:p.gc?p.wc/p.gc:0,games:p.gc+p.gr,born:p.born}; })};
  }

  // ---------- la boucle, decoupee en tranches pour rester interruptible ----------
  var cur={ind:0,k:0,per:100};
  function step(){
    if(!running) return;
    var n=0, per=cur.per, t=Date.now();
    while(n<40 && cur.ind<pop.length){
      playOne(pop[cur.ind],cur.k); cur.k++; played++; n++;
      if(cur.k>=per){ cur.k=0; cur.ind++; }
    }
    post({type:'progress', played:played, target:cfg.target, gen:gen, ind:cur.ind, ms:Date.now()-t,
          pop:pop.map(function(p){ return {fit:fit(p),games:p.gc+p.gr,born:p.born}; })});
    if(cur.ind>=pop.length){
      var s=summary(); history.push(s); post({type:'generation', s:s, names:NAMES, w0:W0, desc:DESC});
      // Toutes les 3 generations : le champion rejoue 400 parties FRAICHES.
      // C'est la seule mesure a croire : la moyenne d'un champion choisi comme
      // maximum de 10 mesures bruitees est toujours gonflee par la chance.
      if(gen%3===2){ var vc=verify(s.best.w,400);
        post({type:'checkpoint', gen:gen, vsCur:vc.vsCur, games:vc.games}); }
      gen++; breed(); cur.ind=0; cur.k=0;
      if(played>=cfg.target){ running=false; post({type:'done', s:s}); return; }
    }
    setTimeout(step,0);
  }

  // ---------- methode 2 : par critere ----------
  // Pour chaque poids, on essaie x0, x0.5, x1, x2 (ou 0/10/30/100 s'il est nul), chacun
  // sur n parties contre l'IA actuelle, TOUTES avec les memes paquets (nombres
  // aleatoires communs). On garde le meilleur s'il bat le poids en place d'au moins
  // 1 point. Puis on passe au poids suivant. Lent, mais chaque pas est verifie.
  var FACT=[1,0,0.5,2], co={w:null,k:0,j:0,c:0,n:0,nc:0,res:[],pass:0,steps:[]};
  function coCands(){ var b=co.w[co.k]; return b?FACT.map(function(f){ return b*f; }):[0,10,30,100]; }
  function coInit(){ co.w=(cfg.init==='hasard'?randW():W0.slice()); co.k=0; co.j=0; co.c=0; co.pass=0; co.steps=[];
    co.n=Math.max(20,Math.round(cfg.gamesPerGen/4));
    co.nc=Math.max(1,Math.round(co.n*cfg.alpha));       // parties contre l'actuelle ; le reste contre l'aleatoire
    co.res=[[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]; }
  function coGame(){
    var cands=coCands(), wt=co.w.slice(); wt[co.k]=cands[co.c];
    seed(co.pass*1000003+co.k*10007+co.j*7919+99);
    var vsCur=co.j<co.nc, opp=vsCur?aiCur:aiRnd,
        me=mkLearner(wt), side=co.j%2, board=(co.j>>1)%8,
        r=side?simGame(opp,me,board):simGame(me,opp,board);
    if(r>=0){ var won=(r===side)?1:0;
      if(vsCur){ co.res[co.c][0]++; co.res[co.c][1]+=won; }
      else { co.res[co.c][2]++; co.res[co.c][3]+=won; } }
    co.j++; played++;
    if(co.j>=co.n){ co.j=0; co.c++;
      if(co.c>=4){
        var rc=co.res.map(function(x){ return x[0]?x[1]/x[0]:0; }),
            rr=co.res.map(function(x){ return x[2]?x[3]/x[2]:0; }),
            sc=co.res.map(function(x,q){ return cfg.alpha*rc[q]+(1-cfg.alpha)*rr[q]; }),
            best=0, q,
            marge=Math.max(0.015,1.2*Math.sqrt(0.25/Math.max(1,co.n)));   // ~1.2 ecart-type
        for(q=1;q<4;q++) if(sc[q]>sc[best]+marge) best=q;
        var st={step:co.steps.length,pass:co.pass,k:co.k,name:NAMES[co.k],before:co.w[co.k],cands:cands,
                rates:sc,ratesCur:rc,ratesRnd:rr,chosen:best,n:co.n,nCur:co.nc};
        co.w[co.k]=cands[best]; st.after=co.w[co.k]; st.vsCur=rc[best]; st.vsRnd=rr[best]; st.fit=sc[best];
        st.w=co.w.slice(); st.played=played; st.time=(Date.now()-t0)/1000;
        co.steps.push(st); post({type:'coord',s:st,names:NAMES,w0:W0,desc:DESC});
        co.res=[[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]; co.c=0; co.k++; if(co.k>=NAMES.length){ co.k=0; co.pass++; }
      }
    }
  }
  function coStep(){
    if(!running) return;
    var n=0, t=Date.now();
    while(n<40&&played<cfg.target){ coGame(); n++; }
    post({type:'progress',played:played,target:cfg.target,gen:co.pass,ind:co.k,ms:Date.now()-t,coord:{k:co.k,c:co.c,j:co.j,n:co.n,name:NAMES[co.k]},pop:[]});
    if(played>=cfg.target){ running=false; post({type:'done',s:{played:played,gen:co.pass,coord:true}}); return; }
    setTimeout(coStep,0);
  }

  // ---------- reperes et verification ----------
  function baseline(n){
    seed(Date.now()); var k, r, a=0, b=0, ga=0, gb=0;
    for(k=0;k<n;k++){ r=(k%2)?simGame(aiRnd,aiCur,(k>>1)%8,1+((k>>1)%12)):simGame(aiCur,aiRnd,(k>>1)%8,1+((k>>1)%12));
      if(r<0) continue; ga++; if(r===(k%2)) a++; }
    for(k=0;k<n;k++){ r=simGame(aiCur,aiCur,(k>>1)%8,1+((k>>1)%12)); if(r<0) continue; gb++; if(r===0) b++; }
    return {curVsRnd:a/ga, curVsCurPlayerSide:b/gb, games:n};
  }
  function verify(wt,n){
    seed(Date.now()+7); var me=mkLearner(wt), k, r, w=0, g=0, len=0, b, l;
    for(k=0;k<n;k++){
      b=(k>>1)%8; l=1+((k>>1)%12);        // meme plateau et meme niveau des deux cotes
      r=(k%2)?simGame(aiCur,me,b,l):simGame(me,aiCur,b,l);
      if(r<0) continue; g++; len+=moves; if(r===(k%2)) w++; }
    return {vsCur:w/g, games:g, avgMoves:len/g};
  }

  // ---------- messages ----------
  function post(m){ if(typeof self!=='undefined'&&self.postMessage) self.postMessage(m); else if(typeof LAB_POST==='function') LAB_POST(m); }
  function onMsg(m){
    var k;
    if(m.type==='config'){ for(k in m.cfg) cfg[k]=m.cfg[k]; }
    if(m.type==='start'){
      if(m.target) cfg.target=m.target; running=true; t0=Date.now()-(m.keepTime||0);
      if(cfg.algo==='coord'){ if(!co.w||m.reset){ coInit(); played=0; } setTimeout(coStep,0); }
      else { if(!pop.length||m.reset){ init(); } cur.per=Math.max(4,Math.round(cfg.gamesPerGen/cfg.pop)); setTimeout(step,0); }
    }
    if(m.type==='stop'){ running=false; post({type:'stopped', played:played}); }
    if(m.type==='baseline'){ post({type:'baseline', b:baseline(m.n||200)}); }
    if(m.type==='verify'){ post({type:'verified', v:verify(m.w,m.n||600), w:m.w}); }
    if(m.type==='export'){
      if(cfg.algo==='coord') post({type:'json', names:NAMES, w0:W0, best:co.w||W0, gen:co.pass, played:played, history:co.steps.map(function(t){ return {gen:t.step,best:{vsCur:t.vsCur,vsRnd:t.vsRnd||0},mean:t.fit||t.vsCur}; }), coord:true});
      else { pop.sort(function(a,b){ return lcb(b)-lcb(a); });
        post({type:'json', names:NAMES, w0:W0, best:pop[0]?pop[0].w:W0, gen:gen, played:played, history:history}); } }
  }
  if(typeof self!=='undefined'&&self.postMessage){ self.onmessage=function(e){ onMsg(e.data); };
    post({type:'ready', boards:(typeof BOARDS!=='undefined'?BOARDS.length:0)}); }
  if(typeof globalThis!=='undefined') globalThis.LAB={onMsg:onMsg, cfg:cfg, W0:W0, NAMES:NAMES, mkLearner:mkLearner, aiRnd:aiRnd, aiCur:aiCur, simGame:simGame, baseline:baseline, verify:verify, evalW:evalW};
})();
