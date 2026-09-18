import {accessText,applicationText,cabinetText,managerMenu,orderKeyboard,orderText,shiftText,statsText,withdrawalText,workerMenu,workerProfileText} from './views.mjs';
import {REGIONS,regionKeyByCity,regionLabel} from './regions.mjs';
import {contactKeyboard,decimal,escapeHtml as e,inline,int,money,parseMoscowDate,removeKeyboard} from './utils.mjs';

const decisionKeyboard=(kind,id,yes='Одобрить',no='Отклонить')=>inline([[
  {text:`✅ ${yes}`,callback_data:`${kind}:${id}:approve`},
  {text:`❌ ${no}`,callback_data:`${kind}:${id}:decline`},
]]);

export class BotApp{
  constructor({db,telegram,addressProvider=null,logger=console,adminUsernames=[]}){
    this.db=db;this.tg=telegram;this.addressProvider=addressProvider;this.log=logger;
    this.adminUsernames=new Set(adminUsernames.map(value=>String(value).replace(/^@/,'').toLowerCase()).filter(Boolean));
  }

  async safeSend(chatId,text,options={}){try{return await this.tg.sendMessage(chatId,text,options);}catch(error){this.log.error?.(`Не удалось отправить сообщение ${chatId}:`,error.message);return null;}}
  async notifyManagers(text,options={}){for(const manager of this.db.listManagers())await this.safeSend(manager.telegram_id,text,options);}
  async broadcastWorkers(text,options={}){for(const worker of this.db.listActiveWorkers())await this.safeSend(worker.telegram_id,text,options);}
  async sendOrderToWorker(worker,order,{save=false}={}){
    const sent=await this.safeSend(worker.telegram_id,orderText(order,{worker}),{reply_markup:orderKeyboard(order)});
    if(save&&sent?.message_id)this.db.saveOrderMessage(order.id,worker.telegram_id,sent.message_id);
    return sent;
  }
  async broadcastRegionOrder(order,{save=false}={}){
    const workers=order.region?this.db.listActiveWorkersByRegion(order.region):this.db.listActiveWorkers();
    for(const worker of workers)await this.sendOrderToWorker(worker,order,{save});
  }
  async publishGeneratedOrder(order){return this.broadcastRegionOrder(order,{save:true});}
  async refreshOrderMessages(orderId){
    const order=this.db.getOrder(orderId);if(!order)return;
    for(const item of this.db.listOrderMessages(orderId)){
      const worker=this.db.getUser(item.user_id);if(!worker)continue;
      try{await this.tg.editMessage(item.user_id,item.message_id,orderText(order,{worker}),{reply_markup:orderKeyboard(order)});}catch(error){this.log.warn?.('Не удалось обновить сообщение заказа:',error.message);}
    }
  }

  isManager(user){return user?.role==='manager'&&user?.status==='active';}
  isWorker(user){return user?.role==='worker'&&user?.status==='active';}
  menuFor(user){return this.isManager(user)?managerMenu:workerMenu;}
  async menu(chatId,user,text='Выберите действие:'){return this.safeSend(chatId,text,{reply_markup:this.menuFor(user)});}

  async handleUpdate(update){
    if(update.message)return this.handleMessage(update.message);
    if(update.callback_query)return this.handleCallback(update.callback_query);
  }

  async handleMessage(message){
    if(message.chat?.type&&message.chat.type!=='private')return;
    let user=this.db.upsertUser(message.from);
    if(message.from?.username&&this.adminUsernames.has(message.from.username.toLowerCase())){
      this.db.ensureManager(user.telegram_id);
      user=this.db.getUser(user.telegram_id);
    }
    const chatId=message.chat.id;
    const text=String(message.text||'').trim();
    if(text==='/cancel'||text==='Отмена'){this.db.clearSession(user.telegram_id);return this.menu(chatId,user,'Действие отменено.');}
    if(text.startsWith('/start'))return this.start(chatId,user);
    if(text==='/menu')return this.menu(chatId,user);
    if(text==='/help'||text==='🆘 Помощь')return this.help(chatId,user);
    const session=this.db.getSession(user.telegram_id);
    if(session)return this.handleSession(message,user,session);
    if(!this.isManager(user)&&!this.isWorker(user))return this.start(chatId,user);
    return this.routeMenu(chatId,user,text);
  }

