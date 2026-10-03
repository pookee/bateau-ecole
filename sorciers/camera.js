/* ---------- téléphone : lecture des cartes en direct avec la caméra (version autonome) ----------
   Les images sont analysées dans le téléphone puis oubliées : seuls les numéros de carte et les lettres lues sortent.
   Une caméra par activité (une seule filme à la fois) : le Bateau-école lit les lettres, les pavillons voient les cartes levées. */
function orientationCamera(){
  let physique=null, ecoute=false, generation=0;
  const normalise = a => ((Math.round(a/90)*90)%360+360)%360;
  function ecran(){
    const a=window.screen && window.screen.orientation && window.screen.orientation.angle;
    return normalise(Number.isFinite(a) ? a : (Number.isFinite(window.orientation) ? window.orientation : 0));
  }
  function mesure(e){
    if (!Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
    const b=e.beta*Math.PI/180, g=e.gamma*Math.PI/180;
    // Projection de la verticale dans le plan du téléphone (axes W3C DeviceOrientation).
    const x=-Math.cos(b)*Math.sin(g), y=Math.sin(b);
    if (Math.hypot(x,y)<.5) return; // posé à plat : garder le dernier haut connu
    physique=normalise(Math.atan2(x,y)*180/Math.PI);
  }
  return {
    async demarre(){
      const id=++generation; physique=null;
      try {
        // iOS exige cet appel depuis le geste qui ouvre la caméra, avant tout await.
        const D=window.DeviceOrientationEvent;
        if (D && typeof D.requestPermission==="function" && await D.requestPermission()!=="granted") return;
        if (id!==generation) return;
        window.addEventListener("deviceorientation", mesure); ecoute=true;
      } catch(e){} // sans capteur, le repère de l'écran reste disponible
    },
    arrete(){ generation++; if (ecoute) window.removeEventListener("deviceorientation", mesure); ecoute=false; physique=null; },
    repere(video){
      const affichage=ecran(), appareil=physique===null ? affichage : physique;
      let image=affichage;
      // Certains flux restent en portrait en paysage. D'autres suivent le téléphone
      // même quand l'interface est verrouillée : ne pas les tourner une seconde fois.
      const paysage=video.videoWidth>video.videoHeight;
      const type=window.screen && window.screen.orientation && window.screen.orientation.type;
      const naturelPaysage=type ? type.startsWith("landscape")!==(affichage%180!==0) : false;
      const horizontal=a => naturelPaysage!==(a%180!==0);
      if (horizontal(affichage)!==paysage){
        if (horizontal(appareil)===paysage) image=appareil;
        else if (!paysage && !naturelPaysage) image=0;
      }
      return {rotation:normalise(appareil-image), cle:[affichage,appareil,image,video.videoWidth,video.videoHeight].join(":")};
    }
  };
}
/* Un seul calcul en cours. Le worker laisse la vidéo et les boutons réactifs. */
function lecteurCamera(){
  let worker=null, url=null, attente=null, minuteur=null, det=null, ferme=false;
  function termine(r){ clearTimeout(minuteur); minuteur=null; const f=attente; attente=null; if (f) f(r); }
  function abandonne(){
    if (worker) worker.terminate(); worker=null;
    if (url) URL.revokeObjectURL(url); url=null;
    termine(null);
  }
  try {
    const code=document.getElementById("cam-detection");
    if (window.Worker && code){
      url=URL.createObjectURL(new Blob([code.textContent], {type:"text/javascript"}));
      worker=new Worker(url);
      worker.onmessage=e=>{ if (e.data.erreur) abandonne(); else termine(e.data); };
      worker.onerror=e=>{ e.preventDefault(); abandonne(); };
      worker.onmessageerror=abandonne;
    }
  } catch(e){ abandonne(); }
  return {
    asynchrone:()=>!!worker,
    analyse(image){
      if (ferme || attente) return Promise.resolve(null);
      if (worker) return new Promise(ok=>{
        attente=ok; minuteur=setTimeout(abandonne,4000);
        try { worker.postMessage(image,[image.data.buffer]); } catch(e){ abandonne(); }
      });
      // Secours pour les vues qui ne permettent pas les workers ; résolution limitée par l'appelant.
      if (!det) det=new AR.Detector({dictionaryName:"CARTES40", maxHammingDistance:2});
      const debut=performance.now();
      try { return Promise.resolve({marques:det.detect(image), duree:performance.now()-debut}); }
      catch(e){ return Promise.resolve(null); }
    },
    ferme(){ ferme=true; abandonne(); det=null; }
  };
}
function nouvelleCamera(opt){
  opt = Object.assign({bouton:"Lire les cartes en direct", note:"Pose le téléphone face à la classe : les cartes levées sont lues toutes seules.", attente:" · en attente d'une question", presence:false}, opt||{});
  let flux=null, video=null, marques=null, travaux=[], lecteur=null, actif=false, voulu=false, raf=0, dernier=0, tour=0, rapide=false, duree=40;
  let ouverture=false, session=0, revision=0, enAnalyse=false, imageVue=0, effaceApres=0, ecouteVisibilite=false;
  let rappelImage=0, imageDisponible=0, imageAnalysee=0;
  let surLus=()=>{}, surVue=null, etatEl=null, choixEl=null, boutonEl=null, badgeEl=null, perimees=new Map();
  const vus = new Map(); // carte → {r:lettre, k:lectures, t:vue la dernière fois, c:coins}
  const orientation=orientationCamera(); let repere=null, stableApres=0;
  const CLE = "sorciers-essai-objectif";
  const lsG = k => { try { return localStorage.getItem(k); } catch(e){ return null; } };
  const lsS = (k,v) => { try { v==null ? localStorage.removeItem(k) : localStorage.setItem(k,v); } catch(e){} };
  const etat = t => { if (etatEl && etatEl.textContent!==t) etatEl.textContent = t; };
  function nomObjectif(l){
    l = String(l||"");
    if (/ultra/i.test(l)) return "Ultra grand-angle (0,5×)";
    if (/télé|tele/i.test(l)) return "Téléobjectif";
    if (/double|dual|triple/i.test(l)) return "Automatique";
    if (/avant|front/i.test(l)) return "Caméra avant";
    if (/arrière|back|rear/i.test(l)) return "Grand-angle (1×)";
    return l || "Caméra";
  }
  function monte(box, o){
    if (actif || ouverture) arrete(true);
    surLus = o.surCartes || surLus; surVue = o.surVue || null;
    box.innerHTML = `<div class="cam">
      <div class="cam-vue" hidden><video playsinline muted autoplay disablepictureinpicture disableremoteplayback></video><canvas class="cam-marques" aria-hidden="true"></canvas><div class="cam-badge" hidden aria-live="polite"></div></div>
      <div class="cam-bar"><button class="btn prim cam-go">${opt.bouton}</button>
        <select class="cam-obj" aria-label="Objectif" hidden></select></div>
      <div class="note cam-etat" role="status">${opt.note}</div></div>`;
    video = box.querySelector("video"); marques = box.querySelector(".cam-marques"); travaux = [document.createElement("canvas"),document.createElement("canvas")];
    etatEl = box.querySelector(".cam-etat"); choixEl = box.querySelector(".cam-obj"); boutonEl = box.querySelector(".cam-go"); badgeEl = box.querySelector(".cam-badge");
    if (opt.id) boutonEl.id = opt.id;
    boutonEl.onclick = ()=>{ actif || ouverture ? (voulu=false, arrete()) : (voulu=true, demarre()); };
    choixEl.onchange = ()=>{ lsS(CLE, choixEl.value); arrete(); demarre(); };
    if (!ecouteVisibilite){ ecouteVisibilite=true;
      document.addEventListener("visibilitychange", ()=>{ if (document.visibilityState==="hidden"){ if (actif || ouverture) arrete(true); } else if (voulu && !actif) demarre(); }); }
  }
  async function demarre(){
    if (actif || ouverture || !video) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ etat("La caméra en direct n'est pas disponible ici : ouvre cet essai dans Safari ou Chrome."); return; }
    const s=++session; ouverture=true;
    boutonEl.textContent="Annuler l'ouverture"; choixEl.disabled=true;
    etat("Ouverture de la caméra…");
    if (!opt.presence) await orientation.demarre();
    if (s!==session) return;
    repere=null;
    const id = lsG(CLE), taille = {width:{ideal:1920}, height:{ideal:1080}, frameRate:{ideal:30}};
    let nouveau=null;
    try {
      try { nouveau=await navigator.mediaDevices.getUserMedia({audio:false, video:id ? Object.assign({deviceId:{exact:id}},taille) : Object.assign({facingMode:{ideal:"environment"}},taille)}); }
      catch(e){
        if (!id || s!==session) throw e;
        lsS(CLE,null); nouveau=await navigator.mediaDevices.getUserMedia({audio:false,video:Object.assign({facingMode:{ideal:"environment"}},taille)});
      }
      if (s!==session){ nouveau.getTracks().forEach(t=>t.stop()); return; }
      flux=nouveau; video.srcObject=flux; await video.play();
    } catch(e){
      if (s!==session) return;
      voulu=false; arrete(true);
      etat(e && e.name==="NotAllowedError" ? "L'accès à la caméra est refusé : autorise-le dans les réglages du navigateur." : "Impossible d'ouvrir la caméra."); return;
    }
    if (s!==session) return;
    lecteur=lecteurCamera(); ouverture=false; choixEl.disabled=false;
    actif = true; enAnalyse=false; dernier=0; tour=0; duree=40; vus.clear(); perimees.clear();
    imageDisponible=0; imageAnalysee=0;
    if (video.requestVideoFrameCallback){
      const imageSuivante=()=>{ rappelImage=video.requestVideoFrameCallback(()=>{
        if (!actif || s!==session) return;
        imageDisponible++; imageSuivante();
      }); };
      imageSuivante();
    }
    video.parentElement.hidden = false; boutonEl.textContent = "Arrêter la caméra"; boutonEl.classList.remove("prim"); boutonEl.classList.add("petit");
    Autonome.eveille(true); objectifs(); boucle(); if (opt.surEtat) opt.surEtat(true);
  }
  function arrete(pause){
    session++; revision++; ouverture=false; actif = false; enAnalyse=false; cancelAnimationFrame(raf); orientation.arrete(); repere=null;
    if (rappelImage && video) video.cancelVideoFrameCallback(rappelImage); rappelImage=0;
    if (lecteur) lecteur.ferme(); lecteur=null;
    if (flux) flux.getTracks().forEach(t=>t.stop()); flux = null;
    if (video){ video.srcObject = null; video.parentElement.hidden = true; }
    if (boutonEl){ boutonEl.textContent = opt.bouton; boutonEl.classList.add("prim"); boutonEl.classList.remove("petit"); }
    if (choixEl) choixEl.disabled=false;
    Autonome.eveille(false); vus.clear(); effaceMarques();
    travaux.forEach(c=>{c.width=1;c.height=1;}); if (opt.surEtat) opt.surEtat(false);
    if (!pause) etat("Caméra arrêtée.");
  }
  async function objectifs(){
    const s=session;
    try {
      const l = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="videoinput" && !/avant|front/i.test(d.label));
      if (s!==session) return;
      const cur = flux && flux.getVideoTracks()[0] && flux.getVideoTracks()[0].getSettings().deviceId;
      if (l.length < 2){ choixEl.hidden = true; return; }
      choixEl.innerHTML = l.map(d=>`<option value="${esc(d.deviceId)}" ${d.deviceId===cur?"selected":""}>${esc(nomObjectif(d.label))}</option>`).join("");
      choixEl.hidden = false;
    } catch(e){ if (s===session) choixEl.hidden = true; }
  }
  function boucle(){
    if (!actif) return;
    raf = requestAnimationFrame(boucle);
    // Même pour essayer les cartes, échantillonner assez souvent pour saisir les brefs instants nets.
    // Le calcul reste unique, avec une marge pour laisser le téléphone afficher la vidéo.
    const now = performance.now(), periode = Math.max(rapide ? 100 : 140, duree*(lecteur.asynchrone() ? 1.4 : 2.5));
    if (effaceApres && now>effaceApres) effaceMarques();
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    const sens=synchroniseRepere();
    if (enAnalyse || now-dernier < periode || now<stableApres) return;
    const image=video.requestVideoFrameCallback ? imageDisponible : video.currentTime;
    if (image===imageAnalysee) return; // une même image figée ne peut pas confirmer une carte deux fois
    imageAnalysee=image;
    dernier = now; analyse(periode,sens);
  }
  function synchroniseRepere(){
    const sens=orientation.repere(video);
    if (sens.cle!==repere){
      repere=sens.cle; vus.clear();
      stableApres=performance.now()+350; effaceMarques();
      video.parentElement.style.setProperty("--cam-ratio",video.videoWidth+" / "+video.videoHeight);
    }
    return sens;
  }
  async function analyse(periode,sens){
    const s=session, rev=revision, t=Date.now(), vw=video.videoWidth, vh=video.videoHeight;
    enAnalyse=true;
    try {
      const niveau=tour++%2, travail=travaux[niveau];
      const cote=niveau ? 1000 : (lecteur.asynchrone() ? 1920 : 1280), k=Math.min(1,cote/Math.max(vw,vh));
      const w=Math.round(vw*k), h=Math.round(vh*k);
      if (travail.width!==w || travail.height!==h){ travail.width=w; travail.height=h; }
      const g=travail.getContext("2d",{willReadFrequently:true}); g.drawImage(video,0,0,w,h);
      const resultat=await lecteur.analyse(g.getImageData(0,0,w,h));
      if (!actif || s!==session || rev!==revision || !resultat) return;
      // Une réponse calculée avant un arrêt, une nouvelle question ou une rotation est périmée.
      if (synchroniseRepere().cle!==sens.cle || performance.now()<stableApres || Date.now()-t>1600) return;
      duree=duree*.8+Math.max(resultat.duree,Date.now()-t)*.2;
      recoit(resultat.marques,k,t,vw,vh,periode,sens.rotation);
    } catch(e){} finally { if (s===session) enAnalyse=false; }
  }
  function recoit(ms,k,t,vw,vh,periode,rotation){
    const trouve = {}; imageVue=t;
    ms.forEach(m=>{ const n = m.id+1; if (n>NB_CARTES) return; const r = reponseCarte(m, rotation);
      const ancien = vus.get(n), v = ancien && t-ancien.t<=1600 ? ancien : {k:0};
      if (v.r===r || opt.presence) v.k++; else v.k = 1; v.r = r; v.t = t; v.c = m.corners.map(p=>({x:p.x/k, y:p.y/k})); vus.set(n, v); });
    vus.forEach((v,n)=>{ if (t-v.t > 1600){ vus.delete(n); perimees.delete(n); return; }
      const p = perimees.get(n); // carte encore levée depuis la question d'avant : on attend qu'elle bouge
      if (p && (p.r!==v.r || t-p.t > 4500)) perimees.delete(n);
      if (v.k>=2 && !perimees.has(n)) trouve[n] = v.r; });
    dessine(vw, vh);
    const nb = Object.keys(trouve).length;
    if (nb) surLus(trouve);
    if (surVue) surVue(vus, t);
    etat(`${vus.size} carte${vus.size>1?"s":""} en vue${rapide?"":opt.attente} · ${Math.max(1, Math.round(1000/periode))} image${periode<500?"s":""}/s`);
  }
  function effaceMarques(){
    effaceApres=0;
    if (marques) marques.getContext("2d").clearRect(0,0,marques.width,marques.height);
  }
  function dessine(vw, vh){
    if (marques.width!==vw || marques.height!==vh){ marques.width = vw; marques.height = vh; }
    const g = marques.getContext("2d"); g.clearRect(0, 0, vw, vh);
    const e = Math.max(2, vw/480);
    effaceApres=performance.now()+1000;
    vus.forEach((v,n)=>{ if (v.t!==imageVue) return; // une carte absente de la dernière image ne garde pas de cadre fantôme
      const vieux = perimees.has(n) || v.k<2 || (opt.gris && opt.gris(n, v)), coul = vieux ? "#9AA9B4" : "#2F9E5B";
      g.strokeStyle = coul; g.lineWidth = e*1.5; g.beginPath(); v.c.forEach((p,i)=>i ? g.lineTo(p.x,p.y) : g.moveTo(p.x,p.y)); g.closePath(); g.stroke();
      const cx = v.c.reduce((a,p)=>a+p.x,0)/4, cy = v.c.reduce((a,p)=>a+p.y,0)/4, r = e*9;
      g.fillStyle = coul; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI*2); g.fill();
      g.fillStyle = "#fff"; g.font = `700 ${Math.round(r)}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(opt.presence ? String(n) : n+" "+v.r, cx, cy); });
  }
  return { monte,
    /* question ouverte : lecture rapide ; nouvelle question : les cartes encore levées ne comptent qu'une fois bougées */
    question(ouverte, nouvelle){ rapide = !!ouverte; if (nouvelle){ revision++; const t = Date.now(); perimees = new Map(); vus.forEach((v,n)=>perimees.set(n, {r:v.r, t})); } },
    oublie(){ revision++; vus.clear(); perimees.clear(); effaceMarques(); },
    /* une autre activité prend la caméra (ou on quitte l'écran) : elle s'éteint et ne se rallume plus toute seule */
    coupe(){ const v = voulu; voulu = false; if (actif || ouverture) arrete(true); return v; },
    lance(){ voulu = true; if (!actif) demarre(); },
    /* le compteur posé sur l'image (« 18 / 21 », vert quand toutes les cartes sont lues) */
    badge(html, etat){ if (!badgeEl) return; badgeEl.hidden = !html; if (badgeEl.innerHTML!==(html||"")) badgeEl.innerHTML = html||""; badgeEl.className = "cam-badge"+(etat ? " "+etat : ""); },
    actif:()=>actif };
}
const CameraDirect = nouvelleCamera({id:"cam-go"});
window.CameraDirect = CameraDirect; window.nouvelleCamera = nouvelleCamera;
