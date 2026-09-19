import {readFile} from 'node:fs/promises';
import {basename,extname} from 'node:path';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export class TelegramClient {
  constructor(token,{timeoutMs=35000}={}){
    if(!token)throw new Error('TELEGRAM_BOT_TOKEN is required');
    this.base=`https://api.telegram.org/bot${token}`;
    this.timeoutMs=timeoutMs;
  }
  async call(method,payload={}){
    const response=await fetch(`${this.base}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(this.timeoutMs)});
    const data=await response.json().catch(()=>({ok:false,description:`HTTP ${response.status}`}));
    if(!response.ok||!data.ok){const error=new Error(data.description||`Telegram ${method} failed`);error.code=data.error_code;error.parameters=data.parameters;throw error;}
    return data.result;
  }
  async callMultipart(method,fields={},fileField=null,filePath=null){
    const form=new FormData();
    for(const [key,value] of Object.entries(fields)){
      if(value===undefined||value===null)continue;
      form.set(key,typeof value==='string'?value:JSON.stringify(value));
    }
    if(fileField&&filePath){
      const bytes=await readFile(filePath);
      const mime=extname(filePath).toLowerCase()==='.jpg'||extname(filePath).toLowerCase()==='.jpeg'?'image/jpeg':'image/png';
      form.set(fileField,new Blob([bytes],{type:mime}),basename(filePath));
    }
    const response=await fetch(`${this.base}/${method}`,{method:'POST',body:form,signal:AbortSignal.timeout(this.timeoutMs)});
    const data=await response.json().catch(()=>({ok:false,description:`HTTP ${response.status}` }));
    if(!response.ok||!data.ok){const error=new Error(data.description||`Telegram ${method} failed`);error.code=data.error_code;error.parameters=data.parameters;throw error;}
    return data.result;
  }
  sendMessage(chatId,text,options={}){return this.call('sendMessage',{chat_id:chatId,text,parse_mode:'HTML',link_preview_options:{is_disabled:true},...options});}
  sendPhoto(chatId,photo,caption='',options={}){
    const fields={chat_id:chatId,caption,parse_mode:'HTML',...options};
    return /^https?:\/\//.test(String(photo))||(!String(photo).includes('/')&&!String(photo).includes('\\'))
      ?this.call('sendPhoto',{...fields,photo})
      :this.callMultipart('sendPhoto',fields,'photo',photo);
  }
  async editMessage(chatId,messageId,text,options={}){
    try{return await this.call('editMessageText',{chat_id:chatId,message_id:messageId,text,parse_mode:'HTML',link_preview_options:{is_disabled:true},...options});}
    catch(error){
      if(!/no text in the message/i.test(error.message||''))throw error;
      return this.call('editMessageCaption',{chat_id:chatId,message_id:messageId,caption:text,parse_mode:'HTML',...options});
    }
  }
  answerCallback(id,text='',showAlert=false){return this.call('answerCallbackQuery',{callback_query_id:id,text,show_alert:showAlert});}
  deleteMessage(chatId,messageId){return this.call('deleteMessage',{chat_id:chatId,message_id:messageId});}
  setCommands(commands){return this.call('setMyCommands',{commands});}
  async getUpdates(offset,signal){
    while(!signal.aborted){
      try{return await this.call('getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query']});}
      catch(error){
        if(signal.aborted)return [];
        if(error.code===409)throw new Error('Другой экземпляр бота уже получает обновления (Telegram 409). Остановите дубликат.');
        if(error.code===401||error.code===404)throw error;
        await sleep(Math.max(1500,Number(error.parameters?.retry_after||0)*1000));
      }
    }
    return [];
  }
}

export class FakeTelegramClient {
  constructor(){this.messages=[];this.callbacks=[];this.edits=[];}
  async sendMessage(chatId,text,options={}){const item={message_id:this.messages.length+1,chat:{id:chatId},chatId:String(chatId),text,options};this.messages.push(item);return item;}
  async sendPhoto(chatId,photo,caption='',options={}){const item={message_id:this.messages.length+1,chat:{id:chatId},chatId:String(chatId),photo,caption,text:caption,options};this.messages.push(item);return item;}
  async editMessage(chatId,messageId,text,options={}){this.edits.push({chatId:String(chatId),messageId,text,options});return true;}
  async answerCallback(id,text='',showAlert=false){this.callbacks.push({id,text,showAlert});return true;}
  async setCommands(){return true;}
}