  async start(chatId,user){
    this.db.clearSession(user.telegram_id);
    if(this.isManager(user))return this.menu(chatId,user,'<b>Панель менеджера «Алёша Попович»</b>');
    if(this.isWorker(user))return this.menu(chatId,user,`С возвращением, ${e(user.first_name||'коллега')}!`);
    if(user.status==='pending')return this.safeSend(chatId,'<b>Заявка уже у менеджера.</b>\nСообщим здесь, как только доступ будет выдан.',{reply_markup:removeKeyboard()});
    return this.safeSend(chatId,[
      '<b>Работа грузчиком в «Алёша Попович»</b>',
      'Здесь появляются актуальные заказы по всей России. После допуска можно откликаться, получать уведомления, отмечать смены, смотреть заработок и запрашивать выплату.',
      '',`Ваш Telegram ID: <code>${e(user.telegram_id)}</code>`,
    ].join('\n'),{reply_markup:inline([[{text:'Получить доступ',callback_data:'access_start'}]])});
  }

  async help(chatId,user){
    const text=this.isManager(user)
      ?'<b>Помощь менеджеру</b>\nСоздавайте заказы, рассматривайте отклики и заявки на доступ, подтверждайте смены и выплаты. Любой ввод можно остановить командой /cancel.'
      :'<b>Как пользоваться ботом</b>\n1. Откройте активные заказы и откликнитесь.\n2. После одобрения адрес появится в «Моих сменах».\n3. В день работы нажмите «Начать», после работы — «Завершить».\n4. Подтверждённая сумма попадёт в личный кабинет.\n\nПо организационным вопросам: @AleshaPopovichManager';
    return this.safeSend(chatId,text,{reply_markup:this.menuFor(user)});
  }

  async routeMenu(chatId,user,text){
    if(this.isManager(user)){
      if(text==='➕ Создать заказ')return this.beginOrder(chatId,user);
      if(text==='📋 Заказы')return this.showManagedOrders(chatId);
      if(text==='🔑 Доступы')return this.showAccess(chatId);
      if(text==='👷 Отклики')return this.showApplications(chatId);
      if(text==='✅ Подтвердить смены')return this.showShiftConfirmations(chatId);
      if(text==='💸 Выплаты')return this.showWithdrawals(chatId);
      if(text==='👥 Грузчики')return this.showWorkers(chatId);
      if(text==='📊 Статистика')return this.safeSend(chatId,statsText(this.db.stats()),{reply_markup:managerMenu});
    }else{
      if(text==='📦 Активные заказы')return this.showOrders(chatId,user);
      if(text==='🗓 Мои смены')return this.showShifts(chatId,user,false);
      if(text==='📜 История смен')return this.showShifts(chatId,user,true);
      if(text==='💰 Личный кабинет')return this.safeSend(chatId,cabinetText(user,this.db.getCabinet(user.telegram_id)),{reply_markup:workerMenu});
      if(text==='💸 Запросить выплату')return this.beginWithdrawal(chatId,user);
      if(text==='🔔 Уведомления'){const changed=this.db.toggleNotifications(user.telegram_id);return this.menu(chatId,changed,`Уведомления о новых заказах ${changed.notifications?'включены':'выключены'}.`);}
    }
    return this.menu(chatId,user,'Не понял команду. Выберите действие кнопкой.');
  }

  beginAccess(chatId,user){this.db.setSession(user.telegram_id,'access','name',{});return this.safeSend(chatId,'Как вас зовут? Напишите имя и фамилию.',{reply_markup:removeKeyboard()});}
  beginOrder(chatId,user){this.db.setSession(user.telegram_id,'order','title',{});return this.safeSend(chatId,'Введите короткое название заказа. Например: «Разгрузка фуры».',{reply_markup:removeKeyboard()});}
  beginWithdrawal(chatId,user){
    const cabinet=this.db.getCabinet(user.telegram_id);
    if(!cabinet.available)return this.menu(chatId,user,'Сейчас нет средств, доступных к выводу.');
    this.db.setSession(user.telegram_id,'withdrawal','amount',{});
    return this.safeSend(chatId,`Доступно: <b>${money(cabinet.available)}</b>. Введите сумму целым числом.`,{reply_markup:inline([[{text:`Вывести всё — ${money(cabinet.available)}`,callback_data:`withdraw_all:${cabinet.available}`}],[{text:'Отмена',callback_data:'cancel'}]])});
  }

