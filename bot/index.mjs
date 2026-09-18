import fs from 'node:fs';
import process from 'node:process';
import {BotDatabase} from './db.mjs';
import {TelegramClient} from './telegram.mjs';
import {BotApp} from './app.mjs';

function loadEnv(filename='.env'){
  if(!fs.existsSync(filename))return;
  for(const raw of fs.readFileSync(filename,'utf8').split(/\r?\n/)){
    const line=raw.trim();if(!line||line.startsWith('#'))continue;
    const index=line.indexOf('=');if(index<1)continue;
    const key=line.slice(0,index).trim();let value=line.slice(index+1).trim();
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    if(process.env[key]===undefined)process.env[key]=value;
  }
}

loadEnv();
const token=process.env.TELEGRAM_BOT_TOKEN;
if(!token)throw new Error('Укажите TELEGRAM_BOT_TOKEN в .env или переменных окружения.');
const adminIds=String(process.env.BOT_ADMIN_IDS||'').split(',').map(value=>value.trim()).filter(Boolean);
const db=new BotDatabase(process.env.BOT_DB_PATH||'data/bot.sqlite');
for(const id of adminIds)db.ensureManager(id);
const telegram=new TelegramClient(token);
const app=new BotApp({db,telegram});
const controller=new AbortController();
const reminderMinutes=Number(process.env.BOT_REMINDER_MINUTES)||120;

try{
  await telegram.setCommands([
    {command:'start',description:'Открыть бот'},
    {command:'menu',description:'Главное меню'},
    {command:'cancel',description:'Отменить текущий ввод'},
    {command:'help',description:'Помощь'},
  ]);
}catch(error){
  console.warn('Telegram временно недоступен при настройке команд. Бот продолжит подключение:',error.message);
}

if(!adminIds.length)console.warn('BOT_ADMIN_IDS пуст. После /start бот покажет Telegram ID; добавьте его в .env и перезапустите бот.');
console.log(`Бот запущен. Менеджеров: ${adminIds.length}. База: ${db.filename}`);

const reminders=setInterval(()=>app.sendReminders(reminderMinutes).catch(error=>console.error('Ошибка напоминаний:',error)),5*60_000);
reminders.unref();

for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>controller.abort());

let offset=Number(db.setting('telegram_offset','0'))||0;
while(!controller.signal.aborted){
  const updates=await telegram.getUpdates(offset,controller.signal);
  for(const update of updates){
    try{await app.handleUpdate(update);}catch(error){console.error(`Ошибка update ${update.update_id}:`,error);}
    offset=update.update_id+1;db.setSetting('telegram_offset',offset);
  }
}

clearInterval(reminders);db.close();console.log('Бот остановлен.');
