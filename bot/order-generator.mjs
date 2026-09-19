import process from 'node:process';
import {randomFrom,randomInt} from './regions.mjs';

const TEMPLATES=[
  {title:'Разгрузка фуры',locationType:'warehouse',duration:[6,12],people:[2,5],description:'Длинная смена: разгрузка и перенос груза на объекте.'},
  {title:'Разгрузка стройматериалов',locationType:'warehouse',duration:[6,14],people:[2,5],description:'Длинная смена по разгрузке стройматериалов в бригаде.'},
  {title:'Квартирный переезд',locationType:'apartment',duration:[5,10],people:[2,5],description:'Переезд под ключ: мебель, коробки и аккуратная расстановка.'},
  {title:'Перенос мебели',locationType:'apartment',duration:[5,9],people:[1,4],description:'Перенос и расстановка мебели, техника и упаковка.'},
  {title:'Разгрузка товара',locationType:'retail',duration:[5,11],people:[2,5],description:'Разгрузка поставки и перенос товара в помещение.'},
];

const weightedIpRate=urgent=>randomFrom(urgent?[650,650,700,700,750,800]:[550,550,550,600,600,650]);

export class OrderGenerator{
  constructor({db,app,addressProvider,logger=console}){
    this.db=db;this.app=app;this.addressProvider=addressProvider;this.log=logger;
    this.enabled=process.env.BOT_AUTO_ORDERS!=='0';
    // Demand simulation is part of the production feed: it creates urgency
    // for workers without creating fake Telegram users or fake shifts.
    this.simulationMode=process.env.BOT_SIMULATION_MODE!=='off';
    this.maxActive=7;
    this.startupTargets=new Map();
    this.seededRegions=new Set();
  }

  async tick(){
    if(!this.enabled){this.log.log?.('Автогенератор заказов выключен: установите BOT_AUTO_ORDERS=1.');return;}
    const managerId=this.db.getGeneratorManagerId();
    if(!managerId){this.log.warn?.('Автогенератор: не найден активный менеджер. Укажите BOT_ADMIN_IDS или войдите менеджером в бот.');return;}

    const workers=this.db.listAutoOrderWorkers();
    if(!workers.length){
      this.log.warn?.('Автогенератор: нет верифицированных грузчиков с назначенным регионом.');
      return;
    }
    for(const worker of workers){
      const userId=String(worker.telegram_id);
      let active=this.db.countActiveGeneratedOrdersForUser(userId);

      if(!this.seededRegions.has(userId)){
        const startupTarget=this.startupTargets.get(userId)??randomInt(3,this.maxActive);
        this.startupTargets.set(userId,startupTarget);
        const missing=Math.max(0,startupTarget-active);
        for(let i=0;i<missing;i++){
          const order=await this.createOrder(worker,managerId);
          if(!order)break;
          active++;
          this.log.log?.(`Стартовый автозаказ №${order.id} создан без уведомления для ${userId}: ${order.city}${order.urgent?' (срочный)':''}`);
        }
        if(active>=startupTarget)this.seededRegions.add(userId);
        continue;
      }

      const rawFrequency=Number(worker.auto_orders_per_hour);
      const frequency=Math.min(60,Math.max(0,Number.isFinite(rawFrequency)?rawFrequency:1.5));
      if(active<this.maxActive&&frequency>0&&Math.random()<frequency/60){
        const order=await this.createOrder(worker,managerId);
        if(!order)continue;
        await this.app.publishGeneratedOrder(order);
        this.log.log?.(`Автозаказ №${order.id} создан для ${userId}: ${order.city}${order.urgent?' (срочный)':''}`);
      }
    }

    for(const order of this.db.listActiveGeneratedOrders('',1000)){
      await this.advance(order,managerId);
    }
  }

  async createOrder(worker,managerId){
    const region=worker.region;
    const rawUrgentChance=Number(worker.urgent_order_chance);
    const urgentChance=Math.min(.9,Math.max(0,Number.isFinite(rawUrgentChance)?rawUrgentChance:.35));
    const urgent=Math.random()<urgentChance;
    const template=randomFrom(TEMPLATES);
    const durationHours=randomInt(template.duration[0],template.duration[1]);
    const peopleNeeded=Math.min(5,randomInt(template.people[0],template.people[1]));
    const hoursBefore=urgent?randomInt(1,3):randomInt(4,24);
    const minute=randomFrom([0,15,30,45]);
    const starts=new Date(Date.now()+hoursBefore*60*60_000);
    starts.setMinutes(minute,0,0);
    const selfEmployedRate=450;
    const ipRate=weightedIpRate(urgent);
    const simulatedAssigned=this.simulationMode?randomInt(0,Math.min(2,Math.max(0,peopleNeeded-1))):0;
    const resolved=await this.addressProvider?.getAddress(region);
    if(!resolved){this.log.warn?.(`Нет реального адреса для региона ${region}; заказ пропущен.`);return null;}

    let order=this.db.createGeneratedOrder({
      title:urgent?`Срочно: ${template.title}`:template.title,
      city:resolved.regionLabel,
      region:resolved.regionKey,
      address:resolved.address,
      startsAt:starts.toISOString(),
      durationHours,
      peopleNeeded,
      selfEmployedRate,
      ipRate,
      amount:selfEmployedRate*durationHours,
      description:`${template.description} ИП получают повышенную ставку — обычно на 20–35% выше базовой.`,
      urgent,
      simulatedAssigned,
      targetUserId:worker.telegram_id,
    },managerId);
    const point=await this.addressProvider?.geocodeAddress(resolved.address,resolved.regionLabel);
    if(point)order=this.db.updateOrderLocation(order.id,point);
    return order;
  }

  async advance(order,managerId){
    const minutesLeft=(new Date(order.starts_at).getTime()-Date.now())/60_000;
    if(minutesLeft<=0){
      const closed=this.db.setOrderStatus(order.id,'closed',managerId);
      if(closed)await this.app.refreshOrderMessages(order.id);
      return;
    }

    let ipRate=Number(order.ip_rate)||550;
    const fill=(Number(order.assigned_count)||0)+(Number(order.simulated_assigned)||0);
    const ratio=fill/Math.max(1,Number(order.people_needed)||1);
    if(order.urgent&&ratio<.8){
      if(minutesLeft<=60)ipRate=Math.max(ipRate,800);
      else if(minutesLeft<=120)ipRate=Math.max(ipRate,700);
      else if(minutesLeft<=180)ipRate=Math.max(ipRate,650);
    }

    let simulatedAssigned=Number(order.simulated_assigned)||0;
    if(this.simulationMode&&Math.random()<.28){
      const real=Number(order.assigned_count)||0;
      const maxSimulated=Math.max(0,Number(order.people_needed)-real-1);
      const delta=Math.random()<.78?1:-1;
      simulatedAssigned=Math.min(maxSimulated,Math.max(0,simulatedAssigned+delta));
    }

    if(ipRate!==Number(order.ip_rate)||simulatedAssigned!==Number(order.simulated_assigned)){
      const previous={...order};
      const updated=this.db.updateGeneratedOrderDynamics(order.id,{ipRate,simulatedAssigned});
      if(ipRate>Number(previous.ip_rate))await this.app.notifyRateIncrease(previous,updated);
      await this.app.refreshOrderMessages(order.id);
    }
  }
}