  async handleSession(message,user,session){
    const text=String(message.text||'').trim();
    if(session.flow==='access')return this.accessSession(message,user,session,text);
    if(session.flow==='order'&&this.isManager(user))return this.orderSession(message,user,session,text);
    if(session.flow==='withdrawal'&&this.isWorker(user))return this.withdrawalSession(message,user,text);
    if(session.flow==='shift_edit'&&this.isManager(user))return this.shiftEditSession(message,user,session,text);
    if(session.flow==='worker_region'&&this.isManager(user))return this.workerRegionSession(message,user,session,text);
    this.db.clearSession(user.telegram_id);return this.start(message.chat.id,user);
  }

  async accessSession(message,user,session,text){
    const chatId=message.chat.id,data={...session.data};
    if(session.step==='name'){
      if(text.length<2)return this.safeSend(chatId,'Укажите имя и фамилию текстом.');
      data.name=text;this.db.setSession(user.telegram_id,'access','city',data);return this.safeSend(chatId,'В каком городе вы готовы работать?');
    }
    if(session.step==='city'){
      if(text.length<2)return this.safeSend(chatId,'Напишите название города.');
      data.city=text;this.db.setSession(user.telegram_id,'access','phone',data);return this.safeSend(chatId,'Отправьте номер телефона кнопкой или введите его текстом.',{reply_markup:contactKeyboard()});
    }
    if(session.step==='phone'){
      const phone=message.contact?.phone_number||text;if(phone.replace(/\D/g,'').length<10)return this.safeSend(chatId,'Проверьте номер и отправьте ещё раз.');
      data.phone=phone;this.db.setSession(user.telegram_id,'access','experience',data);return this.safeSend(chatId,'Коротко опишите опыт работы. Если опыта нет, напишите «нет».',{reply_markup:removeKeyboard()});
    }
    if(session.step==='experience'){
      data.experience=text||'нет';const id=this.db.createAccessRequest(user.telegram_id,data);this.db.clearSession(user.telegram_id);
      const item=this.db.getAccessRequest(id);await this.notifyManagers(accessText(item),{reply_markup:decisionKeyboard('access_decide',id)});
      return this.safeSend(chatId,'<b>Заявка отправлена.</b>\nМенеджер проверит данные и выдаст доступ в этом чате.');
    }
  }

  async orderSession(message,user,session,text){
    const chatId=message.chat.id,data={...session.data};
    const next=(step,prompt)=>{this.db.setSession(user.telegram_id,'order',step,data);return this.safeSend(chatId,prompt);};
    if(session.step==='title'){if(text.length<3)return this.safeSend(chatId,'Название слишком короткое.');data.title=text;return next('city','Город выполнения заказа?');}
    if(session.step==='city'){if(text.length<2)return this.safeSend(chatId,'Укажите город.');data.city=text;return next('address','Введите точный адрес. Его увидят только назначенные грузчики.');}
    if(session.step==='address'){if(text.length<5)return this.safeSend(chatId,'Укажите адрес подробнее.');data.address=text;return next('startsAt','Дата и время по Москве в формате <b>ДД.ММ.ГГГГ ЧЧ:ММ</b>.');}
    if(session.step==='startsAt'){const value=parseMoscowDate(text);if(!value||new Date(value)<=new Date())return this.safeSend(chatId,'Нужны корректные будущие дата и время, например: 21.09.2026 09:30');data.startsAt=value;return next('duration','Ориентировочная длительность в часах?');}
    if(session.step==='duration'){const value=decimal(text,{min:.5,max:48});if(value==null)return this.safeSend(chatId,'Введите число от 0,5 до 48.');data.durationHours=value;return next('people','Сколько грузчиков нужно?');}
    if(session.step==='people'){const value=int(text,{min:1,max:100});if(value==null)return this.safeSend(chatId,'Введите целое число от 1 до 100.');data.peopleNeeded=value;data.selfEmployedRate=450;return next('ipRate','Ставка для ИП в час? Минимум <b>550 ₽/ч</b>. Для самозанятых ставка фиксирована: <b>450 ₽/ч</b>.');}
    if(session.step==='ipRate'){const value=int(text,{min:550,max:10_000});if(value==null)return this.safeSend(chatId,'Введите ставку ИП от 550 ₽/ч.');data.ipRate=value;data.amount=Math.round(450*Number(data.durationHours));return next('description','Добавьте описание работы, требования и что взять с собой. Если нечего добавить — отправьте «-».');}
    if(session.step==='description'){
      data.description=text==='-'?'':text;this.db.setSession(user.telegram_id,'order','confirm',data);
      const preview={id:'—',...data,starts_at:data.startsAt,duration_hours:data.durationHours,people_needed:data.peopleNeeded,amount:data.amount,assigned_count:0};
      return this.safeSend(chatId,`${orderText(preview,{manager:true})}\n\n<b>Опубликовать заказ?</b>`,{reply_markup:inline([[{text:'🚀 Опубликовать',callback_data:'order_publish'}],[{text:'Отмена',callback_data:'cancel'}]])});
    }
    return this.safeSend(chatId,'Подтвердите публикацию кнопкой ниже или отмените /cancel.');
  }

