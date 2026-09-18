import process from 'node:process';
import {randomFrom,randomInt} from './regions.mjs';

const TEMPLATES=[
  {title:'Разгрузка фуры',locationType:'warehouse',duration:[3,7],people:[3,8],description:'Разгрузка и перенос груза на объекте.'},
  {title:'Разгрузка стройматериалов',locationType:'warehouse',duration:[3,8],people:[3,10],description:'Разгрузка стройматериалов, работа в бригаде.'},
  {title:'Квартирный переезд',locationType:'apartment',duration:[2,6],people:[2,5],description:'Перенос мебели и коробок при переезде.'},
  {title:'Перенос мебели',locationType:'apartment',duration:[2,5],people:[2,4],description:'Перенос и расстановка мебели.'},
  {title:'Разгрузка товара',locationType:'retail',duration:[2,6],people:[2,6],description:'Разгрузка поставки и перенос товара в помещение.'},
];

const weightedIpRate=urgent=>randomFrom(urgent?[650,650,700,700,750,800]:[550,550,550,600,600,650]);

export class OrderGenerator{
  constructor({db,app,addressProvider,logger=console}){
    this.db=db;this.app=app;this.addressProvider=addressProvider;this.log=logger;
    this.enabled=process.env.BOT_AUTO_ORDERS!=='0';
    this.simulationMode=process.env.BOT_SIMULATION_MODE==='1';
    this.ordersPerHour=Math.max(.1,Number(process.env.BOT_AUTO_ORDERS_PER_HOUR)||1.5);
    this.maxActive=7;
    this.startupTargets=new Map();
    this.seededRegions=new Set();
    this.urgentChance=Math.min(.9,Math.max(0,Number(process.env.BOT_URGENT_ORDER_CHANCE)||.35));
  }

  async tick(){
    if(!this.enabled){this.log.log?.('Автогенератор заказов выключен: установите BOT_AUTO_ORDERS=1.');return;}
    const managerId=this.db.getGeneratorManagerId();
    if(!managerId){this.log.warn?.('Автогенератор: не найден активный менеджер. Укажите BOT_ADMIN_IDS или войдите менеджером в бот.');return;}

    const workerRegions=this.db.listAutoOrderRegions();
    if(!workerRegions.length){
      this.log.warn?.('Автогенератор: нет пользователей с назначенным регионом; создавать заказы не для чего.');
      return;
    }
    for(const region of workerRegions){
      let active=this.db.countActiveGeneratedOrders(region);

      if(!this.seededRegions.has(region)){
        const startupMax=Math.min(7,this.maxActive);
        const startupTarget=this.startupTargets.get(region)??randomInt(3,startupMax);
        this.startupTargets.set(region,startupTarget);
        const missing=Math.max(0,startupTarget-active);
        for(let i=0;i<missing;i++){
          const order=await this.createOrder(region,managerId);
          if(!order)break;
          active++;
          await this.app.publishGeneratedOrder(order);
          this.log.log?.(`Стартовый автозаказ №${order.id} создан: ${order.city}${order.urgent?' (срочный)':''}`);
        }
        if(active>=startupTarget)this.seededRegions.add(region);
        continue;
      }

      if(active<this.maxActive&&Math.random()<this.ordersPerHour/60){
        const order=await this.createOrder(region,managerId);
        if(!order)continue;
        await this.app.publishGeneratedOrder(order);
        this.log.log?.(`Автозаказ №${order.id} создан: ${order.city}${order.urgent?' (срочный)':''}`);
      }
    }

    for(const order of this.db.listActiveGeneratedOrders('',100)){
      await this.advance(order,managerId);
    }
  }

  async createOrder(region,managerId){
    const urgent=Math.random()<this.urgentChance;
    const template=randomFrom(TEMPLATES);
    const durationHours=randomInt(template.duration[0],template.duration[1]);
    const peopleNeeded=randomInt(template.people[0],template.people[1]);
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
      description:template.description,
      urgent,
      simulatedAssigned,
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
      this.db.updateGeneratedOrderDynamics(order.id,{ipRate,simulatedAssigned});
      await this.app.refreshOrderMessages(order.id);
    }
  }
}
