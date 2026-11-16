import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, {parseDueDate, parseReminderInput, parseRecurrence, handleTelegramUpdate} from '../src/index.ts';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));
 const db={prepare(q){ const s=sql.prepare(q); let values=[];const api={bind(...v){values=v;return api},async run(){const r=s.run(...values);return {meta:{changes:Number(r.changes)}}},async first(){return s.get(...values)??null},async all(){return {results:s.all(...values)}}};return api}};
 return {sql,env:{DB:db,OWNER_TELEGRAM_ID:'12345',TELEGRAM_BOT_TOKEN:'test-token-not-real',WEBHOOK_SECRET:'test-secret-not-real'}};
}
test('dates reject impossible and unknown input, honor Brazilian day',()=>{
 assert.equal(parseDueDate('2026-02-30'),null);assert.equal(parseDueDate('blah'),null);
 assert.equal(parseDueDate('2028-02-29'),'2028-02-29T12:00:00.000Z');
 assert.equal(parseDueDate('hoje',new Date('2026-11-17T01:00:00Z')),'2026-11-16T12:00:00.000Z');
 assert.equal(parseDueDate('amanhã',new Date('2026-12-31T12:00:00Z')),'2027-01-01T12:00:00.000Z');
});
test('parses reminder fields without AI',()=>{const p=parseReminderInput('pagar internet amanha #casa mensal');assert.equal(p.title,'pagar internet');assert.equal(p.category,'casa');assert.equal(p.recurrence,'monthly');assert.equal(parseRecurrence('diária'),'daily')});
test('webhook rejects missing secrets, old token URLs, malformed JSON',async()=>{
 const {env}=fixture();assert.equal((await worker.fetch(new Request('https://example.invalid/telegram',{method:'POST'}),env)).status,403);
 assert.equal((await worker.fetch(new Request('https://example.invalid/setup-telegram/test-secret-not-real'),env)).status,404);
 assert.equal((await worker.fetch(new Request('https://example.invalid/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},body:'null'}),env)).status,400);
});
test('CRUD, duplicate suppression, invalid draft date and private-chat restriction',async()=>{
 const {env,sql}=fixture();const old=globalThis.fetch;const sent=[];globalThis.fetch=async(_,options)=>{sent.push(JSON.parse(options.body));return Response.json({ok:true})};
 let id=1;const update=(text,chat=12345)=>({update_id:id++,message:{message_id:id,from:{id:12345},chat:{id:chat},text}});
 try{
  const u=update('/novo pagar internet amanha #casa');await handleTelegramUpdate(u,env);await handleTelegramUpdate(u,env);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM reminders').get().n,1);assert.equal(sent.length,1);
  assert.equal((await handleTelegramUpdate(update('/listar',-100),env)).ignored,'unauthorized');assert.equal(sent.length,1);
  await handleTelegramUpdate(update('/listar'),env);assert.match(sent.at(-1).text,/pagar internet/);
  await handleTelegramUpdate(update('/adiar 1 2026-02-30'),env);assert.match(sent.at(-1).text,/invalida/);
  await handleTelegramUpdate(update('/concluir 1'),env);assert.equal(sql.prepare('SELECT status FROM reminders').get().status,'done');
  await handleTelegramUpdate(update('/novo'),env);await handleTelegramUpdate(update('teste'),env);await handleTelegramUpdate(update('banana'),env);
  assert.equal(sql.prepare('SELECT step FROM drafts').get().step,'due');
  await handleTelegramUpdate(update('/cancelar'),env);assert.equal(sql.prepare('SELECT COUNT(*) n FROM drafts').get().n,0);
 }finally{globalThis.fetch=old;sql.close()}
});
test('database failures are not mistaken for duplicates',async()=>{
 const {env}=fixture();env.DB={prepare(){throw new Error('db down')}};
 await assert.rejects(handleTelegramUpdate({update_id:1,message:{message_id:1,from:{id:12345},chat:{id:12345},text:'/start'}},env),/db down/);
});
test('setup uses header secret and fixed path without dropping pending updates',async()=>{
 const {env}=fixture();const old=globalThis.fetch;let body;globalThis.fetch=async(_,o)=>{body=JSON.parse(o.body);return Response.json({ok:true})};
 try{assert.equal((await worker.fetch(new Request('https://example.invalid/setup-telegram',{method:'POST',headers:{Authorization:`Bearer ${env.WEBHOOK_SECRET}`}}),env)).status,200);assert.equal(body.url,'https://example.invalid/telegram');assert.equal(body.secret_token,env.WEBHOOK_SECRET);assert.equal(body.drop_pending_updates,false)}finally{globalThis.fetch=old}
});
test('Telegram rejection surfaces error instead of false success',async()=>{
 const {env}=fixture();const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({ok:false},{status:429});
 try{await assert.rejects(handleTelegramUpdate({update_id:5,message:{message_id:5,from:{id:12345},chat:{id:12345},text:'/start'}},env),/telegram_send_failed/)}finally{globalThis.fetch=old}
});
test('scheduled delivery reads due reminders and calls only simulated Telegram',async()=>{
 const {env,sql}=fixture();sql.prepare("INSERT INTO reminders(owner_id,title,due_at,created_at,updated_at) VALUES (?,?,?,?,?)").run('12345','teste','2020-01-01T12:00:00Z','2020','2020');
 const old=globalThis.fetch;let count=0;globalThis.fetch=async()=>{count++;return Response.json({ok:true})};
 try{await worker.scheduled({},env);assert.equal(count,1)}finally{globalThis.fetch=old;sql.close()}
});