  async withdrawalSession(message,user,text){
    const amount=int(text,{min:1,max:10_000_000});if(amount==null)return this.safeSend(message.chat.id,'Введите сумму целым числом.');
    return this.createWithdrawal(message.chat.id,user,amount);
  }
  async workerRegionSession(message,user,session,text){
    const chatId=message.chat.id;
    if(text.length<2)return this.safeSend(chatId,'Введите город, область, край или республику России.');
    const geo=await this.addressProvider?.resolveRegion(text);
    if(!geo)return this.safeSend(chatId,'Не удалось найти такой регион или город в России. Проверьте написание и попробуйте ещё раз.');
    const worker=this.db.updateWorkerProfile(session.data.workerId,{region:geo.region_key});
    this.db.clearSession(user.telegram_id);
    const name=worker?.first_name||worker?.username||worker?.telegram_id||'Грузчик';
    return this.menu(chatId,user,worker?`Регион для ${e(name)}: <b>${e(geo.label)}</b>.`:'Грузчик не найден.');
  }

  async shiftEditSession(message,user,session,text){
    const chatId=message.chat.id,data={...session.data};
    if(session.step==='amount'){const value=int(text,{min:0,max:1_000_000});if(value==null)return this.safeSend(chatId,'Введите сумму целым числом.');data.amount=value;this.db.setSession(user.telegram_id,'shift_edit','hours',data);return this.safeSend(chatId,'Сколько часов отработано?');}
    if(session.step==='hours'){const value=decimal(text,{min:.1,max:72});if(value==null)return this.safeSend(chatId,'Введите число от 0,1 до 72.');data.hours=value;this.db.setSession(user.telegram_id,'shift_edit','notes',data);return this.safeSend(chatId,'Комментарий к смене или «-».');}
    if(session.step==='notes'){
      const shift=this.db.completeShift(data.shiftId,user.telegram_id,{amount:data.amount,hours:data.hours,notes:text==='-'?'':text});this.db.clearSession(user.telegram_id);
      if(!shift)return this.menu(chatId,user,'Смена уже обработана.');
      await this.safeSend(shift.user_id,`<b>Смена подтверждена.</b>\nНачислено: ${money(shift.amount)}. Средства доступны в личном кабинете.`,{reply_markup:workerMenu});
      return this.menu(chatId,user,'Смена подтверждена, начисление добавлено.');
    }
  }

