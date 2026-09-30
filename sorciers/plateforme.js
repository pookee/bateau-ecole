/* ---------- version autonome : ce que fournissait claude.ai ----------
   Sauvegarde (db), liaison TBI ↔ téléphone (room), fichiers (assets) et téléchargements (downloads),
   avec la même interface que window.claude.use() : le reste du jeu ne voit pas la différence.
   Tourne dans un navigateur (TBI) et dans l'appli iOS / Android (Capacitor).
   Deux chemins pour la liaison, pris ensemble quand ils existent :
   - par internet : des relais publics gratuits (Nostr sur le port 443, MQTT en secours) ;
   - sans internet : l'appli sert le jeu à l'ordinateur par le Wi-Fi (plugin ServeurClasse) et les messages passent en direct.
   Tout est chiffré de bout en bout avec une clé tirée du code de la classe : les relais ne voient que des messages illisibles. */
"use strict";
window.BATEAU_AUTONOME = true;
const Autonome = (() => {
  const CAP = window.Capacitor;
  const NATIF = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
  const LOCAL = window.BATEAU_LOCAL || null; // page servie par l'appli d'un téléphone, sur le Wi-Fi de la classe
  const WEB = "https://pookee.github.io/bateau-ecole/sorciers/"; // adresse du jeu pour l'ordinateur, avec internet
  const plug = n => { if (!NATIF) return null; try { return (CAP.Plugins && CAP.Plugins[n]) || (CAP.registerPlugin && CAP.registerPlugin(n)) || null; } catch(e){ return null; } };
  const Prefs = plug("Preferences");
  const lsG = k => { try { return localStorage.getItem(k); } catch(e){ return null; } };
  const lsS = (k,v) => { try { localStorage.setItem(k,v); } catch(e){} };
  const lsD = k => { try { localStorage.removeItem(k); } catch(e){} };
  /* stockage durable : Preferences dans l'appli (iOS peut vider le localStorage d'une vue web), localStorage sinon */
  const Stock = {
    async get(k){ if (Prefs){ try { const r = await Prefs.get({key:k}); if (r && r.value!=null) return r.value; } catch(e){} } return lsG(k); },
    async set(k,v){ lsS(k,v); if (Prefs){ try { await Prefs.set({key:k, value:v}); } catch(e){} } },
    async del(k){ lsD(k); if (Prefs){ try { await Prefs.remove({key:k}); } catch(e){} } }
  };
  const te = new TextEncoder(), td = new TextDecoder();
  const hex = u => Array.from(u, b=>b.toString(16).padStart(2,"0")).join("");
  const rid = n => hex(crypto.getRandomValues(new Uint8Array(n||8)));
  const cat = (...a) => { let n=0; a.forEach(x=>n+=x.length); const o=new Uint8Array(n); let p=0; a.forEach(x=>{ o.set(x,p); p+=x.length; }); return o; };
  const b64 = u => { let s=""; for (let i=0;i<u.length;i+=0x8000) s += String.fromCharCode.apply(null, u.subarray(i,i+0x8000)); return btoa(s); };
  const deb64 = s => { const b=atob(s); const u=new Uint8Array(b.length); for (let i=0;i<b.length;i++) u[i]=b.charCodeAt(i); return u; };
  let role = null; // fixé à l'ouverture de la liaison : deux onglets du même navigateur peuvent avoir deux rôles
  const mode = () => role || lsG("sorciers-essai-mode") || "";

  /* ---------- code de liaison : 10 caractères (base 32 de Crockford), affiché XXXXX-XXXXX ---------- */
  const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  function nouveauCode(){ const b = crypto.getRandomValues(new Uint8Array(10)); let s=""; for (const x of b) s += ALPHA[x & 31]; return s.slice(0,5)+"-"+s.slice(5); }
  function normalise(c){
    c = String(c||"").toUpperCase().replace(/[^0-9A-Z]/g,"").replace(/[IL]/g,"1").replace(/O/g,"0").replace(/U/g,"V");
    if (c.length!==10 || [...c].some(x=>ALPHA.indexOf(x)<0)) return null;
    return c.slice(0,5)+"-"+c.slice(5);
  }

  /* ---------- chiffrement : clé AES-GCM et étiquette de salon tirées du code (PBKDF2) ---------- */
  const SUBTLE = !!(window.crypto && crypto.subtle); // absent si la page vient du téléphone en http : on chiffre alors en JavaScript
  async function cles(code){
    const mot = te.encode(code.replace("-","")), sel = te.encode("sorciers-essai/liaison/v1");
    let bits;
    if (SUBTLE){ const base = await crypto.subtle.importKey("raw", mot, "PBKDF2", false, ["deriveBits"]);
      bits = new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2", salt:sel, iterations:120000, hash:"SHA-256"}, base, 384)); }
    else bits = await NostrLite.derive(mot, sel, 120000, 48);
    const tag = hex(bits.slice(32,48)), brute = bits.slice(0,32);
    return {tag, aad:te.encode("sorciers-essai:"+tag), cle: SUBTLE ? await crypto.subtle.importKey("raw", brute, "AES-GCM", false, ["encrypt","decrypt"]) : brute};
  }
  async function chiffre(k, u){ const iv = crypto.getRandomValues(new Uint8Array(12));
    const c = SUBTLE ? new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv, additionalData:k.aad}, k.cle, u)) : NostrLite.aesGcm(k.cle, iv, k.aad).encrypt(u);
    return b64(cat(iv, c)); }
  async function dechiffre(k, s){ const u = deb64(s), iv = u.slice(0,12), c = u.slice(12);
    return SUBTLE ? new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM", iv, additionalData:k.aad}, k.cle, c)) : NostrLite.aesGcm(k.cle, iv, k.aad).decrypt(c); }
  async function gzip(u, compresse){
    const flux = new Blob([u]).stream().pipeThrough(compresse ? new CompressionStream("gzip") : new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(flux).arrayBuffer());
  }

  /* ---------- relais ---------- */
  const KIND = 25555; // événements Nostr éphémères : relayés en direct, jamais stockés
  // relais testés le 27/09/2026 à un message par seconde sans refus (damus bannit à ce rythme, nos.lol était en panne)
  const RELAIS_DEFAUT = ["nostr:wss://relay.primal.net","nostr:wss://nostr.mom","nostr:wss://relay.snort.social","nostr:wss://relay.nostr.net",
    "mqtt:wss://test.mosquitto.org:8081/mqtt","mqtt:wss://broker.hivemq.com:8884/mqtt"];
  function listeRelais(){
    const q = /[?&#]relais=([^&#]+)/.exec(location.href);
    if (q) return decodeURIComponent(q[1]).split(",").map(s=>s==="local"?"local:":s);
    try { const l = JSON.parse(lsG("sorciers-essai-relais")||"null"); if (Array.isArray(l) && l.length) return l; } catch(e){}
    return RELAIS_DEFAUT;
  }
  function transportNostr(url, k, recoit, change){
    let ws=null, pret=false, fini=false, attente=1500, minuteur=null, jetons=5, remplie=Date.now(), pompe=null, direct=false, tDirect=null;
    const sub = "be"+rid(6), sk = NostrLite.cleSecrete(), pk = NostrLite.clePublique(sk), file = [];
    /* les relais Nostr limitent le débit : au plus ~1 message/s en continu (5 d'un coup), et un message d'état
       (présence, question, cartes lues) remplace le précédent du même genre encore en attente */
    function envoieBrut(txt){ try { ws.send(JSON.stringify(["EVENT", NostrLite.signe({pubkey:pk, created_at:Math.floor(Date.now()/1000), kind:KIND, tags:[["t",k.tag]], content:txt}, sk)])); } catch(e){} }
    function pompeFile(){
      if (pompe) return;
      pompe = setTimeout(()=>{ pompe = null; if (!pret) return;
        const t = Date.now(); jetons = Math.min(5, jetons+(t-remplie)/1100); remplie = t;
        while (file.length && file[0].t < t-20000) file.shift(); // trop vieux : les autres relais l'ont porté
        while (file.length && jetons>=1){ const it = file[0]; envoieBrut(it.txts.shift()); jetons--; it.cle = null; if (!it.txts.length) file.shift(); }
        if (file.length) pompeFile(); }, file.length && jetons<1 ? 400 : 0);
    }
    function ouvre(){
      clearTimeout(minuteur); minuteur=null;
      try { ws = new WebSocket(url); } catch(e){ return plusTard(); }
      const moi = ws;
      /* certains relais gardent les événements « éphémères » et les renvoient à l'abonnement (constaté le 27/09/2026) :
         tout ce qui arrive avant la fin des événements stockés (EOSE) est ignoré, sinon un vieux voyage ou une vieille commande reviendrait */
      ws.onopen = ()=>{ if (moi!==ws) return; pret=true; attente=1500; direct=false; clearTimeout(tDirect); tDirect = setTimeout(()=>{ direct=true; }, 3000);
        ws.send(JSON.stringify(["REQ", sub, {kinds:[KIND], "#t":[k.tag]}])); change(); pompeFile(); };
      ws.onmessage = e=>{ let m; try { m = JSON.parse(e.data); } catch(x){ return; }
        if (m[0]==="EOSE" && m[1]===sub){ direct = true; clearTimeout(tDirect); return; }
        if (m[0]==="EVENT" && m[1]===sub && m[2] && typeof m[2].content==="string"){
          if (!direct || (m[2].created_at||0) < Date.now()/1000-900) return; // stocké, ou vieux de plus d'un quart d'heure
          recoit(m[2].content); }
        else if (m[0]==="OK" && m[2]===false) console.warn("relais", url, m[3]); };
      ws.onclose = ()=>{ if (moi!==ws) return; pret=false; change(); if (!fini) plusTard(); };
      ws.onerror = ()=>{ try { moi.close(); } catch(e){} };
    }
    function plusTard(){ if (minuteur||fini) return; minuteur = setTimeout(()=>{ minuteur=null; if (!fini) ouvre(); }, attente); attente = Math.min(30000, attente*2); }
    ouvre();
    return { nom:url.replace(/^wss:\/\//,""), pret:()=>pret,
      envoie(txts, cle){ if (cle){ const i = file.findIndex(x=>x.cle===cle); if (i>=0) file.splice(i,1); } file.push({cle, txts:txts.slice(), t:Date.now()}); if (file.length>60) file.shift(); pompeFile(); },
      reveille(){ if (!pret && !fini){ attente=1500; if (ws){ try { ws.onclose=null; ws.close(); } catch(e){} } ws=null; ouvre(); } },
      ferme(){ fini=true; clearTimeout(minuteur); try { ws && ws.close(); } catch(e){} } };
  }
  function transportMqtt(url, k, recoit, change){
    if (!window.mqtt) return null;
    const sujet = "sorciers-essai/"+k.tag;
    let c = null;
    try { c = mqtt.connect(url, {clientId:"be_"+rid(8), clean:true, keepalive:30, reconnectPeriod:6000, connectTimeout:10000, protocolVersion:4}); } catch(e){ return null; }
    c.on("connect", ()=>{ c.subscribe(sujet, {qos:0}); change(); });
    c.on("close", change); c.on("offline", change); c.on("error", ()=>{});
    c.on("message", (t,p)=>{ if (t===sujet) recoit(td.decode(p)); });
    return { nom:url.replace(/^wss:\/\//,"").replace(/\/mqtt$/,""), pret:()=>c.connected,
      envoie(txts){ if (c.connected) txts.forEach(txt=>c.publish(sujet, txt, {qos:0})); },
      reveille(){ if (!c.connected){ try { c.reconnect(); } catch(e){} } },
      ferme(){ try { c.end(true); } catch(e){} } };
  }
  /* ordinateur ouvert depuis le téléphone : messages directs par le Wi-Fi */
  function transportTelephone(lien, recoit, change){
    lien.surTrame(recoit); lien.surEtat(change);
    return { nom:"Wi-Fi du téléphone", pret:()=>lien.pret(), envoie(txts){ txts.forEach(d=>lien.envoie(d)); }, reveille(){ lien.reveille(); }, ferme(){} };
  }
  /* appli du téléphone : les ordinateurs reliés à son serveur Wi-Fi */
  function transportServeur(srv, recoit, change){
    srv.surTrame(recoit); srv.surClients(change);
    return { nom:"Wi-Fi de ce téléphone", pret:()=>srv.clients()>0, envoie(txts){ if (srv.clients()) txts.forEach(d=>srv.envoie(d)); }, reveille(){}, ferme(){} };
  }
  function transportLocal(k, recoit, change){ // même navigateur (tests, deux onglets)
    const bc = new BroadcastChannel("sorciers-essai-"+k.tag); bc.onmessage = e=>recoit(e.data); setTimeout(change,0);
    return { nom:"local", pret:()=>true, envoie(txts){ txts.forEach(txt=>bc.postMessage(txt)); }, reveille(){}, ferme(){ bc.close(); } };
  }
  function creeRelais(k, extra){
    const vus = new Map(), morceaux = new Map(), ecoute = new Set(), surChange = new Set();
    const change = () => surChange.forEach(f=>{ try { f(); } catch(e){} });
    async function recoit(txt){
      let u; try { u = await dechiffre(k, txt); } catch(e){ return; } // pas pour nous, ou abîmé
      if (u[0]===2){ // message coupé en morceaux : [2][id 8 o][rang][nombre][données]
        const id = "m"+hex(u.subarray(1,9)), i = u[9], n = u[10]; if (vus.has(id)) return;
        let p = morceaux.get(id); if (!p){ p = {n, m:[], t:Date.now()}; morceaux.set(id,p); }
        if (!p.m[i]) p.m[i] = u.slice(11);
        for (let j=0;j<p.n;j++) if (!p.m[j]) return;
        morceaux.delete(id); vus.set(id, Date.now()); u = cat(...p.m);
      }
      let m; try { m = JSON.parse(td.decode(u[0]===1 ? await gzip(u.subarray(1), false) : u.subarray(1))); } catch(e){ return; }
      if (!m || typeof m!=="object" || !m.id || vus.has(m.id)) return;
      vus.set(m.id, Date.now());
      if (Math.abs(Date.now()-(m.t||0)) > 15*60*1000) return; // vieux message rejoué
      ecoute.forEach(f=>{ try { f(m); } catch(e){ console.error(e); } });
    }
    const trs = listeRelais().map(s=>{
      if (s.startsWith("local:")) return transportLocal(k, recoit, change);
      if (s.startsWith("nostr:")) return window.NostrLite ? transportNostr(s.slice(6), k, recoit, change) : null;
      if (s.startsWith("mqtt:")) return transportMqtt(s.slice(5), k, recoit, change);
      return null;
    }).filter(Boolean).concat((extra||[]).map(f=>f(recoit, change)).filter(Boolean));
    setInterval(()=>{ const lim = Date.now()-20*60*1000; vus.forEach((t,id)=>{ if (t<lim) vus.delete(id); }); morceaux.forEach((p,id)=>{ if (p.t<lim) morceaux.delete(id); }); }, 60000);
    document.addEventListener("visibilitychange", ()=>{ if (document.visibilityState==="visible") trs.forEach(t=>t.reveille()); });
    addEventListener("online", ()=>trs.forEach(t=>t.reveille()));
    let file = Promise.resolve();
    function publie(m, cle){
      m.id = m.id || rid(9); m.t = Date.now(); vus.set(m.id, Date.now());
      const tache = file.then(async ()=>{
        const brut = te.encode(JSON.stringify(m)); let corps = brut, drapeau = 0;
        if (brut.length > 900 && window.CompressionStream){ try { corps = await gzip(brut, true); drapeau = 1; } catch(e){ corps = brut; drapeau = 0; } }
        const plein = cat(Uint8Array.of(drapeau), corps), MAX = 20000, trames = [];
        if (plein.length <= MAX) trames.push(plein);
        else { const id = crypto.getRandomValues(new Uint8Array(8)), n = Math.ceil(plein.length/MAX); if (n>250) throw new Error("trop gros");
          for (let i=0;i<n;i++) trames.push(cat(Uint8Array.of(2), id, Uint8Array.of(i,n), plein.subarray(i*MAX,(i+1)*MAX))); }
        const txts = []; for (const tr of trames) txts.push(await chiffre(k, tr));
        trs.forEach(t=>t.envoie(txts, cle));
      });
      file = tache.catch(()=>{});
      return tache;
    }
    return { publie, ecoute:f=>{ ecoute.add(f); return ()=>ecoute.delete(f); }, surChange:f=>{ surChange.add(f); return ()=>surChange.delete(f); },
      etat:()=>trs.map(t=>({nom:t.nom, ok:t.pret()})), connecte:()=>trs.some(t=>t.pret()) };
  }

  /* ---------- sauvegarde (même interface que la capacité db) ---------- */
  const DB = (() => {
    const cache = new Map(), ecoutes = new Map();
    const cle = p => "sorciers-db:"+p;
    async function lit(p){ if (cache.has(p)) return cache.get(p); let v = null; try { v = JSON.parse(await Stock.get(cle(p))||"null"); } catch(e){} cache.set(p, v); return v; }
    const snap = (p, v, distant) => ({ id:p.split("/").pop(), path:p, exists:!!(v && v.data!=null), distant:!!distant,
      data:()=> v && v.data!=null ? JSON.parse(JSON.stringify(v.data)) : undefined });
    function notifie(p, v, distant){ (ecoutes.get(p)||new Set()).forEach(f=>{ try { f(snap(p,v,distant)); } catch(e){ console.error(e); } }); }
    async function ecrit(p, data, distant){
      const v = {data, rev:Date.now()}; cache.set(p, v); await Stock.set(cle(p), JSON.stringify(v));
      if (!distant) Sync.change(p); notifie(p, v, distant); return v;
    }
    function doc(p){ return { id:p.split("/").pop(), path:p,
      async get(){ return snap(p, await lit(p)); },
      async set(data){ await ecrit(p, JSON.parse(JSON.stringify(data)), false); },
      async update(patch){ const v = await lit(p); await ecrit(p, Object.assign({}, v && v.data, JSON.parse(JSON.stringify(patch))), false); },
      async delete(){ cache.set(p, null); await Stock.del(cle(p)); notifie(p, null, false); },
      onSnapshot(f){ if (!ecoutes.has(p)) ecoutes.set(p, new Set()); ecoutes.get(p).add(f); lit(p).then(v=>f(snap(p,v,false))); return ()=>ecoutes.get(p).delete(f); } }; }
    return { doc, _lit:lit, _ecritDistant:(p,d)=>ecrit(p,d,true) };
  })();

  /* ---------- le téléphone garde une copie du voyage ----------
     Un ordinateur d'école remis à zéro (profil effacé) retrouve le voyage dès que le téléphone se reconnecte.
     Même voyage : la version la plus récente gagne. Voyages différents : le plus avancé gagne,
     sauf « Tout recommencer » ou une copie restaurée exprès (champ remplace). */
  const Sync = (() => {
    /* jeu/etat : le voyage du Bateau-école (écrit par l'écran de la classe, gardé en copie par le téléphone)
       classe/actuelle : la classe (élèves, cartes, absences), modifiable des deux côtés : la plus récente gagne */
    const voyage = d => d ? {voyage:d.voyage||null, remplace:d.remplace||null, maj:d.maj||0,
      prog:(d.milles||0)*1000 + ((d.journal&&d.journal.length)||0) + Object.keys((d.stats&&d.stats.q)||{}).length} : null;
    function prefereVoyage(a, b){ // b doit-il remplacer a ?
      if (!b) return false; if (!a) return true;
      if (b.remplace && b.remplace===a.voyage) return true;
      if (a.remplace && a.remplace===b.voyage) return false;
      if (a.voyage && a.voyage===b.voyage) return b.maj > a.maj;
      if (a.prog!==b.prog) return b.prog > a.prog;
      return b.maj > a.maj;
    }
    const REGLES = {
      "jeu/etat": {resume:voyage, prefere:prefereVoyage, delai:6000},
      "jeu/preparation": {resume:d=>d ? {maj:d.maj||0} : null, prefere:(a,b)=>!!b && (!a || b.maj>a.maj), delai:700},
      "classe/actuelle": {resume:d=>d ? {id:d.id||null, maj:d.maj||0} : null, prefere:(a,b)=>!!b && b.maj>0 && (!a || b.maj>a.maj), delai:700}
    };
    const DOCS = Object.keys(REGLES);
    let room = null, minuteurs = {}, premiers = {};
    const pairsLa = () => room && room._pairs().length>0;
    async function envoieDoc(p){ const v = await DB._lit(p); if (!v || !v.data || !room) return; room._publie({k:"db", path:p, data:v.data}, "db:"+p).catch(e=>console.warn("copie", e)); }
    const attente = new Set();
    function change(p){
      if (!REGLES[p]) return; attente.add(p);
      if (!pairsLa()) return;
      clearTimeout(minuteurs[p]); if (!premiers[p]) premiers[p] = Date.now();
      const delai = Date.now()-premiers[p] > 20000 ? 0 : REGLES[p].delai; // au plus tard 20 s après le premier changement
      minuteurs[p] = setTimeout(()=>{ premiers[p] = 0; attente.delete(p); envoieDoc(p); }, delai);
    }
    async function annonce(){ if (!room) return; const revs = {}; for (const p of DOCS){ const v = await DB._lit(p); revs[p] = REGLES[p].resume(v && v.data); } room._publie({k:"dbrev", revs}, "dbrev").catch(()=>{}); }
    async function recoit(m){
      if (m.k==="dbrev" && m.revs){ for (const p of DOCS){ const R = REGLES[p], v = await DB._lit(p), a = R.resume(v && v.data), b = m.revs[p]||null; if (a && R.prefere(b, a)) envoieDoc(p); } }
      const R = m.k==="db" && REGLES[m.path];
      if (R && m.data && typeof m.data==="object"){
        const v = await DB._lit(m.path);
        if (!R.prefere(R.resume(v && v.data), R.resume(m.data))) return;
        if (m.path==="jeu/etat" && mode()==="tbi"){ if (typeof window.recupereEtat==="function") window.recupereEtat(m.data); return; } // le jeu décide, puis enregistre
        await DB._ecritDistant(m.path, m.data); // copie gardée, et la classe mise à jour de ce côté
      }
    }
    return { branche(r){ room = r; }, change, annonce, recoit, nouveauPair(){ annonce(); [...attente].forEach(change); } };
  })();

  /* ---------- liaison (même interface que la capacité room) ---------- */
  function creeRoom(rel){
    const moi = {peer:rid(12), presence:{}};
    const pairs = new Map(), ecPairs = new Set(), ecSujets = new Map(), ecCo = new Set();
    const vue = p => ({peer:p.peer, by:null, isMe:p.peer===moi.peer, sameTab:p.peer===moi.peer, kind:"viewer", guest:false, presence:JSON.parse(JSON.stringify(p.presence||{}))});
    const tous = () => [vue(moi)].concat([...pairs.values()].map(vue));
    const signale = (j,l) => { const ch = {peers:tous(), joined:j.map(vue), left:l.map(vue)}; ecPairs.forEach(f=>{ try { f(ch); } catch(e){ console.error(e); } }); };
    let rep = null;
    const coucou = () => rel.publie({k:"hb", f:moi.peer, p:moi.presence}, "hb").catch(()=>{});
    const ETATS = {q:1, scan:1, ecran:1, pv:1, pvc:1, "hist:ids":1}; // sujets qui décrivent un état complet : le dernier suffit
    rel.ecoute(m=>{
      if (m.f===moi.peer) return;
      if (m.k==="hb"){ const neuf = !pairs.has(m.f), p = pairs.get(m.f) || {peer:m.f}, avant = JSON.stringify(p.presence||null);
        p.presence = m.p && typeof m.p==="object" ? m.p : {}; p.vu = Date.now(); pairs.set(m.f, p);
        if (neuf){ signale([p],[]); clearTimeout(rep); rep = setTimeout(coucou, 150+Math.random()*350); Sync.nouveauPair(); }
        else if (avant!==JSON.stringify(p.presence)) signale([],[]);
        return; }
      if (m.k==="bye"){ const p = pairs.get(m.f); if (p){ pairs.delete(m.f); signale([],[p]); } return; }
      if (m.k==="ev" && typeof m.topic==="string"){ const s = ecSujets.get(m.topic); if (s){ const msg = {topic:m.topic, data:m.data, peer:m.f, by:null, isMe:false, sameTab:false, kind:"viewer", guest:false}; s.forEach(f=>{ try { f(msg); } catch(e){ console.error(e); } }); } return; }
      Sync.recoit(m);
    });
    setInterval(coucou, 8000);
    setInterval(()=>{ const lim = Date.now()-26000, partis = []; pairs.forEach((p,id)=>{ if (p.vu<lim){ pairs.delete(id); partis.push(p); } }); if (partis.length) signale([],partis); }, 2000);
    let co = false; rel.surChange(()=>{ const c = rel.connecte(); if (c && !co) coucou(); if (c!==co){ co = c; ecCo.forEach(f=>{ try { f(c); } catch(e){} }); } });
    addEventListener("pagehide", ()=>{ rel.publie({k:"bye", f:moi.peer}).catch(()=>{}); });
    coucou();
    const r = {
      presence(patch){ for (const k in patch||{}){ if (patch[k]===null) delete moi.presence[k]; else moi.presence[k] = patch[k]; } coucou(); return Promise.resolve(); },
      onPeers(f){ ecPairs.add(f); setTimeout(()=>{ if (ecPairs.has(f)){ const t = tous(); f({peers:t, joined:t, left:[]}); } }, 0); return ()=>ecPairs.delete(f); },
      emit(topic, data){ const s = ecSujets.get(topic); if (s){ const msg = {topic, data, peer:moi.peer, by:null, isMe:true, sameTab:true, kind:"viewer", guest:false}; s.forEach(f=>{ try { f(msg); } catch(e){} }); }
        return rel.publie({k:"ev", f:moi.peer, topic, data}, ETATS[topic] ? "ev:"+topic : null).catch(()=>{}); },
      on(topic, f){ if (!ecSujets.has(topic)) ecSujets.set(topic, new Set()); ecSujets.get(topic).add(f); return ()=>ecSujets.get(topic).delete(f); },
      connected:()=>rel.connecte(),
      onConnection(f){ ecCo.add(f); return ()=>ecCo.delete(f); },
      join(){ return Promise.reject({code:"not_permitted", message:"join n'existe pas dans la version autonome"}); },
      leave(){ rel.publie({k:"bye", f:moi.peer}).catch(()=>{}); },
      _pairs:()=>[...pairs.values()].map(vue), _publie:(m,cle)=>rel.publie(Object.assign(m, {f:moi.peer}), cle), _etat:()=>rel.etat()
    };
    Sync.branche(r);
    return r;
  }
  /* ---------- ordinateur ouvert depuis le téléphone : lien direct par le Wi-Fi ----------
     Le téléphone donne le code de la classe quand la maîtresse accepte cet ordinateur (tout de suite s'il le connaît déjà). */
  const LienTel = LOCAL ? (() => {
    let ws = null, pret = false, attente = 800, minuteur = null, etat = "attente";
    const trames = new Set(), etats = new Set(), codes = new Set();
    const url = "ws://" + location.hostname + ":" + LOCAL.ws;
    const signale = e => { if (e) etat = e; etats.forEach(f=>{ try { f(etat); } catch(x){} }); };
    function ouvre(){
      clearTimeout(minuteur); minuteur = null;
      try { ws = new WebSocket(url); } catch(e){ return plusTard(); }
      const moi = ws;
      ws.onopen = ()=>{ moi.send(JSON.stringify({t:"bonjour", jeton:lsG("sorciers-essai-jeton")||""})); signale(pret ? "reconnexion" : "attente"); };
      ws.onmessage = e=>{ let o; try { o = JSON.parse(e.data); } catch(x){ return; }
        if (o.t==="code" && normalise(o.code)){ if (o.jeton) lsS("sorciers-essai-jeton", o.jeton); pret = true; attente = 800; signale("accepte"); codes.forEach(f=>f(normalise(o.code))); }
        else if (o.t==="refus"){ pret = false; signale("refuse"); }
        else if (o.t==="f" && pret && typeof o.d==="string") trames.forEach(f=>f(o.d)); };
      ws.onclose = ()=>{ if (moi!==ws) return; const avant = pret; pret = false; if (etat!=="refuse") signale(avant ? "perdu" : etat); plusTard(); };
      ws.onerror = ()=>{ try { moi.close(); } catch(e){} };
    }
    function plusTard(){ if (minuteur || etat==="refuse") return; minuteur = setTimeout(ouvre, attente); attente = Math.min(8000, attente*1.6); }
    setInterval(()=>{ if (pret) try { ws.send('{"t":"p"}'); } catch(e){} }, 20000);
    ouvre();
    return { pret:()=>pret, etat:()=>etat, envoie:d=>{ if (pret) try { ws.send(JSON.stringify({t:"f", d})); } catch(e){} },
      surTrame:f=>trames.add(f), surEtat:f=>etats.add(f), surCode:f=>codes.add(f),
      reessaie(){ etat = "attente"; attente = 800; try { ws && ws.close(); } catch(e){} ouvre(); },
      reveille(){ if (!pret && etat!=="refuse"){ attente = 800; ouvre(); } } };
  })() : null;

  /* ---------- appli du téléphone : serveur Wi-Fi pour afficher le jeu sur un ordinateur sans internet ---------- */
  const Serveur = (() => {
    const P = plug("ServeurClasse"); if (!P) return null;
    let infos = {actif:false, clients:0, adresses:[], http:0}, demandeAccord = null;
    const trames = new Set(), clientsCb = new Set(), majCb = new Set();
    const annonce = () => majCb.forEach(f=>{ try { f(infos); } catch(e){} });
    try {
      P.addListener("trame", e=>{ if (e && typeof e.d==="string") trames.forEach(f=>f(e.d)); });
      P.addListener("clients", e=>{ infos.clients = (e && e.clients) || 0; clientsCb.forEach(f=>f()); annonce(); });
      P.addListener("demande", async e=>{
        if (!e || !e.id) return;
        const code = Liaison.code(); if (!code){ P.refuse({id:e.id}).catch(()=>{}); return; }
        let connus = []; try { connus = JSON.parse(await Stock.get("sorciers-essai-ordinateurs")||"[]"); } catch(x){}
        const connu = e.jeton && connus.find(o=>o.jeton===e.jeton);
        if (connu){ connu.t = Date.now(); connu.ip = e.ip; await Stock.set("sorciers-essai-ordinateurs", JSON.stringify(connus)); P.accepte({id:e.id, code, jeton:connu.jeton}).catch(()=>{}); return; }
        const ok = demandeAccord ? await demandeAccord(e.ip) : false;
        if (!ok){ P.refuse({id:e.id}).catch(()=>{}); return; }
        const jeton = rid(12); connus.push({jeton, ip:e.ip, t:Date.now()});
        await Stock.set("sorciers-essai-ordinateurs", JSON.stringify(connus.slice(-8)));
        P.accepte({id:e.id, code, jeton}).catch(()=>{});
      });
    } catch(e){ return null; }
    async function demarre(){ try { infos = Object.assign(infos, await P.demarre()); await Stock.set("sorciers-essai-serveur", "1"); } catch(e){ console.warn("serveur", e); } annonce(); return infos; }
    async function arrete(){ try { infos = Object.assign(infos, await P.arrete()); } catch(e){} await Stock.del("sorciers-essai-serveur"); annonce(); return infos; }
    async function rafraichit(){ try { infos = Object.assign(infos, await P.etat()); } catch(e){} annonce(); return infos; }
    document.addEventListener("visibilitychange", ()=>{ if (document.visibilityState==="visible" && infos.actif) setTimeout(rafraichit, 800); });
    return { demarre, arrete, rafraichit, infos:()=>infos, clients:()=>infos.clients||0,
      envoie:d=>P.envoie({d}).catch(()=>{}), surTrame:f=>trames.add(f), surClients:f=>clientsCb.add(f), surMaj:f=>{ majCb.add(f); return ()=>majCb.delete(f); },
      surDemande:f=>{ demandeAccord = f; }, voulu:async()=>(await Stock.get("sorciers-essai-serveur"))==="1" };
  })();

  /* ---------- code de la classe et liaison (même interface que la capacité room) ---------- */
  const Liaison = (() => {
    let code = null, promesse = null, room = null;
    const CLE = "sorciers-essai-liaison";
    async function litCode(){
      const m = /[#&?]lien=([0-9A-Za-z-]+)/.exec(location.href);
      if (m){ const c = normalise(m[1]); if (c){ await Stock.set(CLE, c); return c; } }
      return normalise(await Stock.get(CLE));
    }
    function ouvre(){
      if (promesse) return promesse;
      promesse = (async()=>{
        role = LOCAL ? "tbi" : (lsG("sorciers-essai-mode") || "tbi");
        const extra = [];
        if (LOCAL){ // le code vient du téléphone, une fois l'ordinateur accepté
          code = await new Promise(ok=>LienTel.surCode(ok));
          await Stock.set(CLE, code);
          LienTel.surCode(c=>{ if (c!==code) location.reload(); }); // le téléphone a changé de classe
          extra.push((recoit, change)=>transportTelephone(LienTel, recoit, change));
        } else {
          code = await litCode();
          if (!code && mode()!=="tel"){ code = nouveauCode(); await Stock.set(CLE, code); }
          if (Serveur){ extra.push((recoit, change)=>transportServeur(Serveur, recoit, change)); if (code && await Serveur.voulu()) Serveur.demarre(); }
        }
        if (!code) return null;
        room = creeRoom(creeRelais(await cles(code), extra));
        return room;
      })().catch(e=>{ console.error("liaison", e); return null; });
      return promesse;
    }
    const lienWeb = c => WEB + "#lien=" + (c||code);
    return { ouvre, code:()=>code, normalise, WEB, lienWeb,
      async fixe(c){ c = normalise(c); if (!c) return false; if (Serveur && c!==code && Serveur.infos().actif) await Serveur.arrete().then(()=>Stock.set("sorciers-essai-serveur","1")); await Stock.set(CLE, c); return true; },
      async oublie(){ await Stock.del(CLE); },
      async nouveau(){ const c = nouveauCode(); await Stock.set(CLE, c); return c; },
      /* le téléphone crée son propre code s'il n'en a pas encore (lien à envoyer, Wi-Fi sans internet) */
      async assure(){ return code || normalise(await Stock.get(CLE)) || await this.nouveau(); },
      etat:()=>room ? room._etat() : [], pairs:()=>room ? room._pairs() : [],
      lien:c=>"bateauecole://lier/"+(c||code),
      qr(c, taille, texte){ if (!window.qrcode) return ""; const q = qrcode(0,"M"); q.addData(texte || ("bateauecole://lier/"+(c||code))); q.make();
        return q.createSvgTag({cellSize:Math.max(2, Math.floor((taille||240)/(q.getModuleCount()+8))), margin:4, scalable:true}); } };
  })();

  /* rôle par défaut : l'appli sur un téléphone lit les cartes ; un ordinateur (ou une page servie par le téléphone) affiche le jeu */
  function modeParDefaut(){
    if (LOCAL) return "tbi";
    const petit = Math.min(screen.width||innerWidth, screen.height||innerHeight) < 600;
    if (NATIF) return petit ? "tel" : "";
    if (/[#&?]lien=/.test(location.href)) return "tbi";
    return petit ? "" : "tbi";
  }

  /* ---------- fichiers (sons personnalisés), gardés dans IndexedDB ---------- */
  const Fichiers = (() => {
    const urls = new Map();
    let base = null;
    const ouvreBase = () => base || (base = new Promise((ok, ko)=>{ const r = indexedDB.open("sorciers-essai-fichiers", 1);
      r.onupgradeneeded = ()=>r.result.createObjectStore("f", {keyPath:"id"}); r.onsuccess = ()=>ok(r.result); r.onerror = ()=>ko(r.error); }));
    async function tx(ecrire, fn){ const b = await ouvreBase(); return new Promise((ok, ko)=>{ const t = b.transaction("f", ecrire?"readwrite":"readonly"); const req = fn(t.objectStore("f"));
      t.oncomplete = ()=>ok(req && "result" in req ? req.result : undefined); t.onerror = ()=>ko(t.error); t.onabort = ()=>ko(t.error); }); }
    const pret = (async()=>{ try { (await tx(false, st=>st.getAll())).forEach(f=>urls.set(f.id, URL.createObjectURL(f.blob))); } catch(e){} })();
    window.__urlAsset = id => urls.get(id) || null;
    return { pret,
      async upload(blob, o){ const type = (o && o.type) || blob.type || "application/octet-stream", b = blob.type===type ? blob : new Blob([blob], {type}), id = rid(12);
        await tx(true, st=>st.put({id, blob:b, type, taille:b.size, t:Date.now()})); const url = URL.createObjectURL(b); urls.set(id, url);
        return {id, url, sizeBytes:b.size, contentType:type}; },
      async list(){ const l = await tx(false, st=>st.getAll()); return {assets:l.map(f=>({id:f.id, url:urls.get(f.id)||null, sizeBytes:f.taille, contentType:f.type})), usage:{bytes:l.reduce((a,f)=>a+f.taille,0)}}; },
      async delete(id){ await tx(true, st=>st.delete(id)); const u = urls.get(id); if (u){ URL.revokeObjectURL(u); urls.delete(id); } } };
  })();

  /* ---------- téléchargements : fichier dans le navigateur, feuille de partage dans l'appli ---------- */
  const Telechargements = {
    async save({filename, data}){
      const nom = String(filename||"sorciers-essai.json").replace(/[\\/:*?"<>|]/g,"-");
      if (NATIF){ const FS = plug("Filesystem"), Partage = plug("Share");
        if (FS && Partage){ const texte = typeof data==="string" ? data : JSON.stringify(data);
          const r = await FS.writeFile({path:nom, data:texte, directory:"CACHE", encoding:"utf8"});
          try { await Partage.share({title:nom, files:[r.uri]}); } catch(e){ throw {code:"cancelled", message:String(e && e.message || e)}; }
          return; } }
      const blob = data instanceof Blob ? data : new Blob([typeof data==="string" ? data : JSON.stringify(data)], {type:"application/json"});
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nom; document.body.appendChild(a); a.click();
      setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 3000);
    }
  };

  /* ---------- partager un fichier (PDF des cartes, sauvegarde) : feuille de partage dans l'appli, téléchargement ailleurs ---------- */
  const blobEnB64 = blob => new Promise((ok, ko)=>{ const r = new FileReader(); r.onload = ()=>ok(String(r.result).split(",")[1]||""); r.onerror = ko; r.readAsDataURL(blob); });
  async function partageFichier(nom, blob){
    nom = String(nom||"fichier").replace(/[\\/:*?"<>|]/g, "-");
    if (NATIF){ const FS = plug("Filesystem"), P = plug("Share");
      if (FS && P){ const r = await FS.writeFile({path:nom, data:await blobEnB64(blob), directory:"CACHE"}); try { await P.share({title:nom, files:[r.uri]}); } catch(e){} return; } }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nom; document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  /* ---------- lien de liaison ouvert depuis le QR code (appareil photo de l'iPhone) ---------- */
  async function traiteLien(url){
    const m = /lier\/([0-9A-Za-z-]+)/.exec(url||""); if (!m) return;
    const c = normalise(m[1]); if (!c) return;
    const avant = normalise(await Stock.get("sorciers-essai-liaison"));
    if (c===avant && mode()==="tel") return;
    await Stock.set("sorciers-essai-liaison", c); lsS("sorciers-essai-mode", "tel"); location.reload();
  }
  if (NATIF){ const App = plug("App"); if (App){ try { App.addListener("appUrlOpen", e=>traiteLien(e && e.url)); App.getLaunchUrl().then(r=>r && r.url && traiteLien(r.url)).catch(()=>{}); } catch(e){} } }

  /* ---------- garder l'écran allumé (caméra en direct) ---------- */
  let verrou = null;
  async function eveille(on){
    const KA = plug("KeepAwake");
    if (KA){ try { on ? await KA.keepAwake() : await KA.allowSleep(); } catch(e){} return; }
    try { if (on && navigator.wakeLock && !verrou) verrou = await navigator.wakeLock.request("screen"); else if (!on && verrou){ await verrou.release(); verrou = null; } } catch(e){}
  }

  window.claude = { use: async name => {
    if (name==="db") return DB;
    if (name==="room") return await Liaison.ouvre();
    if (name==="assets") return Fichiers;
    if (name==="downloads") return Telechargements;
    return null;
  } };
  return { NATIF, LOCAL, Liaison, Serveur, LienTel, Stock, eveille, rid, normalise, modeParDefaut, partageFichier, partage:plug("Share"), fichiers:plug("Filesystem") };
})();
window.Autonome = Autonome;
