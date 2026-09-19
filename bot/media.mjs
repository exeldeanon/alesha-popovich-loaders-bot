import {fileURLToPath} from 'node:url';

// Each semantic section gets its own labeled illustration. Individual list
// items stay text-only so the feed remains quick to scan.
export const VISUALS = Object.freeze({
  welcome: fileURLToPath(new URL('./assets/welcome-loader.jpg', import.meta.url)),
  orders: fileURLToPath(new URL('./assets/active-orders.png', import.meta.url)),
  work: fileURLToPath(new URL('./assets/shifts.png', import.meta.url)),
  cabinet: fileURLToPath(new URL('./assets/cabinet.png', import.meta.url)),
  settings: fileURLToPath(new URL('./assets/settings.png', import.meta.url)),
  manager: fileURLToPath(new URL('./assets/manager.png', import.meta.url)),
});

export const visualPath=(name)=>VISUALS[name]||VISUALS.welcome;