  async showOrders(chatId,user){
    const orders=this.db.listActiveOrders({region:user.region||'',city:user.region?'':user.city});if(!orders.length)return this.menu(chatId,user,'Сейчас активных заказов для вашего региона нет. Новые заказы придут уведомлением.');
    await this.safeSend(chatId,`<b>Активные заказы: ${orders.length}</b>`,{reply_markup:workerMenu});
    const apps=new Map(this.db.listUserApplications(user.telegram_id,50).map(item=>[item.order_id,item]));
    for(const order of orders){const app=apps.get(order.id);await this.safeSend(chatId,orderText(order,{worker:user}),{reply_markup:orderKeyboard(order,{applied:app?.status==='pending',applicationId:app?.id})});}
  }
  async showManagedOrders(chatId){const list=this.db.listManagedOrders();if(!list.length)return this.safeSend(chatId,'Активных заказов нет.',{reply_markup:managerMenu});for(const item of list)await this.safeSend(chatId,orderText(item,{manager:true}),{reply_markup:orderKeyboard(item,{manager:true})});}
  async showWorkers(chatId){
    const list=this.db.listWorkers();if(!list.length)return this.safeSend(chatId,'Активных грузчиков нет.',{reply_markup:managerMenu});
    for(const worker of list){
      const rows=[
        [{text:worker.contractor_type==='ip'?'✅ ИП':'Сделать ИП',callback_data:`worker_type:${worker.telegram_id}:ip`},{text:worker.contractor_type==='self_employed'?'✅ Самозанятый':'Самозанятый',callback_data:`worker_type:${worker.telegram_id}:self_employed`}],
        ...Object.keys(REGIONS).map(key=>[{text:`${worker.region===key?'✅ ':''}${regionLabel(key)}`,callback_data:`worker_region:${worker.telegram_id}:${key}`}]),
      ];
      await this.safeSend(chatId,workerProfileText({...worker,region:regionLabel(worker.region)}),{reply_markup:inline(rows)});
    }
  }
  async showAccess(chatId){const list=this.db.listPendingAccess();if(!list.length)return this.safeSend(chatId,'Новых заявок на доступ нет.',{reply_markup:managerMenu});for(const item of list)await this.safeSend(chatId,accessText(item),{reply_markup:decisionKeyboard('access_decide',item.id)});}
  async showApplications(chatId,orderId=null){const list=orderId?this.db.listOrderApplications(orderId):this.db.listPendingApplications();if(!list.length)return this.safeSend(chatId,'Новых откликов нет.',{reply_markup:managerMenu});for(const item of list)await this.safeSend(chatId,applicationText(item),{reply_markup:decisionKeyboard('application_decide',item.id,'Назначить')});}
  async showShiftConfirmations(chatId){const list=this.db.listPendingShiftConfirmations();if(!list.length)return this.safeSend(chatId,'Смен на подтверждении нет.',{reply_markup:managerMenu});for(const item of list)await this.safeSend(chatId,`${shiftText(item)}\n\nГрузчик: ${e([item.first_name,item.last_name].filter(Boolean).join(' ')||item.username||item.user_id)}`,{reply_markup:inline([[{text:'✅ По плану',callback_data:`shift_complete:${item.id}`},{text:'✏️ Изменить',callback_data:`shift_edit:${item.id}`} ]])});}
  async showWithdrawals(chatId){const list=this.db.listPendingWithdrawals();if(!list.length)return this.safeSend(chatId,'Заявок на выплату нет.',{reply_markup:managerMenu});for(const item of list)await this.safeSend(chatId,withdrawalText(item),{reply_markup:decisionKeyboard('withdrawal_decide',item.id,'Выплачено')});}
  async showShifts(chatId,user,history){const list=this.db.listUserShifts(user.telegram_id,{history});if(!list.length)return this.menu(chatId,user,history?'История смен пока пустая.':'Назначенных смен пока нет.');for(const shift of list){let buttons=[];if(shift.status==='assigned')buttons=[[{text:'▶️ Начать смену',callback_data:`shift_start:${shift.id}`}]];if(shift.status==='in_progress')buttons=[[{text:'🏁 Завершить смену',callback_data:`shift_finish:${shift.id}`}]];await this.safeSend(chatId,shiftText(shift,{history}),{reply_markup:buttons.length?inline(buttons):workerMenu});}}

  async createWithdrawal(chatId,user,amount){const result=this.db.createWithdrawal(user.telegram_id,amount);if(result.error)return this.safeSend(chatId,`Недоступная сумма. Сейчас можно вывести ${money(result.cabinet.available)}.`);this.db.clearSession(user.telegram_id);await this.notifyManagers(withdrawalText(result.withdrawal),{reply_markup:decisionKeyboard('withdrawal_decide',result.withdrawal.id,'Выплачено')});return this.menu(chatId,user,`Заявка на ${money(amount)} отправлена менеджеру.`);}

