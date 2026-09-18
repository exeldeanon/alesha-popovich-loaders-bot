import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const now=()=>new Date().toISOString();
const num=value=>Number(value);

export class BotDatabase {
  constructor(filename=':memory:'){
    if(filename===':memory:'){
      this.filename=filename;
      this.db=new DatabaseSync(filename);
    }else{
      const candidates=[filename,path.resolve('data/bot.sqlite'),path.join(os.tmpdir(),'alesha-popovich-bot.sqlite')]
        .map(candidate=>path.resolve(candidate))
        .filter((candidate,index,list)=>list.indexOf(candidate)===index);
      const errors=[];
      for(const candidate of candidates){
        try{
          const directory=path.dirname(candidate);
          fs.mkdirSync(directory,{recursive:true});
          fs.accessSync(directory,fs.constants.W_OK);
          this.db=new DatabaseSync(candidate);
          this.filename=candidate;
          break;
        }catch(error){
          errors.push(new Error(`${candidate}: ${error.message}`,{cause:error}));
        }
      }
      if(!this.db)throw new AggregateError(errors,'Не удалось открыть SQLite ни в одном доступном каталоге.');
      if(this.filename!==path.resolve(filename))console.warn(`Каталог базы ${filename} недоступен. Используется ${this.filename}`);
    }
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  migrate(){
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users(
        telegram_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT NOT NULL DEFAULT '',
        last_name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'worker' CHECK(role IN ('worker','manager')),
        status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','pending','active','blocked')),
        city TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        notifications INTEGER NOT NULL DEFAULT 1 CHECK(notifications IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS access_requests(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(telegram_id),
        name TEXT NOT NULL,
        city TEXT NOT NULL,
        phone TEXT NOT NULL,
        experience TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT REFERENCES users(telegram_id)
      );
      CREATE INDEX IF NOT EXISTS idx_access_status ON access_requests(status,created_at);
      CREATE TABLE IF NOT EXISTS verification_requests(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(telegram_id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT REFERENCES users(telegram_id)
      );
      CREATE INDEX IF NOT EXISTS idx_verification_status ON verification_requests(status,created_at);
      CREATE TABLE IF NOT EXISTS orders(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        city TEXT NOT NULL,
        address TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        duration_hours REAL NOT NULL CHECK(duration_hours>0),
        people_needed INTEGER NOT NULL CHECK(people_needed>0),
        amount INTEGER NOT NULL CHECK(amount>=0),
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','filled','closed','cancelled')),
        created_by TEXT NOT NULL REFERENCES users(telegram_id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_orders_status_start ON orders(status,starts_at);
      CREATE TABLE IF NOT EXISTS applications(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(telegram_id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','withdrawn')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(order_id,user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status,created_at);
      CREATE TABLE IF NOT EXISTS shifts(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        user_id TEXT NOT NULL REFERENCES users(telegram_id),
        status TEXT NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned','in_progress','pending_confirmation','completed','cancelled')),
        started_at TEXT,
        finished_at TEXT,
        hours REAL,
        amount INTEGER,
        notes TEXT NOT NULL DEFAULT '',
        completed_at TEXT,
        confirmed_by TEXT REFERENCES users(telegram_id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(order_id,user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_shifts_user_status ON shifts(user_id,status);
      CREATE TABLE IF NOT EXISTS withdrawals(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(telegram_id),
        amount INTEGER NOT NULL CHECK(amount>0),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','declined')),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT REFERENCES users(telegram_id)
      );
      CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status,created_at);
      CREATE TABLE IF NOT EXISTS sessions(
        user_id TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
        flow TEXT NOT NULL,
        step TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications_sent(
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY(kind,entity_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS audit_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);
    const addColumn=(table,column,definition)=>{
      const cols=this.db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);
      if(!cols.includes(column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    addColumn('users','region',"TEXT NOT NULL DEFAULT ''");
    addColumn('users','contractor_type',"TEXT NOT NULL DEFAULT 'self_employed' CHECK(contractor_type IN ('self_employed','ip'))");
    addColumn('users','verified',"INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1))");
    this.db.prepare("UPDATE users SET verified=1 WHERE status='active' AND (role='manager' OR (role='worker' AND region<>''))").run();
    addColumn('orders','region',"TEXT NOT NULL DEFAULT ''");
    addColumn('orders','self_employed_rate',"INTEGER NOT NULL DEFAULT 450");
    addColumn('orders','ip_rate',"INTEGER NOT NULL DEFAULT 550");
    addColumn('orders','generated',"INTEGER NOT NULL DEFAULT 0");
    addColumn('orders','urgent',"INTEGER NOT NULL DEFAULT 0");
    addColumn('orders','simulated_assigned',"INTEGER NOT NULL DEFAULT 0");
    addColumn('shifts','planned_amount',"INTEGER");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS order_messages(
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(order_id,user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_users_region ON users(region,status,role);
      CREATE INDEX IF NOT EXISTS idx_orders_region_status ON orders(region,status,starts_at);
      CREATE TABLE IF NOT EXISTS region_geo(
        region_key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        south REAL NOT NULL,
        west REAL NOT NULL,
        north REAL NOT NULL,
        east REAL NOT NULL,
        osm_type TEXT NOT NULL DEFAULT '',
        osm_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS region_addresses(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        region_key TEXT NOT NULL,
        region_label TEXT NOT NULL,
        address TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(region_key,address)
      );
      CREATE INDEX IF NOT EXISTS idx_region_addresses_key ON region_addresses(region_key,use_count,last_used_at);
    `);
  }

  close(){this.db.close();}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  audit(actorId,action,entityType,entityId,details={}){this.db.prepare('INSERT INTO audit_log(actor_id,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run(actorId?String(actorId):null,action,entityType,String(entityId),JSON.stringify(details),now());}

  upsertUser(from){
    const id=String(from.id), stamp=now();
    this.db.prepare(`INSERT INTO users(telegram_id,username,first_name,last_name,created_at,updated_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at`)
      .run(id,from.username||null,from.first_name||'',from.last_name||'',stamp,stamp,stamp);
    return this.getUser(id);
  }
  ensureManager(id){
    const key=String(id),stamp=now();
    this.db.prepare(`INSERT INTO users(telegram_id,role,status,created_at,updated_at,last_seen_at) VALUES(?,'manager','active',?,?,?)
      ON CONFLICT(telegram_id) DO UPDATE SET role='manager',status='active',updated_at=excluded.updated_at`).run(key,stamp,stamp,stamp);
  }
  getUser(id){return this.db.prepare('SELECT * FROM users WHERE telegram_id=?').get(String(id));}
  listActiveWorkers(){return this.db.prepare("SELECT * FROM users WHERE role='worker' AND status='active' AND verified=1 AND notifications=1 ORDER BY created_at").all();}
  listActiveWorkersByRegion(region){return this.db.prepare("SELECT * FROM users WHERE role='worker' AND status='active' AND verified=1 AND notifications=1 AND region=? ORDER BY created_at").all(String(region||''));}
  listActiveWorkerRegions(){return this.db.prepare("SELECT DISTINCT region FROM users WHERE role='worker' AND status='active' AND verified=1 AND region<>'' ORDER BY region").all().map(row=>row.region);}
  listWorkers(limit=50){return this.db.prepare("SELECT * FROM users WHERE role='worker' AND status='active' AND verified=1 ORDER BY first_name,last_name,created_at LIMIT ?").all(limit);}
  updateWorkerProfile(userId,{region,contractorType}){const user=this.getUser(userId);if(!user)return null;const nextRegion=region===undefined?user.region:String(region||'');const nextType=contractorType===undefined?user.contractor_type:String(contractorType);if(!['self_employed','ip'].includes(nextType))throw Error('Invalid contractor type');this.db.prepare("UPDATE users SET region=?,contractor_type=?,updated_at=? WHERE telegram_id=?").run(nextRegion,nextType,now(),String(userId));this.audit(null,'worker.profile','user',userId,{region:nextRegion,contractorType:nextType});return this.getUser(userId);}
  verifyWorker(userId,managerId,{region,contractorType}){if(!region||!['self_employed','ip'].includes(contractorType))return null;this.db.prepare("UPDATE users SET status='active',role='worker',verified=1,region=?,contractor_type=?,updated_at=? WHERE telegram_id=?").run(String(region),String(contractorType),now(),String(userId));this.audit(managerId,'worker.verify','user',userId,{region,contractorType});return this.getUser(userId);}
  listManagers(){return this.db.prepare("SELECT * FROM users WHERE role='manager' AND status='active'").all();}
  getGeneratorManagerId(){return this.listManagers()[0]?.telegram_id||null;}
  toggleNotifications(id){this.db.prepare('UPDATE users SET notifications=1-notifications,updated_at=? WHERE telegram_id=?').run(now(),String(id));return this.getUser(id);}

  createAccessRequest(userId,{name,city,experience}){
    return this.transaction(()=>{
      this.db.prepare("UPDATE access_requests SET status='declined',decided_at=? WHERE user_id=? AND status='pending'").run(now(),String(userId));
      const result=this.db.prepare('INSERT INTO access_requests(user_id,name,city,phone,experience,created_at) VALUES(?,?,?,?,?,?)').run(String(userId),name,city,'',experience||'',now());
      this.db.prepare("UPDATE users SET status='pending',verified=0,region='',city=?,phone='',updated_at=? WHERE telegram_id=?").run(city,now(),String(userId));
      this.audit(userId,'access.request','access_request',result.lastInsertRowid,{city});
      return num(result.lastInsertRowid);
    });
  }
  getAccessRequest(id){return this.db.prepare('SELECT ar.*,u.username,u.first_name FROM access_requests ar JOIN users u ON u.telegram_id=ar.user_id WHERE ar.id=?').get(id);}
  listPendingAccess(limit=20){return this.db.prepare("SELECT ar.*,u.username,u.first_name FROM access_requests ar JOIN users u ON u.telegram_id=ar.user_id WHERE ar.status='pending' ORDER BY ar.created_at LIMIT ?").all(limit);}
  decideAccess(id,managerId,approved){
    return this.transaction(()=>{
      const request=this.getAccessRequest(id);if(!request||request.status!=='pending')return null;
      const status=approved?'approved':'declined';
      this.db.prepare('UPDATE access_requests SET status=?,decided_at=?,decided_by=? WHERE id=?').run(status,now(),String(managerId),id);
      this.db.prepare("UPDATE users SET status=?,role='worker',verified=0,region='',updated_at=? WHERE telegram_id=?").run(approved?'active':'new',now(),request.user_id);
      this.audit(managerId,`access.${status}`,'access_request',id,{userId:request.user_id});
      return {...request,status};
    });
  }

  createVerificationRequest(userId){
    const user=this.getUser(userId);
    if(!user||user.role!=='worker'||user.status!=='active')return {error:'access'};
    if(user.verified===1)return {error:'verified'};
    const pending=this.db.prepare("SELECT * FROM verification_requests WHERE user_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(String(userId));
    if(pending)return {error:'pending',request:this.getVerificationRequest(pending.id)};
    const result=this.db.prepare("INSERT INTO verification_requests(user_id,status,created_at) VALUES(?,'pending',?)").run(String(userId),now());
    const id=num(result.lastInsertRowid);this.audit(userId,'verification.request','verification_request',id);
    return {request:this.getVerificationRequest(id)};
  }
  getVerificationRequest(id){return this.db.prepare('SELECT vr.*,u.username,u.first_name,u.last_name,u.city FROM verification_requests vr JOIN users u ON u.telegram_id=vr.user_id WHERE vr.id=?').get(id);}
  listPendingVerifications(limit=20){return this.db.prepare("SELECT vr.*,u.username,u.first_name,u.last_name,u.city FROM verification_requests vr JOIN users u ON u.telegram_id=vr.user_id WHERE vr.status='pending' ORDER BY vr.created_at LIMIT ?").all(limit);}
  declineVerification(id,managerId){
    return this.transaction(()=>{
      const request=this.getVerificationRequest(id);if(!request||request.status!=='pending')return null;
      this.db.prepare("UPDATE verification_requests SET status='declined',decided_at=?,decided_by=? WHERE id=?").run(now(),String(managerId),id);
      this.audit(managerId,'verification.declined','verification_request',id,{userId:request.user_id});
      return {...request,status:'declined'};
    });
  }
  completeVerification(id,managerId,{region,contractorType}){
    if(!region||!['self_employed','ip'].includes(contractorType))return null;
    return this.transaction(()=>{
      const request=this.getVerificationRequest(id);if(!request||request.status!=='pending')return null;
      this.db.prepare("UPDATE verification_requests SET status='approved',decided_at=?,decided_by=? WHERE id=?").run(now(),String(managerId),id);
      this.db.prepare("UPDATE users SET verified=1,region=?,contractor_type=?,updated_at=? WHERE telegram_id=? AND status='active' AND role='worker'").run(String(region),String(contractorType),now(),request.user_id);
      this.audit(managerId,'verification.approved','verification_request',id,{userId:request.user_id,region,contractorType});
      return {...request,status:'approved',region,contractor_type:contractorType};
    });
  }

  createOrder(data,managerId){
    const stamp=now(),duration=Number(data.durationHours)||1;
    const selfRate=Number(data.selfEmployedRate)||Math.max(1,Math.round((Number(data.amount)||0)/duration))||450;
    const ipRate=Math.max(550,Number(data.ipRate)||selfRate+100);
    const result=this.db.prepare(`INSERT INTO orders(title,city,address,starts_at,duration_hours,people_needed,amount,description,status,created_by,created_at,updated_at,region,self_employed_rate,ip_rate,generated,urgent,simulated_assigned)
      VALUES(?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,0,0,0)`).run(data.title,data.city,data.address,data.startsAt,duration,data.peopleNeeded,data.amount,data.description||'',String(managerId),stamp,stamp,data.region||'',selfRate,ipRate);
    const id=num(result.lastInsertRowid);this.audit(managerId,'order.create','order',id,data);return this.getOrder(id);
  }
  createGeneratedOrder(data,managerId){
    const stamp=now();
    const result=this.db.prepare(`INSERT INTO orders(title,city,address,starts_at,duration_hours,people_needed,amount,description,status,created_by,created_at,updated_at,region,self_employed_rate,ip_rate,generated,urgent,simulated_assigned)
      VALUES(?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,1,?,?)`).run(data.title,data.city,data.address,data.startsAt,data.durationHours,data.peopleNeeded,data.amount,data.description||'',String(managerId),stamp,stamp,data.region||'',data.selfEmployedRate||450,Math.max(550,data.ipRate||550),data.urgent?1:0,Math.max(0,data.simulatedAssigned||0));
    const id=num(result.lastInsertRowid);this.audit(managerId,'order.generated','order',id,data);return this.getOrder(id);
  }
  getOrder(id){return this.db.prepare(`SELECT o.*,(SELECT COUNT(*) FROM shifts s WHERE s.order_id=o.id AND s.status NOT IN ('cancelled')) AS assigned_count FROM orders o WHERE o.id=?`).get(id);}
  listActiveOrders({city='',region='',limit=20}={}){
    if(region)return this.db.prepare(`SELECT o.*,(SELECT COUNT(*) FROM shifts s WHERE s.order_id=o.id AND s.status NOT IN ('cancelled')) AS assigned_count FROM orders o WHERE o.status='active' AND o.region=? ORDER BY o.starts_at LIMIT ?`).all(region,limit);
    if(city)return this.db.prepare(`SELECT o.*,(SELECT COUNT(*) FROM shifts s WHERE s.order_id=o.id AND s.status NOT IN ('cancelled')) AS assigned_count FROM orders o WHERE o.status='active' AND lower(o.city)=lower(?) ORDER BY o.starts_at LIMIT ?`).all(city,limit);
    return this.db.prepare(`SELECT o.*,(SELECT COUNT(*) FROM shifts s WHERE s.order_id=o.id AND s.status NOT IN ('cancelled')) AS assigned_count FROM orders o WHERE o.status='active' ORDER BY o.starts_at LIMIT ?`).all(limit);
  }
  listActiveGeneratedOrders(region='',limit=100){if(region)return this.db.prepare(`SELECT o.*,(SELECT COUNT(*) FROM shifts s WHERE s.order_id=o.id AND s.status NOT IN ('cancelled')) AS assigned_count FROM orders o WHERE o.generated=1 AND o.status='active' AND o.region=? ORDER BY o.starts_at LIMIT ?`).all(region,limit);return this.db.prepare(`SELECT o.*,(SELECT COUNT(*) FROM shifts s WHERE s.order_id=o.id AND s.status NOT IN ('cancelled')) AS assigned_count FROM orders o WHERE o.generated=1 AND o.status='active' ORDER BY o.starts_at LIMIT ?`).all(limit);}
  countActiveGeneratedOrders(region){return num(this.db.prepare("SELECT COUNT(*) count FROM orders WHERE generated=1 AND status='active' AND region=?").get(String(region||'')).count);}
  updateGeneratedOrderDynamics(id,{ipRate,simulatedAssigned}){this.db.prepare("UPDATE orders SET ip_rate=?,simulated_assigned=?,updated_at=? WHERE id=? AND generated=1").run(Math.max(550,Number(ipRate)||550),Math.max(0,Number(simulatedAssigned)||0),now(),id);return this.getOrder(id);}
  listManagedOrders(limit=20){return this.db.prepare(`SELECT o.*,(SELECT COUNT(*) FROM applications a WHERE a.order_id=o.id AND a.status='pending') AS pending_count,(SELECT COUNT(*) FROM shifts s WHERE s.order_id=o.id AND s.status NOT IN ('cancelled')) AS assigned_count FROM orders o WHERE o.status IN ('active','filled') ORDER BY o.starts_at LIMIT ?`).all(limit);}
  setOrderStatus(id,status,managerId){
    const allowed=['active','filled','closed','cancelled'];if(!allowed.includes(status))throw Error('Invalid order status');
    return this.transaction(()=>{const order=this.getOrder(id);if(!order)return null;this.db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(status,now(),id);if(status==='cancelled')this.db.prepare("UPDATE shifts SET status='cancelled',updated_at=? WHERE order_id=? AND status NOT IN ('completed','cancelled')").run(now(),id);this.audit(managerId,`order.${status}`,'order',id);return this.getOrder(id);});
  }

  applyToOrder(orderId,userId){
    const order=this.getOrder(orderId);if(!order||order.status!=='active')return {error:'closed'};
    const user=this.getUser(userId);if(!user||user.status!=='active'||user.role!=='worker'||user.verified!==1||!user.region)return {error:'access'};
    try{const stamp=now();const result=this.db.prepare("INSERT INTO applications(order_id,user_id,status,created_at,updated_at) VALUES(?,?,'pending',?,?)").run(orderId,String(userId),stamp,stamp);const id=num(result.lastInsertRowid);this.audit(userId,'application.create','application',id,{orderId});return {application:this.getApplication(id)};}catch(error){if(String(error).includes('UNIQUE'))return {error:'duplicate'};throw error;}
  }
  getApplication(id){return this.db.prepare(`SELECT a.*,o.title,o.city,o.address,o.starts_at,o.duration_hours,o.amount,o.people_needed,u.username,u.first_name,u.last_name,u.phone FROM applications a JOIN orders o ON o.id=a.order_id JOIN users u ON u.telegram_id=a.user_id WHERE a.id=?`).get(id);}
  listPendingApplications(limit=30){return this.db.prepare(`SELECT a.*,o.title,o.city,o.starts_at,o.amount,u.username,u.first_name,u.last_name,u.phone FROM applications a JOIN orders o ON o.id=a.order_id JOIN users u ON u.telegram_id=a.user_id WHERE a.status='pending' ORDER BY a.created_at LIMIT ?`).all(limit);}
  listUserApplications(userId,limit=20){return this.db.prepare(`SELECT a.*,o.title,o.city,o.starts_at,o.amount FROM applications a JOIN orders o ON o.id=a.order_id WHERE a.user_id=? ORDER BY a.created_at DESC LIMIT ?`).all(String(userId),limit);}
  withdrawApplication(id,userId){const app=this.getApplication(id);if(!app||app.user_id!==String(userId)||app.status!=='pending')return null;this.db.prepare("UPDATE applications SET status='withdrawn',updated_at=? WHERE id=?").run(now(),id);this.audit(userId,'application.withdraw','application',id);return this.getApplication(id);}
  decideApplication(id,managerId,approved){
    return this.transaction(()=>{
      const app=this.getApplication(id);if(!app||app.status!=='pending')return null;
      if(approved){
        const worker=this.getUser(app.user_id);if(!worker||worker.role!=='worker'||worker.status!=='active'||worker.verified!==1||!worker.region)return {error:'access',...app};
        const order=this.getOrder(app.order_id);if(!order||order.status!=='active'||Number(order.assigned_count)>=Number(order.people_needed))return {error:'full',...app};
      }
      const status=approved?'approved':'declined';this.db.prepare('UPDATE applications SET status=?,updated_at=? WHERE id=?').run(status,now(),id);
      let shift=null;
      if(approved){const stamp=now();const orderBefore=this.getOrder(app.order_id);const worker=this.getUser(app.user_id);const rate=worker?.contractor_type==='ip'?Math.max(550,Number(orderBefore.ip_rate)||550):(Number(orderBefore.self_employed_rate)||450);const plannedAmount=Math.round(rate*Number(orderBefore.duration_hours));const result=this.db.prepare("INSERT INTO shifts(order_id,user_id,status,planned_amount,created_at,updated_at) VALUES(?,?,'assigned',?,?,?)").run(app.order_id,app.user_id,plannedAmount,stamp,stamp);if(Number(orderBefore.simulated_assigned)>0)this.db.prepare("UPDATE orders SET simulated_assigned=simulated_assigned-1,updated_at=? WHERE id=?").run(now(),app.order_id);shift=this.getShift(num(result.lastInsertRowid));const order=this.getOrder(app.order_id);if(Number(order.assigned_count)>=order.people_needed)this.db.prepare("UPDATE orders SET status='filled',updated_at=? WHERE id=?").run(now(),app.order_id);}
      this.audit(managerId,`application.${status}`,'application',id,{userId:app.user_id,orderId:app.order_id});return {...app,status,shift};
    });
  }

  getShift(id){return this.db.prepare(`SELECT s.*,o.title,o.city,o.address,o.starts_at,o.duration_hours,COALESCE(s.planned_amount,o.amount) AS planned_amount FROM shifts s JOIN orders o ON o.id=s.order_id WHERE s.id=?`).get(id);}
  listOrderShifts(orderId){return this.db.prepare(`SELECT s.*,o.title,o.city,o.address,o.starts_at,o.duration_hours,COALESCE(s.planned_amount,o.amount) AS planned_amount FROM shifts s JOIN orders o ON o.id=s.order_id WHERE s.order_id=? AND s.status NOT IN ('completed','cancelled')`).all(orderId);}
  listUserShifts(userId,{history=false,limit=20}={}){const statuses=history?"('completed','cancelled')":"('assigned','in_progress','pending_confirmation')";return this.db.prepare(`SELECT s.*,o.title,o.city,o.address,o.starts_at,o.duration_hours,COALESCE(s.planned_amount,o.amount) AS planned_amount FROM shifts s JOIN orders o ON o.id=s.order_id WHERE s.user_id=? AND s.status IN ${statuses} ORDER BY o.starts_at ${history?'DESC':'ASC'} LIMIT ?`).all(String(userId),limit);}
  listPendingShiftConfirmations(limit=30){return this.db.prepare(`SELECT s.*,o.title,o.city,o.starts_at,COALESCE(s.planned_amount,o.amount) AS planned_amount,o.duration_hours,u.username,u.first_name,u.last_name FROM shifts s JOIN orders o ON o.id=s.order_id JOIN users u ON u.telegram_id=s.user_id WHERE s.status='pending_confirmation' ORDER BY s.finished_at LIMIT ?`).all(limit);}
  startShift(id,userId){const shift=this.getShift(id);if(!shift||shift.user_id!==String(userId)||shift.status!=='assigned')return null;this.db.prepare("UPDATE shifts SET status='in_progress',started_at=?,updated_at=? WHERE id=?").run(now(),now(),id);this.audit(userId,'shift.start','shift',id);return this.getShift(id);}
  finishShift(id,userId){const shift=this.getShift(id);if(!shift||shift.user_id!==String(userId)||shift.status!=='in_progress')return null;this.db.prepare("UPDATE shifts SET status='pending_confirmation',finished_at=?,updated_at=? WHERE id=?").run(now(),now(),id);this.audit(userId,'shift.finish','shift',id);return this.getShift(id);}
  completeShift(id,managerId,{hours,amount,notes=''}){const shift=this.getShift(id);if(!shift||shift.status!=='pending_confirmation')return null;this.db.prepare("UPDATE shifts SET status='completed',hours=?,amount=?,notes=?,completed_at=?,confirmed_by=?,updated_at=? WHERE id=?").run(hours,amount,notes,now(),String(managerId),now(),id);this.audit(managerId,'shift.complete','shift',id,{hours,amount});return this.getShift(id);}

  getCabinet(userId){
    const earnings=this.db.prepare("SELECT COUNT(*) shifts,COALESCE(SUM(amount),0) earned,COALESCE(SUM(hours),0) hours FROM shifts WHERE user_id=? AND status='completed'").get(String(userId));
    const withdrawals=this.db.prepare("SELECT COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) paid,COALESCE(SUM(CASE WHEN status='pending' THEN amount ELSE 0 END),0) pending FROM withdrawals WHERE user_id=?").get(String(userId));
    const upcoming=this.db.prepare("SELECT COUNT(*) count FROM shifts WHERE user_id=? AND status IN ('assigned','in_progress','pending_confirmation')").get(String(userId));
    return {shifts:num(earnings.shifts),earned:num(earnings.earned),hours:num(earnings.hours),paid:num(withdrawals.paid),pending:num(withdrawals.pending),available:Math.max(0,num(earnings.earned)-num(withdrawals.paid)-num(withdrawals.pending)),upcoming:num(upcoming.count)};
  }
  createWithdrawal(userId,amount){const cabinet=this.getCabinet(userId);if(!Number.isInteger(amount)||amount<=0||amount>cabinet.available)return {error:'amount',cabinet};const result=this.db.prepare("INSERT INTO withdrawals(user_id,amount,status,created_at) VALUES(?,?,'pending',?)").run(String(userId),amount,now());const id=num(result.lastInsertRowid);this.audit(userId,'withdrawal.create','withdrawal',id,{amount});return {withdrawal:this.getWithdrawal(id)};}
  getWithdrawal(id){return this.db.prepare(`SELECT w.*,u.username,u.first_name,u.last_name,u.phone FROM withdrawals w JOIN users u ON u.telegram_id=w.user_id WHERE w.id=?`).get(id);}
  listPendingWithdrawals(limit=30){return this.db.prepare(`SELECT w.*,u.username,u.first_name,u.last_name,u.phone FROM withdrawals w JOIN users u ON u.telegram_id=w.user_id WHERE w.status='pending' ORDER BY w.created_at LIMIT ?`).all(limit);}
  listOrderApplications(orderId,limit=30){return this.db.prepare(`SELECT a.*,o.title,o.city,o.starts_at,o.amount,u.username,u.first_name,u.last_name,u.phone FROM applications a JOIN orders o ON o.id=a.order_id JOIN users u ON u.telegram_id=a.user_id WHERE a.order_id=? AND a.status='pending' ORDER BY a.created_at LIMIT ?`).all(orderId,limit);}
  decideWithdrawal(id,managerId,paid){const item=this.getWithdrawal(id);if(!item||item.status!=='pending')return null;const status=paid?'paid':'declined';this.db.prepare('UPDATE withdrawals SET status=?,decided_at=?,decided_by=? WHERE id=?').run(status,now(),String(managerId),id);this.audit(managerId,`withdrawal.${status}`,'withdrawal',id,{amount:item.amount});return {...item,status};}

  getRegionGeo(regionKey){return this.db.prepare("SELECT * FROM region_geo WHERE region_key=?").get(String(regionKey));}
  saveRegionGeo(item){this.db.prepare(`INSERT INTO region_geo(region_key,label,south,west,north,east,osm_type,osm_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(region_key) DO UPDATE SET label=excluded.label,south=excluded.south,west=excluded.west,north=excluded.north,east=excluded.east,osm_type=excluded.osm_type,osm_id=excluded.osm_id,updated_at=excluded.updated_at`).run(item.region_key,item.label,item.south,item.west,item.north,item.east,item.osm_type||'',item.osm_id||'',item.updated_at||now());}
  saveRegionAddresses(regionKey,regionLabel,addresses){const stmt=this.db.prepare("INSERT OR IGNORE INTO region_addresses(region_key,region_label,address,created_at) VALUES(?,?,?,?)");const stamp=now();this.transaction(()=>{for(const address of new Set(addresses))stmt.run(String(regionKey),String(regionLabel),String(address),stamp);});}
  countRegionAddresses(regionKey){return num(this.db.prepare("SELECT COUNT(*) count FROM region_addresses WHERE region_key=?").get(String(regionKey)).count);}
  randomRegionAddress(regionKey){return this.db.prepare("SELECT * FROM region_addresses WHERE region_key=? ORDER BY use_count ASC,RANDOM() LIMIT 1").get(String(regionKey));}
  markRegionAddressUsed(id){this.db.prepare("UPDATE region_addresses SET use_count=use_count+1,last_used_at=? WHERE id=?").run(now(),id);}
  saveOrderMessage(orderId,userId,messageId){this.db.prepare(`INSERT INTO order_messages(order_id,user_id,message_id,created_at) VALUES(?,?,?,?) ON CONFLICT(order_id,user_id) DO UPDATE SET message_id=excluded.message_id,created_at=excluded.created_at`).run(orderId,String(userId),messageId,now());}
  listOrderMessages(orderId){return this.db.prepare("SELECT * FROM order_messages WHERE order_id=?").all(orderId);}
  getSession(userId){const row=this.db.prepare('SELECT * FROM sessions WHERE user_id=?').get(String(userId));return row?{...row,data:JSON.parse(row.data)}:null;}
  setSession(userId,flow,step,data={}){this.db.prepare(`INSERT INTO sessions(user_id,flow,step,data,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET flow=excluded.flow,step=excluded.step,data=excluded.data,updated_at=excluded.updated_at`).run(String(userId),flow,step,JSON.stringify(data),now());}
  clearSession(userId){this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(String(userId));}
  setting(key,fallback=null){return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value??fallback;}
  setSetting(key,value){this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));}
  markNotification(kind,entityId,userId){try{this.db.prepare('INSERT INTO notifications_sent(kind,entity_id,user_id,sent_at) VALUES(?,?,?,?)').run(kind,String(entityId),String(userId),now());return true;}catch(error){if(String(error).includes('UNIQUE'))return false;throw error;}}
  remindersDue(beforeIso){return this.db.prepare(`SELECT s.id,s.user_id,o.title,o.city,o.address,o.starts_at FROM shifts s JOIN orders o ON o.id=s.order_id LEFT JOIN notifications_sent n ON n.kind='shift_reminder' AND n.entity_id=CAST(s.id AS TEXT) AND n.user_id=s.user_id WHERE s.status='assigned' AND o.starts_at>? AND o.starts_at<=? AND n.entity_id IS NULL ORDER BY o.starts_at`).all(now(),beforeIso);}
  stats(){return {workers:num(this.db.prepare("SELECT COUNT(*) count FROM users WHERE role='worker' AND status='active' AND verified=1").get().count),activeOrders:num(this.db.prepare("SELECT COUNT(*) count FROM orders WHERE status IN ('active','filled')").get().count),pendingAccess:num(this.db.prepare("SELECT COUNT(*) count FROM access_requests WHERE status='pending'").get().count),pendingVerification:num(this.db.prepare("SELECT COUNT(*) count FROM verification_requests WHERE status='pending'").get().count),pendingApplications:num(this.db.prepare("SELECT COUNT(*) count FROM applications WHERE status='pending'").get().count),pendingShifts:num(this.db.prepare("SELECT COUNT(*) count FROM shifts WHERE status='pending_confirmation'").get().count),pendingWithdrawals:num(this.db.prepare("SELECT COUNT(*) count FROM withdrawals WHERE status='pending'").get().count),paidTotal:num(this.db.prepare("SELECT COALESCE(SUM(amount),0) total FROM withdrawals WHERE status='paid'").get().total)};}
}
