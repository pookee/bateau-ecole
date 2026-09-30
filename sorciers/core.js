/* Moteur de l'essai web : aucune écriture dans les documents du Bateau-école. */
(function(root){
  'use strict';
  const clone=o=>JSON.parse(JSON.stringify(o));
  const text=(s,n=120)=>String(s??'').trim().slice(0,n);
  const maison=h=>Number.isInteger(h)&&h>=0&&h<4;
  const uid=()=>Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
  const jour=()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};
  function eleve(e){const n=Number(e?.n);if(!Number.isInteger(n)||n<1||n>32)throw Error('Numéro de carte invalide.');return {n,prenom:text(e.prenom,40),actif:e.actif!==false,maison:maison(e.maison)?e.maison:null};}
  function question(q){if(!q||!Array.isArray(q.c)||q.c.length<2||q.c.length>4||!Number.isInteger(q.ok)||q.ok<0||q.ok>=q.c.length||!text(q.q,800))throw Error('Question invalide.');return {id:text(q.id,80)||uid(),n:text(q.n,80),q:text(q.q,800),c:q.c.map(x=>text(x,240)),ok:q.ok,exp:text(q.exp||q.truc,1400),le:text(q.le,10),active:q.active!==false};}
  function listeEleves(a){if(!Array.isArray(a)||a.length>32)throw Error('La classe doit contenir au maximum 32 cartes.');const l=a.map(eleve);if(new Set(l.map(e=>e.n)).size!==l.length)throw Error('Deux élèves ont le même numéro de carte.');return l.sort((a,b)=>a.n-b.n);}
  function neuf(){return {version:1,id:uid(),rev:0,nom:'Ma classe',eleves:[],absents:{jour:jour(),n:[]},notions:null,personnelles:[],session:null,historique:[],sceau:false,vendredis:[]};}
  function sessionPropre(s){
    if(!s||!Array.isArray(s.questions)||!s.questions.length||s.questions.length>12)throw Error('Séance invalide.');
    const roster=listeEleves(s.roster);if(!roster.length||roster.some(e=>!maison(e.maison)))throw Error('Maisons de la séance invalides.');
    const questions=s.questions.map(question),max=questions.length;
    if(!Number.isInteger(s.valide)||s.valide<0||s.valide>max||!Number.isInteger(s.index)||s.index<0||s.index>=max||s.index>Math.min(s.valide,max-1))throw Error('Progression de la séance invalide.');
    const answers=(a,q)=>{const r={};for(const e of roster){const x=a?.[e.n];if(x===null||x==='')r[e.n]=null;else if(typeof x==='string'&&'ABCD'.slice(0,q.c.length).includes(x)&&x.length===1)r[e.n]=x;}return r;};
    return {id:text(s.id,90)||uid(),date:text(s.date,10),roster,questions,index:s.index,valide:s.valide,reponses:questions.map((q,i)=>answers(s.reponses?.[i],q)),fixes:questions.map((q,i)=>answers(s.fixes?.[i],q))};
  }
  function restore(o){
    if(o?.format==='sorciers-essai/sauvegarde')o=o.etat;
    if(!o||o.version!==1)throw Error('Cette sauvegarde ne correspond pas à cet essai.');
    const s=neuf();s.id=text(o.id,90)||s.id;s.rev=Number.isSafeInteger(o.rev)&&o.rev>=0?o.rev:0;s.nom=text(o.nom,60)||s.nom;
    s.eleves=listeEleves(o.eleves);s.notions=Array.isArray(o.notions)?o.notions.map(x=>text(x,80)).slice(0,200):null;
    s.personnelles=(Array.isArray(o.personnelles)?o.personnelles:[]).slice(0,2000).map(question);
    s.absents={jour:text(o.absents?.jour,10),n:(Array.isArray(o.absents?.n)?o.absents.n:[]).filter(n=>s.eleves.some(e=>e.n===n))};
    s.session=o.session?sessionPropre(o.session):null;
    s.historique=(Array.isArray(o.historique)?o.historique:[]).map(sessionPropre);
    if(s.historique.some(h=>h.valide!==h.questions.length)||new Set(s.historique.map(h=>h.id)).size!==s.historique.length||s.historique.some(h=>h.id===s.session?.id))throw Error('Historique incohérent.');
    s.sceau=!!o.sceau;s.vendredis=(Array.isArray(o.vendredis)?o.vendredis:[]).filter(x=>typeof x==='string').slice(0,1000);return s;
  }
  const presents=s=>s.eleves.filter(e=>e.actif&&!(s.absents.jour===jour()&&s.absents.n.includes(e.n)));
  const fin=s=>!!s.session&&s.session.valide===s.session.questions.length;
  function banque(s,defaut){const custom=new Map(s.personnelles.map(q=>[q.id,q]));return defaut.map(q=>custom.get(q.id)||q).concat(s.personnelles.filter(q=>!defaut.some(x=>x.id===q.id))).filter(q=>q.active!==false&&(s.notions===null||s.notions.includes(q.n)));}
  function importer(s,o){
    const k=o?.classe||o?.bateau||o,source=k?.eleves;if(!Array.isArray(source))throw Error('Aucune liste d’élèves dans ce fichier.');
    const entrants=listeEleves(source),map=new Map(s.eleves.map(e=>[e.n,e]));
    entrants.forEach(e=>{const ancien=map.get(e.n);map.set(e.n,{...e,maison:ancien?.maison??e.maison});});
    const eleves=[...map.values()].sort((a,b)=>a.n-b.n);let personnelles=s.personnelles,notions=s.notions;
    const b=o.bateau||(o.questions?o:null);
    if(b?.questions){const propres=b.questions.map(question);personnelles=propres;if(Array.isArray(b.notions))notions=b.notions.filter(n=>n.vue).map(n=>text(n.id,80));}
    s.eleves=eleves;s.personnelles=personnelles;s.notions=notions;if(k.nom&&o?.classe)s.nom=text(k.nom,60);
    if(k.absents?.jour===jour()&&Array.isArray(k.absents.n))s.absents={jour:jour(),n:k.absents.n.filter(n=>eleves.some(e=>e.n===n))};
  }
  function demarre(s,defaut){
    if(s.session&&!fin(s))return;
    const roster=presents(s);if(!roster.length)throw Error('Ajoute au moins un élève présent.');if(roster.some(e=>!maison(e.maison)))throw Error('Choisis une maison pour chaque élève présent.');
    const disponibles=banque(s,defaut);if(!disponibles.length)throw Error('Choisis au moins un chapitre dans les questions.');
    const pool=disponibles.map(question);for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
    const qs=pool.slice(0,6).map(q=>{const c=q.c.map((t,i)=>({t,good:i===q.ok}));for(let i=c.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[c[i],c[j]]=[c[j],c[i]];}return {...q,c:c.map(x=>x.t),ok:c.findIndex(x=>x.good)};});
    if(s.session)s.historique.push(s.session);
    s.session={id:uid(),date:jour(),roster:clone(roster),questions:qs,index:0,valide:0,reponses:qs.map(()=>({})),fixes:qs.map(()=>({}))};
  }
  const qid=s=>s.session?s.session.id+':'+s.session.index:null;
  function repond(s,target,reps,manuel=false){const t=s.session;if(!t||qid(s)!==target||t.index<t.valide)return false;let change=false;
    for(const [n,v] of Object.entries(reps||{})){if(!t.roster.some(e=>e.n===+n)||(!manuel&&Object.hasOwn(t.fixes[t.index],n)))continue;
      const x=v===null||v===''?null:v;if(x!==null&&!(typeof x==='string'&&x.length===1&&'ABCD'.slice(0,t.questions[t.index].c.length).includes(x)))continue;
      if(t.reponses[t.index][n]!==x){t.reponses[t.index][n]=x;change=true;}if(manuel){t.fixes[t.index][n]=x;change=true;}}
    return change;
  }
  function valide(s,target){const t=s.session;if(!t||qid(s)!==target||t.index!==t.valide)return false;t.valide++;return true;}
  function suivant(s,target){const t=s.session;if(!t||qid(s)!==target||t.index>=t.valide||fin(s))return false;t.index++;return true;}
  function scores(t){const r=[0,0,0,0];if(t)for(let i=0;i<t.valide;i++){const lettre='ABCD'[t.questions[i].ok];for(const e of t.roster)if(t.reponses[i][e.n]===lettre)r[e.maison]+=5;}return r;}
  const total=s=>s.historique.concat(s.session?[s.session]:[]).reduce((a,t)=>scores(t).map((v,h)=>a[h]+v),[0,0,0,0]);
  const rangs=pts=>pts.map((points,h)=>({h,points,rang:1+pts.filter(p=>p>points).length})).sort((a,b)=>b.points-a.points||a.h-b.h);
  const api={clone,uid,jour,maison,question,neuf,restore,eleve,listeEleves,presents,fin,banque,importer,demarre,qid,repond,valide,suivant,scores,total,rangs};
  root.SorcierCore=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