  async handleCallback(query){
    const user=this.db.upsertUser(query.from),chatId=query.message?.chat?.id??query.from.id,data=query.data||'';
    await this.tg.answerCallback(query.id).catch(()=>{});
    if(data==='cancel'){this.db.clearSession(user.telegram_id);return this.menu(chatId,user,'Действие отменено.');}
    if(data==='access_start')return this.beginAccess(chatId,user);
    if(data==='order_publish'&&this.isManager(user)){
      const session=this.db.getSession(user.telegram_id);if(!session||session.flow!=='order'||session.step!=='confirm')return this.menu(chatId,user,'Черновик не найден. Создайте заказ заново.');
      const payload={...session.data,region:regionKeyByCity(session.data.city)};const order=this.db.createOrder(payload,user.telegram_id);this.db.clearSession(user.telegram_id);await this.broadcastRegionOrder(order);return this.menu(chatId,user,`Заказ №${order.id} опубликован и разослан грузчикам ${order.region?'региона '+regionLabel(order.region):'по доступной базе'}.`);
    }
    let match=data.match(/^access_decide:(\d+):(approve|decline)$/);if(match&&this.isManager(user)){
      const result=this.db.decideAccess(Number(match[1]),user.telegram_id,match[2]==='approve');if(!result)return this.safeSend(chatId,'Заявка уже обработана.');
      if(match[2]==='approve'){const region=regionKeyByCity(result.city);if(region)this.db.updateWorkerProfile(result.user_id,{region});}
      await this.safeSend(result.user_id,match[2]==='approve'?'<b>Доступ выдан!</b> Теперь вам доступны заказы, смены и личный кабинет.':'Заявка отклонена. Уточнить причину можно у @AleshaPopovichManager',{reply_markup:match[2]==='approve'?workerMenu:removeKeyboard()});return this.safeSend(chatId,`Заявка №${result.id}: ${match[2]==='approve'?'доступ выдан':'отклонена'}.`);
    }
    match=data.match(/^worker_type:(\d+):(ip|self_employed)$/);if(match&&this.isManager(user)){const worker=this.db.updateWorkerProfile(match[1],{contractorType:match[2]});return this.safeSend(chatId,worker?`${worker.first_name||worker.username||worker.telegram_id}: оформление — ${worker.contractor_type==='ip'?'ИП (повышенная ставка)':'самозанятый'}.`:'Грузчик не найден.');}
    match=data.match(/^worker_region:(\d+):([a-z_]+)$/);if(match&&this.isManager(user)){if(!REGIONS[match[2]])return this.safeSend(chatId,'Неизвестный регион.');const worker=this.db.updateWorkerProfile(match[1],{region:match[2]});return this.safeSend(chatId,worker?`${worker.first_name||worker.username||worker.telegram_id}: регион — ${regionLabel(worker.region)}.`:'Грузчик не найден.');}
    match=data.match(/^order_apply:(\d+)$/);if(match&&this.isWorker(user)){
      const result=this.db.applyToOrder(Number(match[1]),user.telegram_id);const messages={closed:'Заказ уже закрыт или набран.',access:'Нет доступа.',duplicate:'Вы уже откликались на этот заказ.'};if(result.error)return this.safeSend(chatId,messages[result.error]);
      await this.notifyManagers(applicationText(result.application),{reply_markup:decisionKeyboard('application_decide',result.application.id,'Назначить')});return this.safeSend(chatId,'Отклик отправлен. После назначения точный адрес появится в ваших сменах.');
    }
    match=data.match(/^application_withdraw:(\d+)$/);if(match&&this.isWorker(user)){const result=this.db.withdrawApplication(Number(match[1]),user.telegram_id);return this.safeSend(chatId,result?'Отклик отозван.':'Отклик уже обработан.');}
    match=data.match(/^application_decide:(\d+):(approve|decline)$/);if(match&&this.isManager(user)){
      const result=this.db.decideApplication(Number(match[1]),user.telegram_id,match[2]==='approve');if(!result)return this.safeSend(chatId,'Отклик уже обработан.');if(result.error==='full')return this.safeSend(chatId,'Все места уже заняты или заказ закрыт.');
      if(match[2]==='approve'){await this.safeSend(result.user_id,`<b>Вы назначены на заказ!</b>\n${shiftText(result.shift)}`,{reply_markup:workerMenu});await this.refreshOrderMessages(result.order_id);}else await this.safeSend(result.user_id,`Отклик на «${e(result.title)}» отклонён. Посмотрите другие активные заказы.`,{reply_markup:workerMenu});return this.safeSend(chatId,`Отклик №${result.id} обработан.`);
    }
    match=data.match(/^order_apps:(\d+)$/);if(match&&this.isManager(user))return this.showApplications(chatId,Number(match[1]));
    match=data.match(/^order_status:(\d+):(closed|cancelled)$/);if(match&&this.isManager(user)){
      const orderId=Number(match[1]),assigned=match[2]==='cancelled'?this.db.listOrderShifts(orderId):[];const order=this.db.setOrderStatus(orderId,match[2],user.telegram_id);
      if(order&&match[2]==='cancelled')for(const shift of assigned)await this.safeSend(shift.user_id,`<b>Смена отменена менеджером</b>\n${shiftText({...shift,status:'cancelled'})}`,{reply_markup:workerMenu});
      return this.safeSend(chatId,order?`Заказ №${order.id}: ${match[2]==='closed'?'закрыт':'отменён'}.`:'Заказ не найден.');
    }
    match=data.match(/^shift_start:(\d+)$/);if(match&&this.isWorker(user)){const shift=this.db.startShift(Number(match[1]),user.telegram_id);return this.safeSend(chatId,shift?'Смена начата. После работы нажмите «Завершить смену» в разделе «Мои смены».':'Не удалось начать смену. Проверьте её статус.');}
    match=data.match(/^shift_finish:(\d+)$/);if(match&&this.isWorker(user)){const shift=this.db.finishShift(Number(match[1]),user.telegram_id);if(!shift)return this.safeSend(chatId,'Не удалось завершить смену.');await this.notifyManagers(`<b>Смена ожидает подтверждения</b>\n${shiftText(shift)}`,{reply_markup:inline([[{text:'✅ По плану',callback_data:`shift_complete:${shift.id}`},{text:'✏️ Изменить',callback_data:`shift_edit:${shift.id}`} ]])});return this.safeSend(chatId,'Смена завершена и отправлена менеджеру на подтверждение.');}
    match=data.match(/^shift_complete:(\d+)$/);if(match&&this.isManager(user)){const before=this.db.getShift(Number(match[1]));if(!before)return this.safeSend(chatId,'Смена не найдена.');const shift=this.db.completeShift(before.id,user.telegram_id,{hours:before.duration_hours,amount:before.planned_amount,notes:''});if(!shift)return this.safeSend(chatId,'Смена уже обработана.');await this.safeSend(shift.user_id,`<b>Смена подтверждена.</b> Начислено ${money(shift.amount)}.`,{reply_markup:workerMenu});return this.safeSend(chatId,'Смена подтверждена по плану.');}
    match=data.match(/^shift_edit:(\d+)$/);if(match&&this.isManager(user)){const shift=this.db.getShift(Number(match[1]));if(!shift||shift.status!=='pending_confirmation')return this.safeSend(chatId,'Смена уже обработана.');this.db.setSession(user.telegram_id,'shift_edit','amount',{shiftId:shift.id});return this.safeSend(chatId,`Введите итоговую сумму. План: ${money(shift.planned_amount)}.`,{reply_markup:removeKeyboard()});}
    match=data.match(/^withdraw_all:(\d+)$/);if(match&&this.isWorker(user))return this.createWithdrawal(chatId,user,Number(match[1]));
    match=data.match(/^withdrawal_decide:(\d+):(approve|decline)$/);if(match&&this.isManager(user)){const item=this.db.decideWithdrawal(Number(match[1]),user.telegram_id,match[2]==='approve');if(!item)return this.safeSend(chatId,'Заявка уже обработана.');await this.safeSend(item.user_id,match[2]==='approve'?`Выплата ${money(item.amount)} отмечена как выполненная.`:`Заявка на ${money(item.amount)} отклонена. Сумма снова доступна к выводу.`,{reply_markup:workerMenu});return this.safeSend(chatId,'Статус выплаты обновлён.');}
    return this.safeSend(chatId,'Кнопка устарела. Откройте нужный раздел ещё раз.');
  }

  async sendReminders(minutes=120){const before=new Date(Date.now()+minutes*60_000).toISOString();for(const item of this.db.remindersDue(before)){const sent=await this.safeSend(item.user_id,`<b>Смена скоро начнётся</b>\n${e(item.title)} · ${e(item.city)}\nАдрес: ${e(item.address)}\nВремя: ${new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Moscow'}).format(new Date(item.starts_at))}`);if(sent)this.db.markNotification('shift_reminder',item.id,item.user_id);}}
}
