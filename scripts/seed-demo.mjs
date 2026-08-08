// Seed a throwaway instance with enough activity that the gallery captures a
// working product rather than a wall of empty states.
//
//   PORT=8140 DATA_DIR=/tmp/demo DEV_LOGIN=1 node server/index.js &
//   node scripts/seed-demo.mjs && npm run gallery
//
// Everything here is invented. Never point this at a real workspace: the
// gallery writes what it sees into Docs/, and real prospect names and addresses
// do not belong in a documentation folder.

const BASE='http://localhost:8140'; let cookie=''
async function call(m,p,b){const r=await fetch(BASE+p,{method:m,headers:{...(b!==undefined?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},body:b===undefined?undefined:JSON.stringify(b)})
 for(const c of (r.headers.getSetCookie?.()||[])) if(c.startsWith('htm_session')) cookie=c.split(';')[0]
 const t=await r.text(); let j=null; try{j=t?JSON.parse(t):null}catch{j={raw:t.slice(0,120)}}; return {s:r.status,b:j}}
const post=(p,b={})=>call('POST',p,b), put=(p,b={})=>call('PUT',p,b), get=(p)=>call('GET',p)
const rec=(b)=>b&&typeof b==='object'&&'data' in b?b.data:b

await post('/api/auth/dev-login',{email:'demo@harry.test',name:'Demo Owner'})
const mb = rec((await post('/api/mailboxes/sandbox',{email:'hello@harrydemo.test',displayName:'Harry Demo'})).b)
const client = rec((await post('/api/clients',{name:'Northwind Traders',email:'ops@northwind.test'})).b)

const people=[['ada','Ada','Lovelace','Northwind','Head of Operations'],['grace','Grace','Hopper','Globex','CTO'],
 ['alan','Alan','Turing','Initech','VP Engineering'],['katherine','Katherine','Johnson','Umbrella','Director of Ops'],
 ['linus','Linus','Pauling','Acme','Head of Growth'],['marie','Marie','Curie','Stark Industries','COO']]
const leads=[]
for(const [u,f,l,co,t] of people){ const r=await post('/api/leads',{email:`${u}@${co.toLowerCase().replace(/\W/g,'')}.test`,firstName:f,lastName:l,company:co,title:t}); leads.push(rec(r.b)) }

const camp = rec((await post('/api/campaigns/create',{name:'Q4 outbound — operations leaders'})).b)
await put(`/api/campaigns/${camp.id}/sequence`,{mermaid:`flowchart TD
  S([Start]) --> A[Send: short intro — one problem we solve for their role]
  A -- reply: interested --> B[Send: propose a 20-minute call, two time slots]
  A -- reply: question --> Q[Send: answer, then ask if a call makes sense]
  A -- no reply 3d --> F[Send: follow-up with one proof point]
  A -- reply: unsubscribe --> U([Unsubscribed])
  B -- reply --> W([Won: call booked])
  F -- no reply 4d --> L([Lost: no response])`})
await post(`/api/campaigns/${camp.id}/leads`,{leadIds:leads.map(l=>l.id)})
await put(`/api/campaigns/${camp.id}`,{mailboxId:mb.id})

// Labels, segment, notes, tasks
const vip = rec((await post('/api/tags',{appliesTo:'lead',name:'VIP',color:'#4f46e5'})).b)
const ent = rec((await post('/api/tags',{appliesTo:'lead',name:'Enterprise',color:'#0891b2'})).b)
await post(`/api/leads/${leads[0].id}/tags`,{tagIds:[vip.id,ent.id]})
await post(`/api/leads/${leads[1].id}/tags`,{tagIds:[vip.id]})
const seg = rec((await post('/api/lead-lists',{name:'Operations leaders — ANZ'})).b)
await post(`/api/lead-lists/${seg.id}/import`,{fileName:'anz-ops.csv',leads:[{email:'ada@northwind.test'},{email:'new.person@zenith.test',firstName:'New'}]})
await post(`/api/leads/${leads[0].id}/notes`,{body:'Met at a conference in March. Prefers email over calls; mentioned a Jira migration is the trigger.'})
await post(`/api/leads/${leads[0].id}/tasks`,{title:'Send the Jira migration case study',dueAt:'2026-08-01T09:00:00Z',priority:'high'})
await post(`/api/leads/${leads[2].id}/tasks`,{title:'Check whether Initech renewed',dueAt:'2026-12-01T09:00:00Z'})

// Suppression, webhooks, placement folder
await post('/api/block-list',{domain_block_list:'https://www.competitor.com/pricing\nspam.test'})
await post('/api/webhooks',{name:'Replies to our CRM',url:'https://example.test/hooks/replies',event_types:['reply','finished']})
await post('/api/deliverability/folders',{name:'Weekly placement checks'})

// Real activity so Reports is not empty
await post('/api/engine/tick')
console.log(JSON.stringify({mailbox:mb.id,client:client?.id,campaign:camp.id,leads:leads.length,segment:seg.id},null,0))
